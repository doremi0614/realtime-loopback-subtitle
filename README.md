# 即時語音字幕工具（Realtime Loopback Subtitle）

擷取**電腦系統音訊輸出（Loopback）**，用本地 Whisper 離線辨識人聲，即時顯示字幕。
支援雙模式（翻譯 / 偵測）、翻譯 API 即時切換、輸出語言即時切換、名稱記憶學習。

適用場景：影片字幕、會議錄音翻譯、串流媒體即時字幕、遊戲語音辨識。

---

## 功能總覽

| 功能 | 說明 |
|------|------|
| 🎧 系統音訊擷取 | WASAPI Loopback（擷取電腦正在播放的聲音，非麥克風） |
| 🗣 本地離線辨識 | 僅偵測日文 / 英文：英文用 openai-whisper，日文用微調模型 `whisper-large-v3-turbo-ja` |
| 🈁 日文假名注音 | 日文原文在漢字上方自動標示平假名（furigana，ruby 顯示） |
| 🔄 翻譯 API 即時切換 | Google / DeepL / LibreTranslate / Claude，下一句立即生效、失敗自動降級 |
| 🌐 輸出語言即時切換 | 10+ 語言，工具列 Pill + Alt+1~5 快捷 |
| 🧠 名稱記憶學習 | 詞庫自動學習人名/品牌/術語，API 誤翻強制覆蓋 |
| 🪟 懸浮字幕視窗 | 透明、置頂，可疊在任何影片/會議畫面上 |

---

## 架構

```
Electron 主程序 (main.js)
 ├─ BrowserWindow  → renderer/        主控制介面
 ├─ BrowserWindow  → subtitle-overlay/ 透明懸浮字幕
 ├─ child_process  → python/asr_engine.py   (JSON-line IPC)
 │                    └─ audio_capture.py    (WASAPI Loopback 擷取)
 │                    └─ openai-whisper      (本地辨識)
 ├─ fetch()        → 翻譯 API（Google / DeepL / LibreTranslate / Claude）
 └─ electron-store → API Keys(AES) + 語言設定 + 詞庫
```

輸出檔案：
```
package.json / main.js / preload.js
renderer/          index.html · app.js · style.css
subtitle-overlay/  overlay.html · overlay.js
python/            audio_capture.py · asr_engine.py
glossary.json · requirements.txt · README.md
```

---

## 安裝

### 1. Node 依賴（Electron）
```bash
npm install
```

### 2. Python 依賴（音訊擷取 + Whisper）
需要 Python 3.9+：
```bash
python -m pip install -r requirements.txt
```

`requirements.txt` 內容：
- `sounddevice` + `numpy` — 音訊擷取
- `PyAudioWPatch`（Windows）— **強烈建議**，WASAPI Loopback 更穩定
- `openai-whisper` — 本地離線辨識

> **Whisper 首次執行會自動下載模型檔**（tiny ~75MB / base ~140MB / small ~460MB / medium ~1.5GB），請保持網路連線。之後即完全離線。

### 3. GPU 加速（可選，NVIDIA 顯卡）
```bash
pip install torch --index-url https://download.pytorch.org/whl/cu118
```
偵測到 CUDA 時，Whisper 會自動使用 GPU（狀態列會顯示 `cuda`）。

---

## 啟用系統音訊 Loopback（重要）

本工具擷取的是**電腦正在播放的聲音**，不是麥克風。

- **有安裝 PyAudioWPatch**：自動偵測預設輸出裝置的 Loopback，通常免設定。
- **只用 sounddevice**：需在 Windows 啟用「立體聲混音」：
  1. 控制台 → 聲音 → **錄製** 分頁
  2. 在空白處按右鍵 → **顯示已停用的裝置**
  3. 對「立體聲混音 / Stereo Mix」按右鍵 → **啟用**

驗證可用裝置：
```bash
npm run py:devices
# 或
python python/asr_engine.py --list-devices
```

---

## 執行

```bash
npm start
# 開發模式（開 DevTools + stderr log）
npm run dev
```

啟動後：
1. 底部**音訊裝置**下拉選擇要監聽的輸出裝置（★ 為系統預設）。
2. 播放影片/音樂，觀察狀態列**音量波形**確認有擷取到聲音。
3. 按**開始辨識**。

---

## 使用說明

### 雙模式
- **翻譯模式**：辨識任何語言 → 自動翻譯成目標語言 → 翻譯完成才滑入顯示（畫面整潔）。
- **偵測模式**：顯示原始辨識文字 + 語言標籤，每行附「▶ 翻譯」按鈕，可按需翻譯或「翻譯全部」。

### 輸出語言即時切換
- 工具列前五語言 Pill，或「+ 更多語言」下拉（含搜尋、最近使用）。
- 快捷鍵 **Alt+1 ~ Alt+5**。
- 切換後舊字幕保留原文；提示條可「重新翻譯全部字幕」。

### 翻譯 API 即時切換（設定 → 翻譯服務）
| API | Key 來源（環境變數） | 預估延遲 |
|-----|------|------|
| **Google Translate**（預設） | `GOOGLE_TRANSLATE_API_KEY` | ~200ms |
| DeepL | `DEEPL_API_KEY` | ~300ms |
| LibreTranslate | 無需（公共端點，可選填自架 Key） | ~400ms |
| Claude | `ANTHROPIC_API_KEY` | ~500ms |

- 點已設定的 API → 立即切換；點未設定 → 展開 Key 輸入。
- **測試連線** 顯示延遲；**儲存** 以 AES-256-GCM 加密後存入 config。
- 切換後底部狀態列即時顯示目前 API 名稱，並跳 Toast 通知。
- 主要 API 失敗 → 依 **Fallback 降級順序** 自動切換下一個服務。
- 未設定 Key 的 API 會阻止切換並提示「請先輸入 API Key」。

> **Key 來源優先序**：面板輸入（加密儲存）> 對應環境變數。
> 設定環境變數即可免在 UI 輸入，例如 PowerShell：`$env:GOOGLE_TRANSLATE_API_KEY="..."`。

### 名稱記憶學習（詞庫）
- **自動學習**：同場對話中英文大寫詞出現 ≥ 2 次 → 自動加入詞庫並跳「已記住：Xxx」。
- **強制覆蓋**：翻譯後若原文含已知詞，確保譯名一致（修正 API 誤翻，如 Cook → 廚師）。
- 設定 → 詞庫管理：新增/刪除、JSON 匯入匯出、暫時停用開關。
- 詞庫結構（`glossary.json`）：
  ```json
  { "人名": {"Tim Cook": "Tim Cook"}, "品牌": {"愛波": "Apple"}, "術語": {"machine learning": "機器學習"} }
  ```

### 其他
- **懸浮字幕**：工具列「🪟 懸浮」開啟透明置頂視窗，可疊在影片上。
- **字型大小**：設定 → 一般，或 **Ctrl + / Ctrl −**（14–48px）。
- **Whisper 模型**：tiny / base / small（預設）/ medium，速度與準確度取捨。

---

## 錯誤處理

| 情況 | 行為 |
|------|------|
| API Key 無效 | 測試連線顯示「連線失敗」；阻止切換 |
| 翻譯請求失敗 | 保留原文 + 標示 `[翻譯失敗]`，自動切換 Fallback API |
| 找不到 Loopback | 提示啟用「立體聲混音」或安裝 PyAudioWPatch |
| 音訊中斷 | Python 端自動重啟，狀態顯示「重新連線中…」 |

---

## 常見問題

**Q：字幕延遲多久？**
翻譯模式約 1–4 秒（辨識 1–2s + 翻譯 0.5–2s）。想更快可用 `tiny`/`base` 模型並選 Google API。

**Q：完全不連網可以嗎？**
辨識可完全離線（Whisper 本地）。翻譯需連網（除非自架 LibreTranslate）。偵測模式不點翻譯即全程離線。

**Q：語言辨識支援哪些語言？**
目前刻意限制為**日文與英文**兩種：先用 base 模型偵測，英文交給 openai-whisper、日文交給
HuggingFace 微調模型 `hhim8826/whisper-large-v3-turbo-ja`（首次辨識到日文時自動下載約 1.6GB，
建議搭配 GPU）。日文會用 pykakasi 產生假名注音，在漢字上方顯示平假名。
**翻譯輸出**仍支援 10+ 種語言，可即時切換，不受辨識語言限制。

**Q：Claude 模型版本？**
規格原指定 `claude-haiku-3-5`，該模型已於 2026-02 退役，本工具改用目前最便宜的 `claude-haiku-4-5`。

---

## 授權
MIT
