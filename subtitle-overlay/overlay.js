'use strict';

/**
 * overlay.js — 懸浮字幕視窗邏輯
 *  - 接收主程序推送的字幕，滑入顯示，並自動調整視窗高度避免被切掉
 *  - 拖曳把手（框下方）：拖曳 = 移動視窗；點一下 = 顯示目前視窗範圍
 *  - 右下角把手：拖曳改變視窗大小
 *  - 點擊穿透：整個視窗滑鼠事件穿透到背後（影片），只有把手/改變大小把手可互動
 */

const rootEl = document.getElementById('overlayRoot');
const captionEl = document.getElementById('caption');
const grip = document.getElementById('dragGrip');
const resizeHandle = document.getElementById('resizeHandle');
let hideTimer = null;
let boundsTimer = null;

function shortLangTag(lang) {
  const map = { zh: 'ZH', en: 'EN', ja: 'JA', ko: 'KO', es: 'ES', fr: 'FR', de: 'DE', pt: 'PT', vi: 'VI' };
  const key = (lang || '').split('-')[0].toLowerCase();
  return map[key] || (lang || '').toUpperCase().slice(0, 3);
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderFurigana(tokens) {
  if (!Array.isArray(tokens)) return '';
  return tokens.map((tok) => {
    const t = escapeHtml(tok.t);
    return tok.r ? `<ruby>${t}<rt>${escapeHtml(tok.r)}</rt></ruby>` : t;
  }).join('');
}
function renderSource(text, furigana) {
  return (furigana && furigana.length) ? renderFurigana(furigana) : escapeHtml(text);
}

// 依字幕內容自動調整視窗高度，避免底部被切
function fitHeight() {
  requestAnimationFrame(() => {
    // 取 offset / scroll 較大者，涵蓋假名注音(ruby)增加的行高
    const capH = Math.max(captionEl.offsetHeight || 0, captionEl.scrollHeight || 0);
    // 字幕 + 控制列(32) + padding(上10 下14) + 充足緩衝
    const desired = Math.max(118, capH + 40 + 10 + 14 + 24);
    // anchorBottom=true：固定底邊向上長，避免底部長出螢幕被切
    window.api.resizeOverlay(window.innerWidth, desired, true);
  });
}

function showCaption(payload) {
  const tag = shortLangTag(payload.sourceLang || payload.targetLang);
  const mainHtml = payload.type === 'translated'
    ? escapeHtml(payload.text)
    : renderSource(payload.text, payload.furigana);
  let html = `<span class="tag">[${tag}]</span>${mainHtml}`;
  if (payload.type === 'translated' && payload.sourceText) {
    html += `<span class="src">${renderSource(payload.sourceText, payload.furigana)}</span>`;
  }
  captionEl.innerHTML = html;

  captionEl.classList.remove('show');
  void captionEl.offsetWidth; // reflow → 重新觸發滑入動畫
  captionEl.classList.add('show');
  fitHeight();

  if (hideTimer) clearTimeout(hideTimer);
  const dwell = Math.min(9000, 3000 + (payload.text || '').length * 90);
  hideTimer = setTimeout(() => captionEl.classList.remove('show'), dwell);
}

// ─────────── 點擊穿透控制 ───────────
// 視窗預設忽略滑鼠（穿透）；游標移到把手上才暫時接管，離開後恢復穿透。
let overInteractive = false;
let interacting = false; // 拖曳或改變大小進行中

function setIgnore(ignore) {
  try { window.api.setOverlayIgnore(ignore); } catch (e) { /* preview 無 api */ }
}
function onEnterInteractive() { overInteractive = true; setIgnore(false); }
function onLeaveInteractive() { overInteractive = false; if (!interacting) setIgnore(true); }

[grip, resizeHandle].forEach((el) => {
  el.addEventListener('mouseenter', onEnterInteractive);
  el.addEventListener('mouseleave', onLeaveInteractive);
});

// ─────────── 拖曳移動 / 點一下顯示範圍 ───────────
let moving = false, moved = false, lastX = 0, lastY = 0;

grip.addEventListener('mousedown', (e) => {
  moving = true; moved = false; interacting = true;
  lastX = e.screenX; lastY = e.screenY;
  e.preventDefault();
});

function showBounds() {
  rootEl.classList.add('show-bounds');
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => rootEl.classList.remove('show-bounds'), 2500);
}

// ─────────── 改變大小 ───────────
let resizing = false, startX = 0, startY = 0, startW = 0, startH = 0;

resizeHandle.addEventListener('mousedown', (e) => {
  resizing = true; interacting = true;
  startX = e.screenX; startY = e.screenY;
  startW = window.innerWidth; startH = window.innerHeight;
  e.preventDefault(); e.stopPropagation();
});

window.addEventListener('mousemove', (e) => {
  if (resizing) {
    const w = startW + (e.screenX - startX);
    const h = startH + (e.screenY - startY);
    window.api.resizeOverlay(w, h);
    return;
  }
  if (moving) {
    const dx = e.screenX - lastX;
    const dy = e.screenY - lastY;
    if (dx || dy) moved = true;
    lastX = e.screenX; lastY = e.screenY;
    window.api.moveOverlay(dx, dy);
  }
});

window.addEventListener('mouseup', () => {
  if (moving && !moved) showBounds(); // 點一下（未拖動）→ 顯示視窗範圍
  moving = false;
  resizing = false;
  interacting = false;
  // 拖曳/改變大小結束後，若游標已離開把手則恢復穿透
  if (!overInteractive) setIgnore(true);
});

// ─────────── 字型大小同步 ───────────
window.api.onOverlayFont((size) => {
  captionEl.style.fontSize = Math.max(18, Math.min(56, size + 6)) + 'px';
  fitHeight();
});

// ─────────── 字幕推送 ───────────
window.api.onOverlaySubtitle((payload) => {
  if (!payload || !payload.text) return;
  showCaption(payload);
});
