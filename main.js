'use strict';

/**
 * main.js — Electron 主程序
 * ============================================================
 * 職責：
 *  1. 建立主視窗（renderer）與字幕懸浮視窗（subtitle-overlay）
 *  2. 啟動 python/asr_engine.py 子程序，透過 JSON-line IPC 溝通
 *  3. 統一管理翻譯 API（Google / DeepL / LibreTranslate / Claude）via fetch()
 *  4. electron-store 持久化：API Keys（AES 加密）、語言設定、詞庫
 *  5. 名稱記憶學習（Glossary Engine）
 *  6. IPC handlers 供 renderer 呼叫
 */

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Store = require('electron-store');

const IS_DEV = process.argv.includes('--dev');
const APP_ROOT = __dirname;

// ------------------------------------------------------------------
// AES 加密（API Key 儲存）
// ------------------------------------------------------------------
// 以機器資訊派生一組穩定金鑰，對 API Key 做 AES-256-GCM 加密後存入 store。
const KEY_MATERIAL = crypto
  .createHash('sha256')
  .update('rt-subtitle::' + (process.env.COMPUTERNAME || process.env.HOSTNAME || 'local') + '::v1')
  .digest();

function encryptSecret(plain) {
  if (plain == null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY_MATERIAL, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptSecret(blob) {
  if (!blob || typeof blob !== 'string' || !blob.startsWith('v1:')) return '';
  try {
    const raw = Buffer.from(blob.slice(3), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY_MATERIAL, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

// ------------------------------------------------------------------
// 持久化 store
// ------------------------------------------------------------------
const store = new Store({
  name: 'subtitle-config',
  defaults: {
    activeApi: 'google',
    fallbackOrder: ['google', 'deepl', 'libre', 'claude'],
    outputLang: 'zh-TW',
    recentLangs: ['zh-TW'],
    mode: 'translate', // translate | detect
    detectLang: 'auto', // auto | ja | en（辨識時偵測的語言）
    model: 'small',
    audioDevice: null,
    subtitleFontSize: 24,
    apiKeys: {}, // { google: 'v1:...', deepl: 'v1:...', ... }
    glossaryEnabled: true,
  },
});

// 內建預設詞庫（隨程式打包，唯讀）
const BUNDLED_GLOSSARY = path.join(APP_ROOT, 'glossary.json');
// 實際讀寫的詞庫放在 userData（打包安裝到 Program Files 時該處才可寫入）
function glossaryPath() {
  try { return path.join(app.getPath('userData'), 'glossary.json'); }
  catch (e) { return BUNDLED_GLOSSARY; } // app 尚未 ready 時的後援
}

function loadGlossary() {
  const p = glossaryPath();
  try {
    if (!fs.existsSync(p)) {
      // 首次執行：以內建預設種子
      try { fs.copyFileSync(BUNDLED_GLOSSARY, p); } catch (e) { /* ignore */ }
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    try { return JSON.parse(fs.readFileSync(BUNDLED_GLOSSARY, 'utf8')); }
    catch (e2) { return { 人名: {}, 品牌: {}, 術語: {} }; }
  }
}
function saveGlossary(g) {
  try {
    fs.writeFileSync(glossaryPath(), JSON.stringify(g, null, 2), 'utf8');
  } catch (e) {
    if (IS_DEV) console.error('saveGlossary failed', e);
  }
}

// ------------------------------------------------------------------
// 翻譯服務定義 + Provider 實作（全部透過 fetch）
// ------------------------------------------------------------------
const TRANSLATION_SERVICES = {
  google: {
    id: 'google',
    name: 'Google Translate',
    needsKey: true,
    envKey: 'GOOGLE_TRANSLATE_API_KEY',
    estLatency: 200,
  },
  deepl: {
    id: 'deepl',
    name: 'DeepL',
    needsKey: true,
    envKey: 'DEEPL_API_KEY',
    estLatency: 300,
  },
  libre: {
    id: 'libre',
    name: 'LibreTranslate',
    needsKey: false,
    envKey: null,
    estLatency: 400,
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    needsKey: true,
    envKey: 'ANTHROPIC_API_KEY',
    estLatency: 500,
  },
};

// 語言代碼 → 各家 API 需要的格式
const DEEPL_LANG = {
  'zh-TW': 'ZH-HANT', 'zh-CN': 'ZH-HANS', 'en-US': 'EN-US', 'ja-JP': 'JA',
  'ko-KR': 'KO', 'es-ES': 'ES', 'fr-FR': 'FR', 'de-DE': 'DE',
  'pt-BR': 'PT-BR', 'vi-VN': 'VI',
};
const LANG_NAME = {
  'zh-TW': '繁體中文', 'zh-CN': '简体中文', 'en-US': 'English', 'ja-JP': '日本語',
  'ko-KR': '한국어', 'es-ES': 'Español', 'fr-FR': 'Français', 'de-DE': 'Deutsch',
  'pt-BR': 'Português', 'vi-VN': 'Tiếng Việt',
};
// LibreTranslate / Google 用短碼
function shortCode(lang) {
  return (lang || 'zh-TW').split('-')[0];
}
// Google Translate v2 目標語言：保留繁中/簡中地區碼，其餘用短碼
function googleTarget(lang) {
  if (lang === 'zh-TW') return 'zh-TW'; // 繁體中文
  if (lang === 'zh-CN') return 'zh-CN'; // 簡體中文
  return shortCode(lang);
}

function getApiKey(serviceId) {
  const svc = TRANSLATION_SERVICES[serviceId];
  const stored = decryptSecret((store.get('apiKeys') || {})[serviceId]);
  if (stored) return stored;
  if (svc && svc.envKey && process.env[svc.envKey]) return process.env[svc.envKey];
  return '';
}

// --- 各 Provider 的翻譯呼叫 ---
async function callGoogle(text, targetLang, sourceLang) {
  const key = getApiKey('google');
  if (!key) throw new Error('尚未設定 Google API Key');
  const url = 'https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(key);
  const body = { q: text, target: googleTarget(targetLang), format: 'text' };
  if (sourceLang && sourceLang !== 'auto') body.source = shortCode(sourceLang);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // 帶出 Google 實際錯誤原因（API 未啟用 / 未開帳單 / 金鑰限制 / 金鑰無效…）
    const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
    throw new Error('Google: ' + msg);
  }
  const t = data && data.data && data.data.translations && data.data.translations[0];
  if (!t) throw new Error('Google 回應格式錯誤');
  return t.translatedText;
}

async function callDeepL(text, targetLang) {
  const key = getApiKey('deepl');
  if (!key) throw new Error('尚未設定 DeepL API Key');
  // Free 端點；付費金鑰結尾非 :fx 則改用 api.deepl.com
  const base = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const params = new URLSearchParams();
  params.append('text', text);
  params.append('target_lang', DEEPL_LANG[targetLang] || shortCode(targetLang).toUpperCase());
  const res = await fetch(base + '/v2/translate', {
    method: 'POST',
    headers: {
      'Authorization': 'DeepL-Auth-Key ' + key,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && data.message) || ('HTTP ' + res.status);
    throw new Error(msg);
  }
  const t = data && data.translations && data.translations[0];
  if (!t) throw new Error('DeepL 回應格式錯誤');
  return t.text;
}

async function callLibre(text, targetLang, sourceLang) {
  const key = getApiKey('libre'); // 可選
  const endpoint = 'https://libretranslate.com/translate';
  const body = {
    q: text,
    source: sourceLang && sourceLang !== 'auto' ? shortCode(sourceLang) : 'auto',
    target: shortCode(targetLang),
    format: 'text',
  };
  if (key) body.api_key = key;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // 公共端點常需 API Key，會回 400/403
    const msg = (data && data.error) || ('HTTP ' + res.status + '（公共端點可能需 API Key）');
    throw new Error(msg);
  }
  if (!data || typeof data.translatedText !== 'string') throw new Error('LibreTranslate 回應格式錯誤');
  return data.translatedText;
}

async function callClaude(text, targetLang) {
  const key = getApiKey('claude');
  if (!key) throw new Error('尚未設定 Claude API Key');
  const targetName = LANG_NAME[targetLang] || targetLang;
  // 註：規格原寫 claude-haiku-3-5，該模型已於 2026-02 退役；改用目前最便宜的 haiku-4-5。
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system:
        `You are a professional subtitle translator. Translate the user's text into ${targetName}. ` +
        `Output ONLY the translation, with no quotes, no explanations, no romanization. ` +
        `Preserve proper nouns (names, brands) as-is when appropriate.`,
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch (e) {}
    throw new Error('Claude HTTP ' + res.status + (detail ? ' — ' + detail : ''));
  }
  const data = await res.json();
  const block = data && data.content && data.content.find((b) => b.type === 'text');
  if (!block) throw new Error('Claude 回應格式錯誤');
  return block.text.trim();
}

const PROVIDER_FN = {
  google: callGoogle,
  deepl: callDeepL,
  libre: callLibre,
  claude: callClaude,
};

// ------------------------------------------------------------------
// 詞庫（Glossary）套用 + 自動學習
// ------------------------------------------------------------------
// 學習規則：同場對話中，大寫開頭英文詞出現 >= 2 次 → 自動加入詞庫「人名」。
const learnCounter = new Map(); // term -> count（本次執行）
const learnedThisSession = new Set();

function flattenGlossary(g) {
  const map = {};
  for (const cat of Object.keys(g)) {
    for (const [src, dst] of Object.entries(g[cat])) map[src] = dst;
  }
  return map;
}

// 翻譯後套用詞庫強制覆蓋：若原文含已知詞，確保譯文使用正確對照。
function applyGlossary(sourceText, translated) {
  if (!store.get('glossaryEnabled')) return translated;
  const g = loadGlossary();
  const map = flattenGlossary(g);
  let out = translated;
  for (const [src, dst] of Object.entries(map)) {
    if (!src) continue;
    // 若來源句包含此詞，確保譯文中出現正確譯名
    const inSource = sourceText.toLowerCase().includes(src.toLowerCase());
    if (inSource && dst && !out.includes(dst)) {
      // 嘗試以正則替換近似誤譯（簡化：直接附加校正在句尾避免破壞語意）
      // 更精準的作法：替換 API 對該詞的錯誤翻譯，此處採保守策略。
      const re = new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      if (re.test(out)) out = out.replace(re, dst);
    }
  }
  return out;
}

// 掃描來源英文句，統計大寫詞，達門檻自動學習
function learnFromText(sourceText) {
  const learned = [];
  const words = sourceText.match(/\b[A-Z][a-zA-Z]{1,}\b/g) || [];
  const stop = new Set(['The', 'A', 'An', 'I', 'This', 'That', 'It', 'We', 'You', 'They', 'He', 'She']);
  for (const w of words) {
    if (stop.has(w)) continue;
    const c = (learnCounter.get(w) || 0) + 1;
    learnCounter.set(w, c);
    if (c >= 2 && !learnedThisSession.has(w)) {
      learnedThisSession.add(w);
      const g = loadGlossary();
      if (!g['人名']) g['人名'] = {};
      if (!Object.values(flattenGlossary(g)).includes(w) && !g['人名'][w]) {
        g['人名'][w] = w; // 保持原文
        saveGlossary(g);
        learned.push(w);
      }
    }
  }
  return learned;
}

// ------------------------------------------------------------------
// 統一翻譯入口（含 Fallback 降級）
// ------------------------------------------------------------------
async function translateUnified({ text, targetLang, sourceLang, apiId }) {
  const primary = apiId || store.get('activeApi') || 'google';

  // 來源語言 == 輸出語言 → 不需翻譯（避免 Google「Bad language pair: ja|ja」等錯誤），直接顯示原文
  if (sourceLang && sourceLang !== 'auto' && shortCode(sourceLang) === shortCode(targetLang)) {
    return {
      ok: true,
      translated: text,
      usedApi: 'none',
      usedApiName: '原文（同語言）',
      latency: 0,
      fellBack: false,
      learned: learnFromText(text),
      sameLang: true,
    };
  }

  const order = [primary, ...(store.get('fallbackOrder') || []).filter((x) => x !== primary)];

  const errors = []; // 記錄每個嘗試過的服務失敗原因，方便診斷
  for (const svcId of order) {
    const fn = PROVIDER_FN[svcId];
    if (!fn) continue;
    const svcName = TRANSLATION_SERVICES[svcId].name;
    // 未設定 Key 的服務跳過（除了 libre 無需 key）
    if (TRANSLATION_SERVICES[svcId].needsKey && !getApiKey(svcId)) {
      errors.push(`${svcName}: 未設定 Key`);
      continue;
    }
    try {
      const started = Date.now();
      let translated = await fn(text, targetLang, sourceLang);
      translated = applyGlossary(text, translated);
      const learned = learnFromText(text);
      return {
        ok: true,
        translated,
        usedApi: svcId,
        usedApiName: svcName,
        latency: Date.now() - started,
        fellBack: svcId !== primary,
        learned,
      };
    } catch (e) {
      const m = `${svcName}: ${e.message}`;
      errors.push(m);
      if (IS_DEV) console.error('[translate] ' + m);
    }
  }
  return { ok: false, error: errors.join('　｜　') || '所有翻譯服務皆失敗' };
}

// ------------------------------------------------------------------
// Python ASR 子程序管理
// ------------------------------------------------------------------
let pyProc = null;
let pyBuffer = '';

function pythonExecutable() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function startPython() {
  if (pyProc) return;
  const script = path.join(APP_ROOT, 'python', 'asr_engine.py');
  pyProc = spawn(pythonExecutable(), ['-u', script], {
    cwd: APP_ROOT,
    // 強制 Python I/O 使用 UTF-8，避免 Windows 代碼頁造成 CJK 亂碼
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });

  pyProc.stdout.on('data', (chunk) => {
    pyBuffer += chunk.toString('utf8');
    let idx;
    while ((idx = pyBuffer.indexOf('\n')) >= 0) {
      const line = pyBuffer.slice(0, idx).trim();
      pyBuffer = pyBuffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      handlePythonEvent(msg);
    }
  });

  pyProc.stderr.on('data', (d) => {
    if (IS_DEV) process.stderr.write('[py] ' + d.toString());
  });

  pyProc.on('exit', (code) => {
    if (IS_DEV) console.log('[py] exited', code);
    pyProc = null;
    sendToRenderer('asr:event', { type: 'status', state: 'stopped' });
  });
}

function pySend(obj) {
  if (!pyProc) startPython();
  try {
    pyProc.stdin.write(JSON.stringify(obj) + '\n');
  } catch (e) {
    if (IS_DEV) console.error('pySend failed', e);
  }
}

// 收到辨識句 → 若翻譯模式，主程序直接翻譯後推給 renderer
async function handlePythonEvent(msg) {
  // 音量 / 狀態 / 裝置 / 模型 / 錯誤：直接轉發
  sendToRenderer('asr:event', msg);

  if (msg.type === 'segment') {
    // overlay 顯示原文（偵測模式）或稍後翻譯（翻譯模式）
    const mode = store.get('mode');
    if (mode === 'translate') {
      const targetLang = store.get('outputLang');
      sendToRenderer('asr:event', { type: 'translating', ref: msg.start_ts });
      const r = await translateUnified({
        text: msg.text,
        targetLang,
        sourceLang: msg.lang,
      });
      if (r.ok) {
        const payload = {
          type: 'translated',
          ref: msg.start_ts,
          sourceLang: msg.lang,
          sourceText: msg.text,
          furigana: msg.furigana || null, // 日文原文的假名注音
          text: r.translated,
          targetLang,
          usedApiName: r.usedApiName,
          fellBack: r.fellBack,
          learned: r.learned,
          ts: msg.end_ts,
        };
        sendToRenderer('asr:event', payload);
        sendToOverlay('overlay:subtitle', payload);
      } else {
        sendToRenderer('asr:event', { type: 'translate_failed', ref: msg.start_ts, sourceText: msg.text, error: r.error });
      }
    } else {
      // 偵測模式：把原文推到 overlay
      sendToOverlay('overlay:subtitle', {
        type: 'raw',
        sourceLang: msg.lang,
        text: msg.text,
        furigana: msg.furigana || null,
        ts: msg.end_ts,
      });
    }
  }
}

// ------------------------------------------------------------------
// 視窗
// ------------------------------------------------------------------
let mainWindow = null;
let overlayWindow = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: '#0f0f0f',
    title: '即時語音字幕',
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(APP_ROOT, 'renderer', 'index.html'));
  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createOverlayWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  overlayWindow = new BrowserWindow({
    width: Math.min(1000, width - 80),
    height: 180,
    x: Math.round((width - Math.min(1000, width - 80)) / 2),
    y: height - 240,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    minWidth: 240,
    minHeight: 80,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true, // 需可互動以支援拖曳/改變大小把手
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile(path.join(APP_ROOT, 'subtitle-overlay', 'overlay.html'));
  // 預設點擊穿透（滑鼠事件穿到背後影片）；forward:true 讓 renderer 仍收到 mousemove
  // 以便游標移到把手時暫時接管（見 overlay:set-ignore）。
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.on('closed', () => { overlayWindow = null; });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
function sendToOverlay(channel, payload) {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send(channel, payload);
}

// ------------------------------------------------------------------
// IPC handlers
// ------------------------------------------------------------------
function registerIpc() {
  // --- 音訊裝置 / ASR 控制 ---
  ipcMain.handle('asr:list-devices', async () => {
    startPython();
    pySend({ cmd: 'list_devices' });
    return { ok: true };
  });

  ipcMain.handle('asr:start', async (_e, opts) => {
    startPython();
    const device = (opts && opts.device != null) ? opts.device : store.get('audioDevice');
    if (device == null) return { ok: false, error: '尚未選擇音訊裝置' };
    store.set('audioDevice', device);
    pySend({
      cmd: 'start',
      device,
      backend: (opts && opts.backend) || 'auto',
      model: store.get('model'),
      task: 'transcribe',
      language: null,
      detect: store.get('detectLang'),
    });
    return { ok: true };
  });

  ipcMain.handle('asr:stop', async () => {
    pySend({ cmd: 'stop' });
    return { ok: true };
  });

  ipcMain.handle('asr:load-model', async (_e, model) => {
    if (model) store.set('model', model);
    pySend({ cmd: 'load_model', model: store.get('model') });
    return { ok: true };
  });

  // --- 翻譯 ---
  ipcMain.handle('translate', async (_e, args) => {
    return translateUnified(args);
  });

  // 測試連線：送測試句，回傳延遲或錯誤
  ipcMain.handle('translate:test', async (_e, apiId) => {
    const fn = PROVIDER_FN[apiId];
    if (!fn) return { ok: false, error: '未知服務' };
    if (TRANSLATION_SERVICES[apiId].needsKey && !getApiKey(apiId)) {
      return { ok: false, error: '請先輸入 API Key' };
    }
    try {
      const started = Date.now();
      const out = await fn('Hello world', store.get('outputLang'), 'en-US');
      return { ok: true, latency: Date.now() - started, sample: out };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // --- API 服務狀態 / 切換 / Key ---
  ipcMain.handle('api:status', async () => {
    const list = Object.values(TRANSLATION_SERVICES).map((s) => ({
      id: s.id,
      name: s.name,
      needsKey: s.needsKey,
      configured: !s.needsKey || !!getApiKey(s.id),
      estLatency: s.estLatency,
      envKey: s.envKey,
    }));
    return {
      services: list,
      active: store.get('activeApi'),
      fallbackOrder: store.get('fallbackOrder'),
    };
  });

  ipcMain.handle('api:select', async (_e, apiId) => {
    const svc = TRANSLATION_SERVICES[apiId];
    if (!svc) return { ok: false, error: '未知服務' };
    if (svc.needsKey && !getApiKey(apiId)) {
      return { ok: false, error: '請先輸入 API Key' };
    }
    store.set('activeApi', apiId);
    return { ok: true, name: svc.name, estLatency: svc.estLatency };
  });

  ipcMain.handle('api:save-key', async (_e, { apiId, key }) => {
    if (!TRANSLATION_SERVICES[apiId]) return { ok: false, error: '未知服務' };
    const keys = store.get('apiKeys') || {};
    keys[apiId] = encryptSecret(key);
    store.set('apiKeys', keys);
    return { ok: true };
  });

  ipcMain.handle('api:get-key', async (_e, apiId) => {
    return { ok: true, key: getApiKey(apiId) };
  });

  ipcMain.handle('api:set-fallback', async (_e, order) => {
    if (Array.isArray(order)) store.set('fallbackOrder', order);
    return { ok: true, fallbackOrder: store.get('fallbackOrder') };
  });

  // --- 語言 ---
  ipcMain.handle('lang:get', async () => ({
    outputLang: store.get('outputLang'),
    recentLangs: store.get('recentLangs'),
  }));

  ipcMain.handle('lang:set', async (_e, lang) => {
    store.set('outputLang', lang);
    const recent = (store.get('recentLangs') || []).filter((l) => l !== lang);
    recent.unshift(lang);
    store.set('recentLangs', recent.slice(0, 8));
    return { ok: true };
  });

  // --- 模式 ---
  ipcMain.handle('mode:get', async () => store.get('mode'));
  ipcMain.handle('mode:set', async (_e, mode) => {
    if (mode === 'translate' || mode === 'detect') store.set('mode', mode);
    return { ok: true, mode: store.get('mode') };
  });

  // --- 偵測語言（auto / ja / en），執行中即時切換 ---
  ipcMain.handle('detect:get', async () => store.get('detectLang'));
  ipcMain.handle('detect:set', async (_e, mode) => {
    const m = ['auto', 'ja', 'en'].includes(mode) ? mode : 'auto';
    store.set('detectLang', m);
    pySend({ cmd: 'set_detect', mode: m }); // 下一句立即生效
    return { ok: true, mode: m };
  });

  // --- 設定（字型等） ---
  ipcMain.handle('settings:get', async () => ({
    subtitleFontSize: store.get('subtitleFontSize'),
    model: store.get('model'),
    mode: store.get('mode'),
    outputLang: store.get('outputLang'),
  }));
  ipcMain.handle('settings:set', async (_e, patch) => {
    for (const [k, v] of Object.entries(patch || {})) store.set(k, v);
    if (patch && patch.subtitleFontSize) {
      sendToOverlay('overlay:font', patch.subtitleFontSize);
    }
    return { ok: true };
  });

  // --- 詞庫 ---
  ipcMain.handle('glossary:get', async () => ({
    glossary: loadGlossary(),
    enabled: store.get('glossaryEnabled'),
  }));
  ipcMain.handle('glossary:set', async (_e, glossary) => {
    saveGlossary(glossary);
    return { ok: true };
  });
  ipcMain.handle('glossary:toggle', async (_e, enabled) => {
    store.set('glossaryEnabled', !!enabled);
    return { ok: true, enabled: store.get('glossaryEnabled') };
  });
  ipcMain.handle('glossary:add', async (_e, { category, source, target }) => {
    const g = loadGlossary();
    if (!g[category]) g[category] = {};
    g[category][source] = target;
    saveGlossary(g);
    return { ok: true, glossary: g };
  });
  ipcMain.handle('glossary:delete', async (_e, { category, source }) => {
    const g = loadGlossary();
    if (g[category]) delete g[category][source];
    saveGlossary(g);
    return { ok: true, glossary: g };
  });

  // --- overlay 控制 ---
  ipcMain.handle('overlay:toggle', async (_e, show) => {
    if (!overlayWindow) createOverlayWindow();
    if (show) overlayWindow.show();
    else overlayWindow.hide();
    return { ok: true, visible: !!(overlayWindow && overlayWindow.isVisible()) };
  });

  // 調整懸浮視窗大小。
  //  anchorBottom=true（內容自動撐高時）：固定底邊向上長，避免底部長出螢幕被切掉。
  //  另外一律夾在螢幕工作區內，確保整個字幕框（含底部邊界）都在畫面上。
  ipcMain.handle('overlay:resize', async (_e, { width, height, anchorBottom }) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      const w = Math.max(240, Math.round(width || 0));
      const h = Math.max(80, Math.round(height || 0));
      const [x, y] = overlayWindow.getPosition();
      const [, oldH] = overlayWindow.getSize();
      let newX = x;
      let newY = anchorBottom ? Math.round(y + (oldH - h)) : y;

      const disp = screen.getDisplayMatching({ x, y, width: w, height: h });
      const wa = disp.workArea;
      if (newX + w > wa.x + wa.width) newX = wa.x + wa.width - w;
      if (newX < wa.x) newX = wa.x;
      if (newY + h > wa.y + wa.height) newY = wa.y + wa.height - h; // 底部不超出畫面
      if (newY < wa.y) newY = wa.y;

      overlayWindow.setBounds({ x: Math.round(newX), y: Math.round(newY), width: w, height: h });
    }
    return { ok: true };
  });

  // 由 overlay 拖曳把手觸發：以 JS 方式移動懸浮視窗（不依賴 -webkit-app-region）
  ipcMain.handle('overlay:move', async (_e, { dx, dy }) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      const [x, y] = overlayWindow.getPosition();
      overlayWindow.setPosition(Math.round(x + (dx || 0)), Math.round(y + (dy || 0)));
    }
    return { ok: true };
  });

  // 點擊穿透切換：游標在把手上 → ignore=false（可互動）；離開 → ignore=true（穿透）
  ipcMain.handle('overlay:set-ignore', async (_e, ignore) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
    }
    return { ok: true };
  });
}

// ------------------------------------------------------------------
// App lifecycle
// ------------------------------------------------------------------
app.whenReady().then(() => {
  registerIpc();
  createMainWindow();
  createOverlayWindow();
  startPython();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (pyProc) { try { pySend({ cmd: 'quit' }); } catch (e) {} }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (pyProc) {
    try { pyProc.kill(); } catch (e) {}
    pyProc = null;
  }
});
