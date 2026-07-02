"""
asr_engine.py
=============
Electron 主程序透過 child_process 啟動本檔，使用「一行一個 JSON」的協定溝通
（stdin 收指令、stdout 回事件）。本地執行 openai-whisper，完全離線。

── 從 Electron 收到的指令（stdin, 每行一個 JSON）──
  {"cmd":"list_devices"}
  {"cmd":"load_model","model":"small"}
  {"cmd":"start","device":<index>,"backend":"auto","model":"small","task":"transcribe","language":null}
  {"cmd":"stop"}
  {"cmd":"ping"}

── 回傳給 Electron 的事件（stdout, 每行一個 JSON）──
  {"type":"ready","backends":{...}}
  {"type":"devices","devices":[...]}
  {"type":"model_loading","model":"small"}
  {"type":"model_ready","model":"small","device":"cpu"}
  {"type":"volume","level":0.0~1.0}
  {"type":"status","state":"listening|recognizing|stopped|reconnecting"}
  {"type":"segment","text":"...","lang":"en","start_ts":<ms>,"end_ts":<ms>}
  {"type":"error","where":"...","message":"..."}
  {"type":"pong"}

分句策略：能量門檻 VAD — 偵測到語音後，若靜音持續 > SILENCE_SEC 視為句子結束，
送入 Whisper 辨識；或語音長度達 MAX_SEG_SEC 強制切斷。
"""

import sys
import os
import json
import time
import threading
import queue
import argparse

import numpy as np

# Windows 上 stdout 預設常為 cp950/cp932，會讓 CJK 文字變亂碼。
# 強制 UTF-8，並在 emit() 以 ensure_ascii 逃逸做雙重保險。
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import audio_capture  # noqa: E402

SAMPLE_RATE = 16000
SILENCE_SEC = 0.5        # 靜音超過此秒數 → 視為句子結束（越小越快翻譯，太小易切碎）
MAX_SEG_SEC = 15.0       # 單句最長，避免無限累積
MIN_SEG_SEC = 0.4        # 太短的片段忽略（雜訊）
VOLUME_EMIT_INTERVAL = 0.12   # 音量回報間隔（秒）

# 能量門檻（RMS）。低於此視為靜音。會依環境自動調整下限。
BASE_SILENCE_RMS = 0.006

# Silero VAD（人聲偵測）
VAD_FRAME = 512          # 每次輸入樣本數（16kHz 規定為 512）
VAD_PREROLL_FRAMES = 8   # 語音起始前保留 ~256ms，避免切掉字頭


def emit(obj: dict):
    """輸出一行 JSON 事件到 stdout，並立即 flush。
    ensure_ascii=True 會把非 ASCII 字元轉為 \\uXXXX，純 ASCII 位元組跨任何
    Windows 代碼頁都不會亂碼，Node 端 JSON.parse 會還原為正確 Unicode。"""
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


class ASREngine:
    def __init__(self):
        self.model = None
        self.model_name = None
        self.model_device = "cpu"
        self.capture = None
        self.running = False

        self.task = "transcribe"
        self.language = None
        # 偵測模式：auto=自動判斷 日/英；ja=一律日文；en=一律英文
        self.detect_mode = "auto"

        # 日文微調模型（HuggingFace transformers）與假名注音，延遲載入
        self.ja_pipe = None
        self._kks = None

        # Silero VAD 人聲偵測（延遲載入；失敗則回退能量 VAD）
        self.vad_model = None
        self.vad_iterator = None
        self._vad_tried = False

        # 音訊緩衝與 VAD 狀態
        self._audio_q = queue.Queue()
        self._worker = None
        self._buf = []               # 累積中的語音片段
        self._buf_samples = 0
        self._silence_run = 0.0      # 連續靜音秒數
        self._in_speech = False
        self._seg_start_ts = 0.0
        self._last_volume_emit = 0.0
        self._noise_floor = BASE_SILENCE_RMS

    # ---------------- 模型 ----------------
    def load_model(self, name: str):
        if self.model is not None and self.model_name == name:
            emit({"type": "model_ready", "model": name, "device": self.model_device})
            return
        emit({"type": "model_loading", "model": name})
        try:
            import whisper  # 延遲載入，加快啟動與 list_devices
            try:
                import torch
                self.model_device = "cuda" if torch.cuda.is_available() else "cpu"
            except Exception:
                self.model_device = "cpu"
            # 明確指定裝置：有 CUDA 就載到 GPU（使用 GPU VRAM）
            self.model = whisper.load_model(name, device=self.model_device)
            self.model_name = name
            emit({"type": "model_ready", "model": name, "device": self.model_device})
        except Exception as e:
            emit({"type": "error", "where": "load_model", "message": str(e)})

    # ---------------- 語言路由：僅支援 日文 / 英文 ----------------
    def _detect_ja_or_en(self, audio: np.ndarray) -> str:
        """用 base whisper 偵測語言，只在 ja / en 之間二選一。"""
        try:
            import whisper
            m = self.model
            n_mels = getattr(m.dims, "n_mels", 80)
            mel = whisper.log_mel_spectrogram(whisper.pad_or_trim(audio), n_mels).to(m.device)
            _, probs = m.detect_language(mel)
            ja = float(probs.get("ja", 0.0))
            en = float(probs.get("en", 0.0))
            return "ja" if ja >= en else "en"
        except Exception as e:
            sys.stderr.write(f"[asr] detect fallback: {e}\n")
            return "en"

    def _ensure_ja_model(self):
        """延遲載入 HuggingFace 日文微調模型（whisper-large-v3-turbo-ja）。"""
        if self.ja_pipe is not None:
            return
        emit({"type": "model_loading", "model": "whisper-large-v3-turbo-ja"})
        try:
            from transformers import pipeline
            import torch
            use_cuda = (self.model_device == "cuda")
            dt = torch.float16 if use_cuda else torch.float32
            base = {
                "model": "hhim8826/whisper-large-v3-turbo-ja",
                "device": 0 if use_cuda else -1,
            }
            # transformers 5.x 用 dtype，4.x 用 torch_dtype，皆不支援則不帶
            try:
                self.ja_pipe = pipeline("automatic-speech-recognition", dtype=dt, **base)
            except TypeError:
                try:
                    self.ja_pipe = pipeline("automatic-speech-recognition", torch_dtype=dt, **base)
                except TypeError:
                    self.ja_pipe = pipeline("automatic-speech-recognition", **base)
            emit({"type": "model_ready", "model": "whisper-large-v3-turbo-ja", "device": self.model_device})
        except Exception as e:
            emit({"type": "error", "where": "load_ja_model", "message": str(e)})
            self.ja_pipe = None

    def _transcribe_ja(self, audio: np.ndarray) -> str:
        self._ensure_ja_model()
        if self.ja_pipe is None:
            return ""
        out = self.ja_pipe(
            audio,
            chunk_length_s=20,
            generate_kwargs={"language": "japanese", "task": "transcribe"},
        )
        return (out.get("text") or "").strip()

    @staticmethod
    def _has_kanji(s: str) -> bool:
        return any("一" <= c <= "鿿" for c in s)

    def _furigana(self, text: str):
        """用 pykakasi 產生假名注音（ruby）token：[{t, r}, ...]。
        r 為漢字讀音（平假名）；純假名 / 英數 → r 空字串。"""
        try:
            if self._kks is None:
                import pykakasi
                self._kks = pykakasi.kakasi()
            tokens = []
            for it in self._kks.convert(text):
                orig = it.get("orig", "")
                hira = it.get("hira", "")
                r = hira if (self._has_kanji(orig) and hira and hira != orig) else ""
                tokens.append({"t": orig, "r": r})
            return tokens
        except Exception as e:
            sys.stderr.write(f"[asr] furigana failed: {e}\n")
            return None

    # ---------------- 擷取控制 ----------------
    def start(self, device_index: int, backend: str = "auto",
              model: str = "small", task: str = "transcribe", language=None,
              detect: str = "auto"):
        if self.running:
            self.stop()

        self.task = task or "transcribe"
        self.language = language
        self.detect_mode = detect or "auto"
        if self.model is None or self.model_name != model:
            self.load_model(model)
        if self.model is None:
            return  # load_model 已回報錯誤

        # 重置 VAD 狀態
        self._buf = []
        self._buf_samples = 0
        self._silence_run = 0.0
        self._in_speech = False
        self._noise_floor = BASE_SILENCE_RMS

        try:
            self.capture = audio_capture.LoopbackCapture(device_index, backend=backend)
        except Exception as e:
            emit({"type": "error", "where": "open_device", "message": str(e)})
            return

        self.running = True
        self._worker = threading.Thread(target=self._process_loop, daemon=True)
        self._worker.start()

        try:
            self.capture.start(self._on_audio)
            emit({"type": "status", "state": "listening"})
        except Exception as e:
            self.running = False
            emit({"type": "error", "where": "start_capture", "message": str(e)})
            self._try_reconnect(device_index, backend)

    def stop(self):
        self.running = False
        if self.capture is not None:
            try:
                self.capture.stop()
            except Exception:
                pass
            self.capture = None
        # 清空佇列
        try:
            while True:
                self._audio_q.get_nowait()
        except queue.Empty:
            pass
        emit({"type": "status", "state": "stopped"})

    def _try_reconnect(self, device_index, backend):
        emit({"type": "status", "state": "reconnecting"})
        for _ in range(3):
            time.sleep(1.0)
            try:
                self.capture = audio_capture.LoopbackCapture(device_index, backend=backend)
                self.running = True
                self._worker = threading.Thread(target=self._process_loop, daemon=True)
                self._worker.start()
                self.capture.start(self._on_audio)
                emit({"type": "status", "state": "listening"})
                return
            except Exception:
                continue
        emit({"type": "error", "where": "reconnect", "message": "無法重新連線音訊裝置"})

    # ---------------- 音訊回呼（capture thread）----------------
    def _on_audio(self, chunk: np.ndarray):
        if not self.running:
            return
        # 音量回報（節流）
        now = time.time()
        rms = float(np.sqrt(np.mean(np.square(chunk)))) if chunk.size else 0.0
        if now - self._last_volume_emit >= VOLUME_EMIT_INTERVAL:
            # 對數縮放讓小音量也可見
            level = min(1.0, (rms ** 0.5) * 3.0)
            emit({"type": "volume", "level": round(level, 3)})
            self._last_volume_emit = now
        self._audio_q.put((chunk, rms))

    # ---------------- VAD（人聲偵測）----------------
    def _ensure_vad(self):
        """載入 Silero VAD 人聲偵測模型；失敗則回退能量門檻 VAD。"""
        if self._vad_tried:
            return
        self._vad_tried = True
        try:
            import torch  # noqa: F401
            from silero_vad import load_silero_vad, VADIterator
            self.vad_model = load_silero_vad(onnx=False)
            self.vad_iterator = VADIterator(
                self.vad_model,
                threshold=0.5,
                sampling_rate=SAMPLE_RATE,
                min_silence_duration_ms=int(SILENCE_SEC * 1000),
                speech_pad_ms=120,
            )
            emit({"type": "vad", "engine": "silero"})
        except Exception as e:
            sys.stderr.write(f"[asr] Silero VAD 不可用，改用能量 VAD: {e}\n")
            self.vad_model = None
            self.vad_iterator = None
            emit({"type": "vad", "engine": "energy"})

    # ---------------- 處理迴圈（worker thread）----------------
    def _process_loop(self):
        self._ensure_vad()
        if self.vad_iterator is not None:
            self._process_loop_vad()
        else:
            self._process_loop_energy()

    def _process_loop_vad(self):
        """Silero VAD：偵測到一句人聲講完（語音結束）→ 立即送辨識輸出字幕。"""
        import torch
        import collections
        frame_buf = np.zeros(0, dtype=np.float32)
        preroll = collections.deque(maxlen=VAD_PREROLL_FRAMES)
        collecting = False
        collected = []
        while self.running:
            try:
                chunk, rms = self._audio_q.get(timeout=0.3)
            except queue.Empty:
                continue
            frame_buf = np.concatenate([frame_buf, chunk]) if frame_buf.size else chunk.astype(np.float32)
            while frame_buf.shape[0] >= VAD_FRAME:
                frame = frame_buf[:VAD_FRAME]
                frame_buf = frame_buf[VAD_FRAME:]
                try:
                    out = self.vad_iterator(torch.from_numpy(frame), return_seconds=False)
                except Exception as e:
                    sys.stderr.write(f"[asr] vad frame err: {e}\n")
                    out = None
                preroll.append(frame)
                if collecting:
                    collected.append(frame)
                if out and "start" in out and not collecting:
                    collecting = True
                    collected = list(preroll)  # 含語音起始前 pre-roll
                    self._seg_start_ts = time.time()
                if out and "end" in out and collecting:
                    collecting = False
                    self._emit_collected(collected)
                    collected = []
                    self._reset_vad()
                # 過長句子強制切斷
                if collecting and len(collected) * VAD_FRAME / SAMPLE_RATE >= MAX_SEG_SEC:
                    collecting = False
                    self._emit_collected(collected)
                    collected = []
                    self._reset_vad()

    def _reset_vad(self):
        try:
            self.vad_iterator.reset_states()
        except Exception:
            pass

    def _process_loop_energy(self):
        """後援：能量門檻 VAD（無 Silero 時使用）。"""
        while self.running:
            try:
                chunk, rms = self._audio_q.get(timeout=0.3)
            except queue.Empty:
                continue

            dur = chunk.shape[0] / float(SAMPLE_RATE)
            if rms < self._noise_floor * 1.5:
                self._noise_floor = 0.95 * self._noise_floor + 0.05 * rms
            threshold = max(BASE_SILENCE_RMS, self._noise_floor * 2.2)
            is_voiced = rms > threshold

            if is_voiced:
                if not self._in_speech:
                    self._in_speech = True
                    self._seg_start_ts = time.time()
                self._buf.append(chunk)
                self._buf_samples += chunk.shape[0]
                self._silence_run = 0.0
            else:
                if self._in_speech:
                    self._buf.append(chunk)
                    self._buf_samples += chunk.shape[0]
                    self._silence_run += dur
                    if self._silence_run >= SILENCE_SEC:
                        self._flush_segment()

            if self._buf_samples / SAMPLE_RATE >= MAX_SEG_SEC:
                self._flush_segment()

    def _emit_collected(self, frames):
        if not frames:
            return
        audio = np.concatenate(frames).astype(np.float32)
        if audio.shape[0] / float(SAMPLE_RATE) < MIN_SEG_SEC:
            return
        self._recognize(audio, int(self._seg_start_ts * 1000), int(time.time() * 1000))

    def _flush_segment(self):
        buf = self._buf
        n = self._buf_samples
        self._buf = []
        self._buf_samples = 0
        self._silence_run = 0.0
        self._in_speech = False

        seg_sec = n / float(SAMPLE_RATE)
        if seg_sec < MIN_SEG_SEC or not buf:
            return

        audio = np.concatenate(buf).astype(np.float32)
        self._recognize(audio, int(self._seg_start_ts * 1000), int(time.time() * 1000))

    def _recognize(self, audio, start_ts, end_ts):
        """語言分流 → 辨識 → 輸出字幕事件（日/英路由 + 假名注音）。"""
        emit({"type": "status", "state": "recognizing"})
        try:
            # 僅支援日文 / 英文：依偵測模式決定語言
            if self.detect_mode == "ja":
                lang = "ja"
            elif self.detect_mode == "en":
                lang = "en"
            else:
                lang = self._detect_ja_or_en(audio)  # auto
            furigana = None
            if lang == "ja":
                # 日文 → HuggingFace 微調模型（動漫語音特化）
                text = self._transcribe_ja(audio)
                if text:
                    furigana = self._furigana(text)  # 漢字上方平假名注音
            else:
                # 英文 → 原本的 openai-whisper base 模型
                result = self.model.transcribe(
                    audio,
                    task="transcribe",
                    language="en",
                    fp16=(self.model_device == "cuda"),
                    condition_on_previous_text=False,
                    no_speech_threshold=0.5,
                )
                text = (result.get("text") or "").strip()
                lang = "en"
            if text:
                emit({
                    "type": "segment",
                    "text": text,
                    "lang": lang,
                    "furigana": furigana,
                    "start_ts": start_ts,
                    "end_ts": end_ts,
                })
        except Exception as e:
            emit({"type": "error", "where": "transcribe", "message": str(e)})
        finally:
            if self.running:
                emit({"type": "status", "state": "listening"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--list-devices", action="store_true")
    args = parser.parse_args()

    if args.list_devices:
        print(json.dumps({
            "backends": audio_capture.backend_status(),
            "devices": audio_capture.list_loopback_devices(),
        }, ensure_ascii=False, indent=2))
        return

    engine = ASREngine()
    emit({"type": "ready", "backends": audio_capture.backend_status()})

    # 讀取 stdin 指令迴圈
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            emit({"type": "error", "where": "parse", "message": f"bad json: {line[:120]}"})
            continue

        cmd = msg.get("cmd")
        try:
            if cmd == "list_devices":
                emit({"type": "devices", "devices": audio_capture.list_loopback_devices()})
            elif cmd == "load_model":
                engine.load_model(msg.get("model", "small"))
            elif cmd == "start":
                engine.start(
                    device_index=int(msg.get("device", -1)),
                    backend=msg.get("backend", "auto"),
                    model=msg.get("model", "small"),
                    task=msg.get("task", "transcribe"),
                    language=msg.get("language", None),
                    detect=msg.get("detect", "auto"),
                )
            elif cmd == "set_detect":
                # 執行中即時切換偵測語言（auto / ja / en）
                engine.detect_mode = msg.get("mode", "auto") or "auto"
                emit({"type": "detect_mode", "mode": engine.detect_mode})
            elif cmd == "stop":
                engine.stop()
            elif cmd == "ping":
                emit({"type": "pong"})
            elif cmd == "quit":
                engine.stop()
                break
            else:
                emit({"type": "error", "where": "dispatch", "message": f"unknown cmd: {cmd}"})
        except Exception as e:
            emit({"type": "error", "where": f"cmd:{cmd}", "message": str(e)})


if __name__ == "__main__":
    main()
