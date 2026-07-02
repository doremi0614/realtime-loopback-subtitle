'use strict';

/* ═══════════════════════════════════════════════════════════
   即時語音字幕 — renderer 前端邏輯
   ═══════════════════════════════════════════════════════════ */

// ---- 語言定義（10 種，前五顯示於工具列）----
const LANGUAGES = [
  { code: 'zh-TW', name: '繁體中文', short: '繁中' },
  { code: 'zh-CN', name: '简体中文', short: '简中' },
  { code: 'en-US', name: 'English', short: 'EN' },
  { code: 'ja-JP', name: '日本語', short: '日語' },
  { code: 'ko-KR', name: '한국어', short: '한국어' },
  { code: 'es-ES', name: 'Español', short: 'ES' },
  { code: 'fr-FR', name: 'Français', short: 'FR' },
  { code: 'de-DE', name: 'Deutsch', short: 'DE' },
  { code: 'pt-BR', name: 'Português', short: 'PT' },
  { code: 'vi-VN', name: 'Tiếng Việt', short: 'VI' },
];
const TOP_LANGS = LANGUAGES.slice(0, 5);

// ---- 狀態 ----
const state = {
  mode: 'translate',
  outputLang: 'zh-TW',
  recentLangs: ['zh-TW'],
  running: false,
  activeApiName: 'Google',
  fontSize: 24,
  overlayVisible: false,
  lines: [],       // 字幕資料 { id, lang, sourceText, text, translated, ts, cache:{lang:text} }
  selectedApiForEdit: null,
};

let lineSeq = 0;

// ---- DOM 快捷 ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ═══════════ 初始化 ═══════════
async function init() {
  const settings = await window.api.getSettings();
  state.mode = settings.mode || 'translate';
  state.outputLang = settings.outputLang || 'zh-TW';
  state.fontSize = settings.subtitleFontSize || 24;
  applyFontSize(state.fontSize);

  const langInfo = await window.api.getLang();
  state.outputLang = langInfo.outputLang || state.outputLang;
  state.recentLangs = langInfo.recentLangs || [state.outputLang];

  renderModeButtons();
  renderLangBar();
  await initDetectControl();
  bindToolbar();
  bindStatusbar();
  bindSettingsModal();
  bindKeyboard();

  await refreshDevices();
  await refreshApiChip();

  // ASR 事件訂閱
  window.api.onAsrEvent(handleAsrEvent);
}

// ═══════════ 模式 ═══════════
function renderModeButtons() {
  $$('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === state.mode);
    btn.onclick = async () => {
      state.mode = btn.dataset.mode;
      await window.api.setMode(state.mode);
      renderModeButtons();
      $('#translateAllBtn').hidden = state.mode !== 'detect';
      toast('已切換至' + (state.mode === 'translate' ? '翻譯模式' : '偵測模式'));
    };
  });
  $('#translateAllBtn').hidden = state.mode !== 'detect';
}

// ═══════════ 偵測語言選擇 ═══════════
async function initDetectControl() {
  const sel = document.getElementById('detectLangSelect');
  if (!sel) return;
  try {
    const cur = await window.api.getDetect();
    sel.value = cur || 'auto';
  } catch (e) { /* ignore */ }
  sel.onchange = async () => {
    const r = await window.api.setDetect(sel.value);
    const label = { auto: '自動（日/英）', ja: '日文', en: '英文' }[r.mode] || r.mode;
    toast('偵測語言：' + label);
  };
}

// ═══════════ 語言切換列 ═══════════
function renderLangBar() {
  const bar = $('#langBar');
  bar.innerHTML = '';

  TOP_LANGS.forEach((lang, i) => {
    const pill = document.createElement('button');
    pill.className = 'lang-pill' + (lang.code === state.outputLang ? ' active' : '');
    pill.textContent = lang.short;
    pill.title = lang.name + '（Alt+' + (i + 1) + '）';
    pill.onclick = () => switchLanguage(lang.code);
    bar.appendChild(pill);
  });

  // 更多語言下拉
  const wrap = document.createElement('div');
  wrap.className = 'more-langs';
  const moreBtn = document.createElement('button');
  moreBtn.className = 'more-btn';
  moreBtn.textContent = '+ 更多語言 ▾';
  const dropdown = document.createElement('div');
  dropdown.className = 'more-dropdown';
  dropdown.hidden = true;

  const search = document.createElement('input');
  search.className = 'more-search';
  search.placeholder = '搜尋語言…';
  const list = document.createElement('div');
  list.className = 'more-list';

  function renderMoreList(filter = '') {
    list.innerHTML = '';
    const f = filter.trim().toLowerCase();

    // 最近使用
    const recent = state.recentLangs
      .map((c) => LANGUAGES.find((l) => l.code === c))
      .filter(Boolean)
      .filter((l) => !f || l.name.toLowerCase().includes(f) || l.code.toLowerCase().includes(f));
    if (recent.length && !f) {
      const label = document.createElement('div');
      label.className = 'more-section-label';
      label.textContent = '最近使用';
      list.appendChild(label);
      recent.forEach((l) => list.appendChild(makeMoreItem(l)));
      const all = document.createElement('div');
      all.className = 'more-section-label';
      all.textContent = '全部語言';
      list.appendChild(all);
    }

    LANGUAGES
      .filter((l) => !f || l.name.toLowerCase().includes(f) || l.code.toLowerCase().includes(f))
      .forEach((l) => list.appendChild(makeMoreItem(l)));
  }

  function makeMoreItem(l) {
    const item = document.createElement('div');
    item.className = 'more-item';
    item.innerHTML = `<span>${l.name}</span><span class="code">${l.code}</span>`;
    item.onclick = () => {
      switchLanguage(l.code);
      dropdown.hidden = true;
    };
    return item;
  }

  moreBtn.onclick = (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
    if (!dropdown.hidden) { renderMoreList(); search.value = ''; search.focus(); }
  };
  search.oninput = () => renderMoreList(search.value);
  document.addEventListener('click', () => { dropdown.hidden = true; });
  dropdown.onclick = (e) => e.stopPropagation();

  dropdown.appendChild(search);
  dropdown.appendChild(list);
  wrap.appendChild(moreBtn);
  wrap.appendChild(dropdown);
  bar.appendChild(wrap);
}

async function switchLanguage(code) {
  if (code === state.outputLang) return;
  state.outputLang = code;
  await window.api.setLang(code);
  const langInfo = await window.api.getLang();
  state.recentLangs = langInfo.recentLangs;
  renderLangBar();

  const langName = LANGUAGES.find((l) => l.code === code)?.name || code;
  showLangToast(langName);
  toast('語言已切換為 ' + langName);
}

function showLangToast(langName) {
  const el = $('#langToast');
  $('#langToastText').textContent = '語言已切換為 ' + langName;
  el.hidden = false;
}

// ═══════════ 工具列/狀態列綁定 ═══════════
function bindToolbar() {
  $('#settingsBtn').onclick = () => openSettings('api');
  // 懸浮字幕：按一下開、再按一下關（toggle）
  $('#overlayToggle').onclick = async () => {
    const want = !state.overlayVisible;
    const r = await window.api.toggleOverlay(want);
    state.overlayVisible = r.visible;
    $('#overlayToggle').classList.toggle('active', r.visible);
    toast(r.visible ? '已開啟懸浮字幕' : '已關閉懸浮字幕');
  };
  $('#langToastClose').onclick = () => { $('#langToast').hidden = true; };
  $('#retranslateAllBtn').onclick = retranslateAll;
}

function bindStatusbar() {
  $('#startStopBtn').onclick = toggleRecognition;
  $('#clearBtn').onclick = () => {
    state.lines = [];
    $('#subtitleArea').innerHTML = '';
    $('#subtitleArea').appendChild($('#emptyHint') || document.createElement('div'));
    renderEmptyHint();
  };
  $('#copyBtn').onclick = copyAll;
  $('#translateAllBtn').onclick = translateAllDetect;
  $('#apiChip').onclick = () => openSettings('api');
  $('#deviceSelect').onchange = (e) => {
    state.pendingDevice = parseInt(e.target.value, 10);
  };
}

function renderEmptyHint() {
  const area = $('#subtitleArea');
  if (state.lines.length === 0 && !area.querySelector('.empty-hint')) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.id = 'emptyHint';
    hint.innerHTML = '<p>選擇音訊輸出裝置並按「開始辨識」，即可擷取系統聲音並顯示字幕。</p>';
    area.appendChild(hint);
  }
}

// ═══════════ 音訊裝置 ═══════════
async function refreshDevices() {
  await window.api.listDevices(); // 觸發 python 掃描 → 由 asr:event 'devices' 回填
}

function populateDevices(devices) {
  const sel = $('#deviceSelect');
  sel.innerHTML = '';
  if (!devices || devices.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '找不到 Loopback 裝置（請啟用立體聲混音）';
    sel.appendChild(opt);
    toast('找不到 Loopback 裝置，請在 Windows 音效設定啟用「立體聲混音」，或安裝 PyAudioWPatch', 'warn');
    return;
  }
  devices.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d.index;
    opt.textContent = (d.is_default ? '★ ' : '') + d.name + '  [Loopback]';
    sel.appendChild(opt);
  });
  // 預設選第一個或 default
  const def = devices.find((d) => d.is_default) || devices[0];
  sel.value = def.index;
  state.pendingDevice = def.index;
}

// ═══════════ 開始/停止辨識 ═══════════
async function toggleRecognition() {
  if (state.running) {
    await window.api.stopAsr();
    setRunning(false);
    return;
  }
  const sel = $('#deviceSelect');
  const device = parseInt(sel.value, 10);
  if (isNaN(device)) { toast('請先選擇音訊裝置', 'error'); return; }

  const r = await window.api.startAsr({ device });
  if (!r.ok) { toast(r.error || '啟動失敗', 'error'); return; }
  setRunning(true);
  toast('開始擷取系統音訊…');
}

function setRunning(running) {
  state.running = running;
  const btn = $('#startStopBtn');
  btn.textContent = running ? '停止辨識' : '開始辨識';
  btn.dataset.running = running ? 'true' : 'false';
  if (!running) setStatusLight('stopped', '停止');
}

// ═══════════ 狀態燈 / 音量 ═══════════
function setStatusLight(stateName, text) {
  $('#statusLight').dataset.state = stateName;
  $('#statusText').textContent = text;
}

const volCanvas = () => $('#volumeMeter');
const volHistory = new Array(30).fill(0);
function drawVolume(level) {
  volHistory.push(Math.max(0, Math.min(1, level)));
  volHistory.shift();
  const c = volCanvas();
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const barW = c.width / volHistory.length;
  for (let i = 0; i < volHistory.length; i++) {
    const h = volHistory[i] * c.height;
    ctx.fillStyle = volHistory[i] > 0.6 ? '#f0a020' : '#35c46b';
    ctx.fillRect(i * barW, c.height - h, barW - 1, h);
  }
}

// ═══════════ ASR 事件處理 ═══════════
function handleAsrEvent(msg) {
  switch (msg.type) {
    case 'ready':
      break;
    case 'devices':
      populateDevices(msg.devices);
      break;
    case 'model_loading':
      setStatusLight('recognizing', '載入模型…');
      break;
    case 'model_ready':
      toast('模型已就緒：' + msg.model + '（' + msg.device + '）', 'success');
      break;
    case 'volume':
      drawVolume(msg.level);
      break;
    case 'status':
      handleStatusEvent(msg.state);
      break;
    case 'segment':
      if (state.mode === 'detect') addDetectLine(msg);
      break;
    case 'translating':
      // 翻譯模式：顯示 Loading 佔位
      addTranslatingPlaceholder(msg.ref);
      break;
    case 'translated':
      fillTranslatedLine(msg);
      break;
    case 'translate_failed':
      fillFailedLine(msg);
      break;
    case 'error':
      toast('錯誤（' + msg.where + '）：' + msg.message, 'error');
      break;
  }
}

function handleStatusEvent(s) {
  const map = {
    listening: ['listening', '辨識中'],
    recognizing: ['recognizing', '翻譯中'],
    reconnecting: ['reconnecting', '重新連線中…'],
    stopped: ['stopped', '停止'],
  };
  const [light, text] = map[s] || ['stopped', s];
  setStatusLight(light, text);
  if (s === 'reconnecting') toast('音訊中斷，重新連線中…', 'warn');
}

// ═══════════ 字幕：翻譯模式 ═══════════
function removeEmptyHint() {
  const hint = $('#subtitleArea .empty-hint');
  if (hint) hint.remove();
}

function addTranslatingPlaceholder(ref) {
  removeEmptyHint();
  const id = 'line-' + ref;
  if (document.getElementById(id)) return;
  const line = document.createElement('div');
  line.className = 'subtitle-line';
  line.id = id;
  line.innerHTML = `
    <span class="lang-tag">…</span>
    <div class="subtitle-body">
      <div class="subtitle-text"><span class="loading-spinner"></span>翻譯中…</div>
    </div>
    <span class="timestamp">${nowHM()}</span>`;
  $('#subtitleArea').appendChild(line);
  scrollToBottom();
}

function fillTranslatedLine(msg) {
  removeEmptyHint();
  const id = 'line-' + msg.ref;
  let line = document.getElementById(id);
  if (!line) {
    line = document.createElement('div');
    line.className = 'subtitle-line';
    line.id = id;
    $('#subtitleArea').appendChild(line);
  }
  const langTag = shortLangTag(msg.sourceLang);
  line.innerHTML = `
    <span class="lang-tag">${langTag}</span>
    <div class="subtitle-body">
      <div class="subtitle-text">${escapeHtml(msg.text)}</div>
      <div class="subtitle-source">${renderSource(msg.sourceText, msg.furigana)}</div>
      ${msg.fellBack ? `<div class="badge-fallback">↓ 已降級至 ${escapeHtml(msg.usedApiName)}</div>` : ''}
    </div>
    <span class="timestamp">${fmtTs(msg.ts)}</span>`;
  state.lines.push({ id, ...msg });
  if (msg.learned && msg.learned.length) {
    msg.learned.forEach((w) => toast('已記住：' + w, 'success'));
  }
  scrollToBottom();
}

function fillFailedLine(msg) {
  removeEmptyHint();
  const id = 'line-' + msg.ref;
  let line = document.getElementById(id);
  if (!line) {
    line = document.createElement('div');
    line.className = 'subtitle-line';
    line.id = id;
    $('#subtitleArea').appendChild(line);
  }
  line.innerHTML = `
    <span class="lang-tag">!</span>
    <div class="subtitle-body">
      <div class="subtitle-text">${escapeHtml(msg.sourceText)}</div>
      <div class="badge-fail">[翻譯失敗] ${escapeHtml(msg.error || '')}</div>
    </div>
    <span class="timestamp">${nowHM()}</span>`;
  scrollToBottom();
}

// ═══════════ 字幕：偵測模式 ═══════════
function addDetectLine(msg) {
  removeEmptyHint();
  const id = 'line-' + (++lineSeq) + '-' + msg.start_ts;
  const lineData = { id, lang: msg.lang, sourceText: msg.text, ts: msg.end_ts, cache: {} };
  state.lines.push(lineData);

  const line = document.createElement('div');
  line.className = 'subtitle-line';
  line.id = id;
  line.innerHTML = `
    <span class="lang-tag">${shortLangTag(msg.lang)}</span>
    <div class="subtitle-body">
      <div class="subtitle-text">${renderSource(msg.text, msg.furigana)}</div>
      <div class="subtitle-meta">
        <button class="translate-btn">▶ 翻譯</button>
      </div>
    </div>
    <span class="timestamp">${fmtTs(msg.end_ts)}</span>`;
  const btn = line.querySelector('.translate-btn');
  btn.onclick = () => toggleLineTranslation(lineData, line, btn);
  $('#subtitleArea').appendChild(line);
  scrollToBottom();
}

async function toggleLineTranslation(lineData, lineEl, btn) {
  const targetLang = state.outputLang;
  const existing = lineEl.querySelector('.translation-result');

  // 若已有此語言的結果 → 收合/展開切換
  if (existing && existing.dataset.lang === targetLang) {
    existing.remove();
    return;
  }
  if (existing) existing.remove();

  // 快取命中
  if (lineData.cache[targetLang]) {
    renderLineTranslation(lineEl, targetLang, lineData.cache[targetLang]);
    return;
  }

  // Loading
  const loading = document.createElement('div');
  loading.className = 'translation-result';
  loading.dataset.lang = targetLang;
  loading.innerHTML = '<span class="loading-spinner"></span>翻譯中…';
  lineEl.querySelector('.subtitle-body').appendChild(loading);

  const r = await window.api.translate({ text: lineData.sourceText, targetLang, sourceLang: lineData.lang });
  loading.remove();
  if (r.ok) {
    lineData.cache[targetLang] = r.translated;
    renderLineTranslation(lineEl, targetLang, r.translated);
    if (r.learned && r.learned.length) r.learned.forEach((w) => toast('已記住：' + w, 'success'));
  } else {
    const fail = document.createElement('div');
    fail.className = 'translation-result';
    fail.innerHTML = `<span class="badge-fail">[翻譯失敗] ${escapeHtml(r.error || '')}</span>`;
    lineEl.querySelector('.subtitle-body').appendChild(fail);
  }
}

function renderLineTranslation(lineEl, lang, text) {
  const div = document.createElement('div');
  div.className = 'translation-result';
  div.dataset.lang = lang;
  div.textContent = text;
  lineEl.querySelector('.subtitle-body').appendChild(div);
}

// 批次翻譯（偵測模式）
async function translateAllDetect() {
  const targetLang = state.outputLang;
  const pending = state.lines.filter((l) => l.cache && !l.cache[targetLang]);
  if (pending.length === 0) { toast('沒有需要翻譯的句子'); return; }

  let done = 0;
  const btn = $('#translateAllBtn');
  btn.textContent = `翻譯中 0 / ${pending.length}…`;

  await Promise.all(pending.map(async (lineData) => {
    const lineEl = document.getElementById(lineData.id);
    const r = await window.api.translate({ text: lineData.sourceText, targetLang, sourceLang: lineData.lang });
    done++;
    btn.textContent = `翻譯中 ${done} / ${pending.length}…`;
    if (r.ok && lineEl) {
      lineData.cache[targetLang] = r.translated;
      const existing = lineEl.querySelector('.translation-result');
      if (existing) existing.remove();
      renderLineTranslation(lineEl, targetLang, r.translated);
    }
  }));

  btn.textContent = '翻譯全部';
  toast('批次翻譯完成（' + pending.length + ' 句）', 'success');
}

// 重新翻譯全部（翻譯模式，切換語言後）
async function retranslateAll() {
  $('#langToast').hidden = true;
  const targetLang = state.outputLang;
  const lines = state.lines.filter((l) => l.sourceText);
  if (lines.length === 0) return;
  toast('開始重新翻譯 ' + lines.length + ' 句…');
  await Promise.all(lines.map(async (l) => {
    const r = await window.api.translate({ text: l.sourceText, targetLang, sourceLang: l.lang || l.sourceLang });
    if (r.ok) {
      const el = document.getElementById(l.id);
      if (el) {
        const textEl = el.querySelector('.subtitle-text');
        if (textEl) textEl.textContent = r.translated;
        l.text = r.translated;
      }
    }
  }));
  toast('重新翻譯完成', 'success');
}

// ═══════════ 複製 ═══════════
function copyAll() {
  const text = state.lines.map((l) => {
    if (state.mode === 'translate') return (l.text || l.sourceText || '');
    return l.sourceText + (l.cache && l.cache[state.outputLang] ? '\n  → ' + l.cache[state.outputLang] : '');
  }).join('\n');
  navigator.clipboard.writeText(text).then(
    () => toast('已複製全部字幕', 'success'),
    () => toast('複製失敗', 'error')
  );
}

// ═══════════ 設定 Modal ═══════════
function bindSettingsModal() {
  $('#settingsClose').onclick = closeSettings;
  $('#settingsModal').onclick = (e) => { if (e.target.id === 'settingsModal') closeSettings(); };
  $$('.tab-btn').forEach((btn) => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });

  // Key 編輯
  $('#toggleKeyVisibility').onclick = () => {
    const inp = $('#apiKeyInput');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    $('#toggleKeyVisibility').textContent = inp.type === 'password' ? '顯示' : '隱藏';
  };
  $('#saveKeyBtn').onclick = saveCurrentKey;
  $('#testKeyBtn').onclick = testCurrentApi;

  // 詞庫
  $('#glossaryEnabled').onchange = async (e) => {
    await window.api.toggleGlossary(e.target.checked);
    toast(e.target.checked ? '詞庫已啟用' : '詞庫已停用');
  };
  $('#addGlossaryBtn').onclick = addGlossaryEntry;
  $('#exportGlossaryBtn').onclick = exportGlossary;
  $('#importGlossaryBtn').onclick = () => $('#glossaryFileInput').click();
  $('#glossaryFileInput').onchange = importGlossary;

  // 一般
  $('#modelSelect').onchange = async (e) => {
    await window.api.setSettings({ model: e.target.value });
    await window.api.loadModel(e.target.value);
    toast('已切換模型為 ' + e.target.value);
  };
  $('#fontMinus').onclick = () => changeFont(-2);
  $('#fontPlus').onclick = () => changeFont(2);
}

function openSettings(tab) {
  $('#settingsModal').hidden = false;
  switchTab(tab || 'api');
  loadApiPanel();
  loadGlossaryPanel();
  loadGeneralPanel();
}
function closeSettings() { $('#settingsModal').hidden = true; }
function switchTab(tab) {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.tab === tab));
}

// ---- API 面板 ----
async function loadApiPanel() {
  const status = await window.api.apiStatus();
  const list = $('#apiList');
  list.innerHTML = '';

  const DESC = {
    google: '速度快、支援 130+ 語言',
    deepl: '歐語品質最佳、語境理解強',
    libre: '完全開源免費，可本地自架',
    claude: '語境最準、人名處理最佳',
  };

  status.services.forEach((svc) => {
    const item = document.createElement('div');
    item.className = 'api-item' + (svc.id === status.active ? ' active' : '');
    item.innerHTML = `
      <span class="api-radio"></span>
      <div class="api-info">
        <div class="api-name">${svc.name}</div>
        <div class="api-desc">${DESC[svc.id] || ''}</div>
      </div>
      <span class="api-status ${svc.configured ? 'ok' : 'no'}">${svc.configured ? '已設定 ✔' : '未設定'}</span>
      <span class="api-latency">${svc.configured ? '~' + svc.estLatency + 'ms' : ''}</span>`;
    item.onclick = () => onApiItemClick(svc, status.active);
    list.appendChild(item);
  });

  renderFallbackList(status.fallbackOrder, status.services);
}

async function onApiItemClick(svc, activeId) {
  // 已設定 → 直接切換；未設定 → 展開 Key 輸入
  if (svc.configured) {
    const r = await window.api.selectApi(svc.id);
    if (r.ok) {
      state.activeApiName = r.name;
      await refreshApiChip();
      await loadApiPanel();
      toast(`已切換至 ${r.name}（${r.estLatency}ms）`, 'success');
    } else {
      toast(r.error, 'error');
    }
  }
  // 展開 Key 編輯器（供修改或首次輸入）
  openKeyEditor(svc);
}

async function openKeyEditor(svc) {
  state.selectedApiForEdit = svc.id;
  const editor = $('#apiKeyEditor');
  editor.hidden = false;
  $('#apiKeyLabel').textContent = svc.name + ' API Key' + (svc.needsKey ? '' : '（此服務無需 Key）');
  $('#apiKeyInput').disabled = !svc.needsKey;
  $('#apiKeyInput').value = '';
  $('#keyNote').textContent = svc.envKey ? ('環境變數：' + svc.envKey) : '';
  if (svc.needsKey) {
    const r = await window.api.getApiKey(svc.id);
    if (r.key) $('#apiKeyInput').value = r.key;
  }
}

async function saveCurrentKey() {
  const apiId = state.selectedApiForEdit;
  if (!apiId) return;
  const key = $('#apiKeyInput').value.trim();
  await window.api.saveApiKey(apiId, key);
  toast('已儲存 API Key（AES 加密）', 'success');
  await loadApiPanel();
  await refreshApiChip();
}

async function testCurrentApi() {
  const apiId = state.selectedApiForEdit;
  if (!apiId) return;
  // 先暫存輸入的 key 再測試
  const key = $('#apiKeyInput').value.trim();
  if (key) await window.api.saveApiKey(apiId, key);
  $('#testKeyBtn').textContent = '測試中…';
  const r = await window.api.testApi(apiId);
  $('#testKeyBtn').textContent = '測試連線';
  if (r.ok) {
    toast(`連線成功（${r.latency}ms）：${r.sample}`, 'success');
    await loadApiPanel();
  } else {
    toast('連線失敗：' + r.error, 'error');
  }
}

function renderFallbackList(order, services) {
  const ol = $('#fallbackList');
  ol.innerHTML = '';
  const nameMap = {};
  services.forEach((s) => (nameMap[s.id] = s.name));
  order.forEach((id, idx) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${nameMap[id] || id}</span>
      <span class="reorder">
        <button ${idx === 0 ? 'disabled' : ''} data-dir="up">▲</button>
        <button ${idx === order.length - 1 ? 'disabled' : ''} data-dir="down">▼</button>
      </span>`;
    li.querySelectorAll('button').forEach((b) => {
      b.onclick = async () => {
        const newOrder = [...order];
        const swap = b.dataset.dir === 'up' ? idx - 1 : idx + 1;
        [newOrder[idx], newOrder[swap]] = [newOrder[swap], newOrder[idx]];
        await window.api.setFallback(newOrder);
        await loadApiPanel();
      };
    });
    ol.appendChild(li);
  });
}

async function refreshApiChip() {
  const status = await window.api.apiStatus();
  const active = status.services.find((s) => s.id === status.active);
  state.activeApiName = active ? active.name : 'Google';
  $('#apiChip').textContent = state.activeApiName;
}

// ---- 詞庫面板 ----
async function loadGlossaryPanel() {
  const { glossary, enabled } = await window.api.getGlossary();
  $('#glossaryEnabled').checked = enabled;
  renderGlossaryTable(glossary);
}

function renderGlossaryTable(glossary) {
  const table = $('#glossaryTable');
  table.innerHTML = '';
  for (const cat of Object.keys(glossary)) {
    for (const [src, dst] of Object.entries(glossary[cat])) {
      const row = document.createElement('div');
      row.className = 'gloss-row';
      row.innerHTML = `
        <span class="gloss-cat">${cat}</span>
        <span>${escapeHtml(src)}</span>
        <span>${escapeHtml(dst)}</span>
        <button class="gloss-del">✕</button>`;
      row.querySelector('.gloss-del').onclick = async () => {
        const r = await window.api.deleteGlossary({ category: cat, source: src });
        renderGlossaryTable(r.glossary);
      };
      table.appendChild(row);
    }
  }
}

async function addGlossaryEntry() {
  const category = $('#glossaryCategory').value;
  const source = $('#glossarySource').value.trim();
  const target = $('#glossaryTarget').value.trim();
  if (!source || !target) { toast('請填寫原詞與翻譯', 'error'); return; }
  const r = await window.api.addGlossary({ category, source, target });
  $('#glossarySource').value = '';
  $('#glossaryTarget').value = '';
  renderGlossaryTable(r.glossary);
  toast('已新增詞條', 'success');
}

async function exportGlossary() {
  const { glossary } = await window.api.getGlossary();
  const blob = new Blob([JSON.stringify(glossary, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'glossary.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('已匯出詞庫', 'success');
}

function importGlossary(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const g = JSON.parse(reader.result);
      await window.api.setGlossary(g);
      renderGlossaryTable(g);
      toast('已匯入詞庫', 'success');
    } catch (err) {
      toast('匯入失敗：JSON 格式錯誤', 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ---- 一般面板 ----
async function loadGeneralPanel() {
  const settings = await window.api.getSettings();
  $('#modelSelect').value = settings.model || 'small';
  $('#fontSizeLabel').textContent = (settings.subtitleFontSize || 24) + 'px';
}

// ═══════════ 字型大小 ═══════════
function applyFontSize(px) {
  state.fontSize = Math.max(14, Math.min(48, px));
  document.documentElement.style.setProperty('--subtitle-size', state.fontSize + 'px');
  const label = $('#fontSizeLabel');
  if (label) label.textContent = state.fontSize + 'px';
}
async function changeFont(delta) {
  applyFontSize(state.fontSize + delta);
  await window.api.setSettings({ subtitleFontSize: state.fontSize });
}

// ═══════════ 鍵盤快捷 ═══════════
function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    // Alt+1~5 切換工具列語言
    if (e.altKey && !e.ctrlKey && e.key >= '1' && e.key <= '5') {
      e.preventDefault();
      const idx = parseInt(e.key, 10) - 1;
      if (TOP_LANGS[idx]) switchLanguage(TOP_LANGS[idx].code);
    }
    // Ctrl +/- 調整字幕大小
    if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); changeFont(2); }
    if (e.ctrlKey && e.key === '-') { e.preventDefault(); changeFont(-2); }
  });
}

// ═══════════ Toast ═══════════
function toast(text, type = '') {
  const stack = $('#toastStack');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = text;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// ═══════════ 工具函式 ═══════════
function scrollToBottom() {
  const area = $('#subtitleArea');
  area.scrollTop = area.scrollHeight;
}
function shortLangTag(lang) {
  const map = { zh: 'ZH', en: 'EN', ja: 'JA', ko: 'KO', es: 'ES', fr: 'FR', de: 'DE', pt: 'PT', vi: 'VI' };
  const key = (lang || '').split('-')[0].toLowerCase();
  return map[key] || (lang || '?').toUpperCase().slice(0, 3);
}
function fmtTs(ms) {
  if (!ms) return nowHM();
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function nowHM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// 日文假名注音：把 [{t,r}] 轉為 <ruby>漢字<rt>かんじ</rt></ruby>（XSS 安全）
function renderFurigana(tokens) {
  if (!Array.isArray(tokens)) return '';
  return tokens.map((tok) => {
    const t = escapeHtml(tok.t);
    return tok.r ? `<ruby>${t}<rt>${escapeHtml(tok.r)}</rt></ruby>` : t;
  }).join('');
}
// 依語言/注音決定原文顯示：日文有注音→ruby，其餘→純文字
function renderSource(text, furigana) {
  return (furigana && furigana.length) ? renderFurigana(furigana) : escapeHtml(text);
}

// ═══════════ 啟動 ═══════════
window.addEventListener('DOMContentLoaded', init);
