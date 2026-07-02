"""
audio_capture.py
================
擷取「系統音訊輸出」（Loopback）— 也就是電腦正在播放的聲音（影片 / 會議 / 串流 / 遊戲），
而非麥克風輸入。

提供兩個後端，依可用性自動選擇：
  1. PyAudioWPatch  — Windows WASAPI Loopback 專用，最穩定（建議）
  2. sounddevice    — 跨平台，Windows 走 WASAPI Loopback / 立體聲混音

對外介面：
    list_loopback_devices() -> list[dict]
    LoopbackCapture(device_index, samplerate=16000, channels=1)
        .start(callback)   # callback(np.float32 mono @ samplerate)
        .stop()

所有音訊統一重採樣為 16000Hz、單聲道、float32（Whisper 需求）。
"""

import sys
import numpy as np

SAMPLE_RATE = 16000

# ---------------------------------------------------------------------------
# 後端偵測
# ---------------------------------------------------------------------------
_HAS_PYAUDIOWPATCH = False
_HAS_SOUNDDEVICE = False

try:
    import pyaudiowpatch as pyaudio  # type: ignore
    _HAS_PYAUDIOWPATCH = True
except Exception:
    pass

try:
    import sounddevice as sd  # type: ignore
    _HAS_SOUNDDEVICE = True
except Exception:
    pass


def _resample_to_16k(chunk: np.ndarray, src_rate: int) -> np.ndarray:
    """線性重採樣至 16000Hz（足夠語音辨識使用）。"""
    if src_rate == SAMPLE_RATE:
        return chunk.astype(np.float32, copy=False)
    if chunk.size == 0:
        return chunk.astype(np.float32, copy=False)
    duration = chunk.shape[0] / float(src_rate)
    tgt_len = max(1, int(round(duration * SAMPLE_RATE)))
    x_old = np.linspace(0.0, 1.0, num=chunk.shape[0], endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=tgt_len, endpoint=False)
    return np.interp(x_new, x_old, chunk).astype(np.float32)


def _to_mono(data: np.ndarray, channels: int) -> np.ndarray:
    if channels <= 1:
        return data.reshape(-1).astype(np.float32)
    return data.reshape(-1, channels).mean(axis=1).astype(np.float32)


# ---------------------------------------------------------------------------
# 裝置列舉
# ---------------------------------------------------------------------------
def list_loopback_devices() -> list:
    """
    回傳可用的 Loopback 音訊輸出來源。
    每個項目：{ index, name, backend, is_default, channels, samplerate }
    """
    devices = []

    # --- PyAudioWPatch：列出 WASAPI Loopback ---
    if _HAS_PYAUDIOWPATCH:
        try:
            pa = pyaudio.PyAudio()
            try:
                wasapi = pa.get_host_api_info_by_type(pyaudio.paWASAPI)
                default_speakers = pa.get_device_info_by_index(
                    wasapi["defaultOutputDevice"]
                )
            except Exception:
                default_speakers = None

            for lb in pa.get_loopback_device_info_generator():
                is_default = bool(
                    default_speakers
                    and default_speakers["name"] in lb["name"]
                )
                devices.append({
                    "index": int(lb["index"]),
                    "name": lb["name"].replace(" [Loopback]", ""),
                    "backend": "pyaudiowpatch",
                    "is_default": is_default,
                    "channels": int(lb.get("maxInputChannels", 2)) or 2,
                    "samplerate": int(lb.get("defaultSampleRate", 48000)),
                })
            pa.terminate()
        except Exception as e:
            sys.stderr.write(f"[audio_capture] pyaudiowpatch enum failed: {e}\n")

    # --- sounddevice：找含 Loopback / 立體聲混音 / Stereo Mix 的輸入裝置 ---
    if _HAS_SOUNDDEVICE and not devices:
        try:
            hostapis = sd.query_hostapis()
            for i, d in enumerate(sd.query_devices()):
                name = d.get("name", "")
                if d.get("max_input_channels", 0) <= 0:
                    continue
                lname = name.lower()
                looks_loopback = any(k in lname for k in (
                    "loopback", "立體聲混音", "stereo mix", "what u hear", "wave out"
                ))
                host = hostapis[d["hostapi"]]["name"] if d.get("hostapi") is not None else ""
                if looks_loopback or "wasapi" in host.lower():
                    devices.append({
                        "index": int(i),
                        "name": name,
                        "backend": "sounddevice",
                        "is_default": False,
                        "channels": int(d.get("max_input_channels", 2)) or 2,
                        "samplerate": int(d.get("default_samplerate", 48000)),
                    })
        except Exception as e:
            sys.stderr.write(f"[audio_capture] sounddevice enum failed: {e}\n")

    return devices


def backend_status() -> dict:
    return {
        "pyaudiowpatch": _HAS_PYAUDIOWPATCH,
        "sounddevice": _HAS_SOUNDDEVICE,
    }


# ---------------------------------------------------------------------------
# 擷取器
# ---------------------------------------------------------------------------
class LoopbackCapture:
    """開啟指定 Loopback 裝置，持續以 callback 回傳 16kHz mono float32 音訊。"""

    def __init__(self, device_index: int, backend: str = "auto"):
        self.device_index = int(device_index)
        self.backend = backend
        self._running = False
        self._stream = None
        self._pa = None
        self._callback = None
        self._src_rate = SAMPLE_RATE
        self._channels = 1

        if backend == "auto":
            self.backend = "pyaudiowpatch" if _HAS_PYAUDIOWPATCH else "sounddevice"

    # --- 對外 API ---
    def start(self, callback):
        self._callback = callback
        self._running = True
        if self.backend == "pyaudiowpatch":
            self._start_pyaudio()
        else:
            self._start_sounddevice()

    def stop(self):
        self._running = False
        try:
            if self.backend == "pyaudiowpatch":
                if self._stream is not None:
                    self._stream.stop_stream()
                    self._stream.close()
                if self._pa is not None:
                    self._pa.terminate()
            else:
                if self._stream is not None:
                    self._stream.stop()
                    self._stream.close()
        except Exception:
            pass
        finally:
            self._stream = None
            self._pa = None

    # --- PyAudioWPatch 後端 ---
    def _start_pyaudio(self):
        self._pa = pyaudio.PyAudio()
        info = self._pa.get_device_info_by_index(self.device_index)
        self._channels = int(info.get("maxInputChannels", 2)) or 2
        self._src_rate = int(info.get("defaultSampleRate", 48000))
        frames = max(1024, int(self._src_rate * 0.1))  # ~100ms 區塊

        def _cb(in_data, frame_count, time_info, status):
            if not self._running:
                return (None, pyaudio.paComplete)
            try:
                data = np.frombuffer(in_data, dtype=np.float32)
                mono = _to_mono(data, self._channels)
                out = _resample_to_16k(mono, self._src_rate)
                if self._callback:
                    self._callback(out)
            except Exception as e:
                sys.stderr.write(f"[audio_capture] pyaudio cb err: {e}\n")
            return (None, pyaudio.paContinue)

        self._stream = self._pa.open(
            format=pyaudio.paFloat32,
            channels=self._channels,
            rate=self._src_rate,
            frames_per_buffer=frames,
            input=True,
            input_device_index=self.device_index,
            stream_callback=_cb,
        )
        self._stream.start_stream()

    # --- sounddevice 後端 ---
    def _start_sounddevice(self):
        info = sd.query_devices(self.device_index)
        self._channels = int(info.get("max_input_channels", 2)) or 2
        self._src_rate = int(info.get("default_samplerate", 48000))
        blocksize = int(self._src_rate * 0.1)  # ~100ms

        wasapi_settings = None
        try:
            wasapi_settings = sd.WasapiSettings(loopback=True)  # 新版 sounddevice 支援
        except Exception:
            wasapi_settings = None

        def _cb(indata, frames, time_info, status):
            if status:
                sys.stderr.write(f"[audio_capture] sd status: {status}\n")
            try:
                mono = _to_mono(np.array(indata, dtype=np.float32), self._channels)
                out = _resample_to_16k(mono, self._src_rate)
                if self._callback:
                    self._callback(out)
            except Exception as e:
                sys.stderr.write(f"[audio_capture] sd cb err: {e}\n")

        kwargs = dict(
            device=self.device_index,
            samplerate=self._src_rate,
            channels=self._channels,
            dtype="float32",
            blocksize=blocksize,
            callback=_cb,
        )
        if wasapi_settings is not None:
            kwargs["extra_settings"] = wasapi_settings

        self._stream = sd.InputStream(**kwargs)
        self._stream.start()


if __name__ == "__main__":
    import json
    print(json.dumps({
        "backends": backend_status(),
        "devices": list_loopback_devices(),
    }, ensure_ascii=False, indent=2))
