"""
process_audio_capture.py
========================
擷取「特定應用程式（視窗）」的音訊 — Windows WASAPI Process Loopback。
只錄目標程序（含子程序）正在播放的聲音，不受其他應用程式干擾。

需求：Windows 10 2004+（Win11 OK）、comtypes、pycaw（列舉音訊工作階段）。

對外介面（與 audio_capture.LoopbackCapture 相同）：
    list_audio_sessions() -> list[dict]   # {pid, name, title, active}
    ProcessLoopbackCapture(pid)
        .start(callback)   # callback(np.float32 mono @16000Hz)
        .stop()

實作重點：
  - ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ..., AUDIOCLIENT_ACTIVATION_PARAMS)
  - Initialize 直接要求 16kHz mono float32 + AUTOCONVERTPCM（引擎自動轉檔）
  - 目標程序沒出聲時不會有封包 → 合成靜音餵給 VAD，句尾偵測才會動作
"""

import sys
import time
import threading
import ctypes
from ctypes import (POINTER, Structure, byref, cast, sizeof,
                    c_void_p, c_int, c_uint32, c_uint64, c_longlong,
                    c_ushort, c_ulong, c_wchar_p, c_ubyte)
from ctypes import wintypes

import numpy as np

import comtypes
from comtypes import GUID, IUnknown, COMMETHOD, COMObject, HRESULT

SAMPLE_RATE = 16000

# ---------------------------------------------------------------------------
# Win32 / WASAPI 常數與結構
# ---------------------------------------------------------------------------
VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = "VAD\\Process_Loopback"

AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0

AUDCLNT_SHAREMODE_SHARED = 0
AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000
AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000
AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000
AUDCLNT_BUFFERFLAGS_SILENT = 0x2

WAVE_FORMAT_IEEE_FLOAT = 3
VT_BLOB = 65
REFERENCE_TIME = c_longlong


class WAVEFORMATEX(Structure):
    _fields_ = [
        ("wFormatTag", wintypes.WORD),
        ("nChannels", wintypes.WORD),
        ("nSamplesPerSec", wintypes.DWORD),
        ("nAvgBytesPerSec", wintypes.DWORD),
        ("nBlockAlign", wintypes.WORD),
        ("wBitsPerSample", wintypes.WORD),
        ("cbSize", wintypes.WORD),
    ]


class AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS(Structure):
    _fields_ = [
        ("TargetProcessId", wintypes.DWORD),
        ("ProcessLoopbackMode", c_int),
    ]


class AUDIOCLIENT_ACTIVATION_PARAMS(Structure):
    _fields_ = [
        ("ActivationType", c_int),
        ("ProcessLoopbackParams", AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS),
    ]


class BLOB(Structure):
    _fields_ = [("cbSize", c_ulong), ("pBlobData", c_void_p)]


class PROPVARIANT(Structure):
    _fields_ = [
        ("vt", c_ushort),
        ("wReserved1", c_ushort),
        ("wReserved2", c_ushort),
        ("wReserved3", c_ushort),
        ("blob", BLOB),
    ]


# ---------------------------------------------------------------------------
# COM 介面定義
# ---------------------------------------------------------------------------
class IActivateAudioInterfaceAsyncOperation(IUnknown):
    _iid_ = GUID("{72A22D78-CDE4-431D-B8CC-843A71199B6D}")
    _methods_ = [
        COMMETHOD([], HRESULT, "GetActivateResult",
                  (["out"], POINTER(HRESULT), "activateResult"),
                  (["out"], POINTER(POINTER(IUnknown)), "activatedInterface")),
    ]


class IActivateAudioInterfaceCompletionHandler(IUnknown):
    _iid_ = GUID("{41D949AB-9862-444A-80F6-C261334DA5EB}")
    _methods_ = [
        COMMETHOD([], HRESULT, "ActivateCompleted",
                  (["in"], POINTER(IActivateAudioInterfaceAsyncOperation), "activateOperation")),
    ]


class IAudioClient(IUnknown):
    _iid_ = GUID("{1CB9AD4C-DBFA-4c32-B178-C2F568A703B2}")
    _methods_ = [
        COMMETHOD([], HRESULT, "Initialize",
                  (["in"], c_int, "ShareMode"),
                  (["in"], wintypes.DWORD, "StreamFlags"),
                  (["in"], REFERENCE_TIME, "hnsBufferDuration"),
                  (["in"], REFERENCE_TIME, "hnsPeriodicity"),
                  (["in"], POINTER(WAVEFORMATEX), "pFormat"),
                  (["in"], POINTER(GUID), "AudioSessionGuid")),
        COMMETHOD([], HRESULT, "GetBufferSize",
                  (["out"], POINTER(c_uint32), "pNumBufferFrames")),
        COMMETHOD([], HRESULT, "GetStreamLatency",
                  (["out"], POINTER(REFERENCE_TIME), "phnsLatency")),
        COMMETHOD([], HRESULT, "GetCurrentPadding",
                  (["out"], POINTER(c_uint32), "pNumPaddingFrames")),
        COMMETHOD([], HRESULT, "IsFormatSupported",
                  (["in"], c_int, "ShareMode"),
                  (["in"], POINTER(WAVEFORMATEX), "pFormat"),
                  (["out"], POINTER(POINTER(WAVEFORMATEX)), "ppClosestMatch")),
        COMMETHOD([], HRESULT, "GetMixFormat",
                  (["out"], POINTER(POINTER(WAVEFORMATEX)), "ppDeviceFormat")),
        COMMETHOD([], HRESULT, "GetDevicePeriod",
                  (["out"], POINTER(REFERENCE_TIME), "phnsDefaultDevicePeriod"),
                  (["out"], POINTER(REFERENCE_TIME), "phnsMinimumDevicePeriod")),
        COMMETHOD([], HRESULT, "Start"),
        COMMETHOD([], HRESULT, "Stop"),
        COMMETHOD([], HRESULT, "Reset"),
        COMMETHOD([], HRESULT, "SetEventHandle",
                  (["in"], wintypes.HANDLE, "eventHandle")),
        COMMETHOD([], HRESULT, "GetService",
                  (["in"], POINTER(GUID), "riid"),
                  (["out"], POINTER(POINTER(IUnknown)), "ppv")),
    ]


class IAudioCaptureClient(IUnknown):
    _iid_ = GUID("{C8ADBD64-E71E-48a0-A4DE-185C395CD317}")
    _methods_ = [
        COMMETHOD([], HRESULT, "GetBuffer",
                  (["out"], POINTER(POINTER(c_ubyte)), "ppData"),
                  (["out"], POINTER(c_uint32), "pNumFramesToRead"),
                  (["out"], POINTER(wintypes.DWORD), "pdwFlags"),
                  (["out"], POINTER(c_uint64), "pu64DevicePosition"),
                  (["out"], POINTER(c_uint64), "pu64QPCPosition")),
        COMMETHOD([], HRESULT, "ReleaseBuffer",
                  (["in"], c_uint32, "NumFramesRead")),
        COMMETHOD([], HRESULT, "GetNextPacketSize",
                  (["out"], POINTER(c_uint32), "pNumFramesInNextPacket")),
    ]


class IAgileObject(IUnknown):
    """免封送標記介面 — ActivateAudioInterfaceAsync 要求 handler 為 agile，
    否則回 E_ILLEGAL_METHOD_CALL (0x8000000E)。"""
    _iid_ = GUID("{94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90}")
    _methods_ = []


class _CompletionHandler(COMObject):
    _com_interfaces_ = [IActivateAudioInterfaceCompletionHandler, IAgileObject]

    def __init__(self):
        super().__init__()
        self.done = threading.Event()

    def ActivateCompleted(self, activateOperation):
        self.done.set()
        return 0


_mmdevapi = ctypes.WinDLL("Mmdevapi.dll")
_ActivateAudioInterfaceAsync = _mmdevapi.ActivateAudioInterfaceAsync
_ActivateAudioInterfaceAsync.restype = ctypes.c_long
_ActivateAudioInterfaceAsync.argtypes = [
    c_wchar_p,
    POINTER(GUID),
    POINTER(PROPVARIANT),
    POINTER(IActivateAudioInterfaceCompletionHandler),
    POINTER(POINTER(IActivateAudioInterfaceAsyncOperation)),
]


def _make_wfx(rate, channels):
    wfx = WAVEFORMATEX()
    wfx.wFormatTag = WAVE_FORMAT_IEEE_FLOAT
    wfx.nChannels = channels
    wfx.nSamplesPerSec = rate
    wfx.wBitsPerSample = 32
    wfx.nBlockAlign = channels * 4
    wfx.nAvgBytesPerSec = rate * wfx.nBlockAlign
    wfx.cbSize = 0
    return wfx


# ---------------------------------------------------------------------------
# 應用程式音訊工作階段列舉（pid → 視窗標題）
# ---------------------------------------------------------------------------
def _window_titles_by_pid():
    """列舉可見視窗，回傳 {pid: 標題}（每個 pid 取第一個非空標題）。"""
    user32 = ctypes.windll.user32
    titles = {}

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _lparam):
        if user32.IsWindowVisible(hwnd):
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, byref(pid))
            n = user32.GetWindowTextLengthW(hwnd)
            if n and pid.value not in titles:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                if buf.value.strip():
                    titles[pid.value] = buf.value.strip()
        return True

    user32.EnumWindows(cb, 0)
    return titles


def list_audio_sessions():
    """列出有音訊工作階段的應用程式：{pid, name, title, active}。"""
    try:
        from pycaw.pycaw import AudioUtilities
    except Exception as e:
        sys.stderr.write(f"[proc_capture] pycaw unavailable: {e}\n")
        return []
    titles = {}
    try:
        titles = _window_titles_by_pid()
    except Exception:
        pass

    merged = {}  # pid -> entry（active 優先）
    try:
        for s in AudioUtilities.GetAllSessions():
            try:
                p = s.Process
                if not p:
                    continue
                pid = p.pid
                active = (int(s.State) == 1) if s.State is not None else False
                cur = merged.get(pid)
                if cur is None:
                    merged[pid] = {
                        "pid": pid,
                        "name": p.name(),
                        "title": titles.get(pid, ""),
                        "active": active,
                    }
                elif active:
                    cur["active"] = True
            except Exception:
                continue
    except Exception as e:
        sys.stderr.write(f"[proc_capture] session enum failed: {e}\n")
    # 活躍的排前面
    return sorted(merged.values(), key=lambda x: (not x["active"], x["name"].lower()))


# ---------------------------------------------------------------------------
# Process Loopback 擷取器
# ---------------------------------------------------------------------------
class ProcessLoopbackCapture:
    """擷取指定 pid（含子程序）的播放音訊，callback 收 16kHz mono float32。"""

    def __init__(self, pid: int, backend: str = "process"):
        self.pid = int(pid)
        self._running = False
        self._thread = None
        self._callback = None
        self._err = None

    # --- 對外 API（與 LoopbackCapture 相同） ---
    def start(self, callback):
        self._callback = callback
        self._running = True
        started = threading.Event()
        self._thread = threading.Thread(
            target=self._run, args=(started,), daemon=True)
        self._thread.start()
        # 等初始化結果（activation + Initialize），失敗就丟例外給呼叫端
        if not started.wait(timeout=8.0):
            self._running = False
            raise RuntimeError("Process Loopback 初始化逾時")
        if self._err:
            self._running = False
            raise RuntimeError(self._err)

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)
            self._thread = None

    # --- 擷取執行緒 ---
    def _run(self, started: threading.Event):
        try:
            comtypes.CoInitializeEx(comtypes.COINIT_MULTITHREADED)
        except OSError:
            pass  # 已初始化

        client = None
        capture = None
        try:
            client = self._activate()
            wfx, resample_from = self._initialize(client)
            svc = client.GetService(byref(IAudioCaptureClient._iid_))
            capture = svc.QueryInterface(IAudioCaptureClient)
            client.Start()
            self._err = None
            started.set()
            self._poll_loop(capture, wfx, resample_from)
        except Exception as e:
            self._err = f"Process Loopback 失敗（pid={self.pid}）: {e}"
            sys.stderr.write("[proc_capture] " + self._err + "\n")
            started.set()
        finally:
            try:
                if client is not None:
                    client.Stop()
            except Exception:
                pass

    def _activate(self):
        params = AUDIOCLIENT_ACTIVATION_PARAMS()
        params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
        params.ProcessLoopbackParams.TargetProcessId = self.pid
        params.ProcessLoopbackParams.ProcessLoopbackMode = \
            PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE

        pv = PROPVARIANT()
        pv.vt = VT_BLOB
        pv.blob.cbSize = sizeof(params)
        pv.blob.pBlobData = cast(byref(params), c_void_p)

        handler = _CompletionHandler()
        handler_if = handler.QueryInterface(IActivateAudioInterfaceCompletionHandler)
        op = POINTER(IActivateAudioInterfaceAsyncOperation)()

        hr = _ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            byref(IAudioClient._iid_),
            byref(pv),
            handler_if,
            byref(op),
        )
        if hr < 0:
            raise OSError(f"ActivateAudioInterfaceAsync hr=0x{hr & 0xFFFFFFFF:08X}")
        if not handler.done.wait(timeout=5.0):
            raise TimeoutError("音訊介面啟動逾時")

        act_hr, unk = op.GetActivateResult()
        if act_hr < 0:
            raise OSError(f"GetActivateResult hr=0x{act_hr & 0xFFFFFFFF:08X}"
                          "（目標程序可能已結束或無音訊權限）")
        return unk.QueryInterface(IAudioClient)

    def _initialize(self, client):
        """優先直接要 16k mono float（AUTOCONVERTPCM 讓引擎轉檔）；
        不支援則退 48k stereo float 自行重採樣。回傳 (wfx, 是否需重採樣的來源率)。"""
        flags = (AUDCLNT_STREAMFLAGS_LOOPBACK
                 | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                 | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY)
        for rate, ch in ((SAMPLE_RATE, 1), (48000, 2)):
            wfx = _make_wfx(rate, ch)
            try:
                client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags,
                                  2_000_000, 0, byref(wfx), None)
                return wfx, (None if rate == SAMPLE_RATE and ch == 1 else rate)
            except Exception as e:
                last = e
        raise last

    def _poll_loop(self, capture, wfx, resample_from):
        import audio_capture  # 重採樣工具
        block = wfx.nBlockAlign
        ch = wfx.nChannels
        last_data = time.time()
        SILENT_CHUNK = np.zeros(SAMPLE_RATE // 10, dtype=np.float32)  # 100ms

        while self._running:
            time.sleep(0.05)
            try:
                pkt = capture.GetNextPacketSize()
            except Exception as e:
                sys.stderr.write(f"[proc_capture] poll err: {e}\n")
                break
            got = False
            while pkt > 0 and self._running:
                data, nframes, flags, _dev, _qpc = capture.GetBuffer()
                try:
                    if nframes:
                        if flags & AUDCLNT_BUFFERFLAGS_SILENT or not data:
                            chunk = np.zeros(nframes * ch, dtype=np.float32)
                        else:
                            raw = ctypes.string_at(data, nframes * block)
                            chunk = np.frombuffer(raw, dtype=np.float32).copy()
                        if ch > 1:
                            chunk = audio_capture._to_mono(chunk, ch)
                        if resample_from:
                            chunk = audio_capture._resample_to_16k(chunk, resample_from)
                        if self._callback:
                            self._callback(chunk.astype(np.float32, copy=False))
                        got = True
                finally:
                    capture.ReleaseBuffer(nframes)
                pkt = capture.GetNextPacketSize()
            now = time.time()
            if got:
                last_data = now
            elif now - last_data > 0.12 and self._callback:
                # 目標程序沒出聲：合成靜音，讓 VAD 的句尾（靜音）偵測正常運作
                self._callback(SILENT_CHUNK)
                last_data = now


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import json
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    sessions = list_audio_sessions()
    print(json.dumps({"sessions": sessions}, ensure_ascii=True, indent=1))

    target = int(sys.argv[1]) if len(sys.argv) > 1 else (
        sessions[0]["pid"] if sessions else 0)
    if not target:
        print("NO_TARGET")
        sys.exit(0)

    stats = {"chunks": 0, "samples": 0, "nonzero": 0}

    def cb(chunk):
        stats["chunks"] += 1
        stats["samples"] += chunk.shape[0]
        if np.abs(chunk).max() > 1e-6:
            stats["nonzero"] += 1

    cap = ProcessLoopbackCapture(target)
    print(f"capturing pid={target} for 2s ...")
    cap.start(cb)
    time.sleep(2.0)
    cap.stop()
    print(json.dumps({"CAPTURE_OK": True, **stats,
                      "seconds": round(stats["samples"] / 16000, 2)}))
