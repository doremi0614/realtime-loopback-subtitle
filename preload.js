'use strict';

/**
 * preload.js — 以 contextBridge 暴露安全的 API 給 renderer / overlay。
 * renderer 與 overlay 共用此 preload；各自只用到需要的部分。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ---- ASR / 音訊 ----
  listDevices: () => ipcRenderer.invoke('asr:list-devices'),
  startAsr: (opts) => ipcRenderer.invoke('asr:start', opts),
  stopAsr: () => ipcRenderer.invoke('asr:stop'),
  loadModel: (model) => ipcRenderer.invoke('asr:load-model', model),

  // ---- 翻譯 ----
  translate: (args) => ipcRenderer.invoke('translate', args),
  testApi: (apiId) => ipcRenderer.invoke('translate:test', apiId),

  // ---- API 切換器 ----
  apiStatus: () => ipcRenderer.invoke('api:status'),
  selectApi: (apiId) => ipcRenderer.invoke('api:select', apiId),
  saveApiKey: (apiId, key) => ipcRenderer.invoke('api:save-key', { apiId, key }),
  getApiKey: (apiId) => ipcRenderer.invoke('api:get-key', apiId),
  setFallback: (order) => ipcRenderer.invoke('api:set-fallback', order),

  // ---- 語言 ----
  getLang: () => ipcRenderer.invoke('lang:get'),
  setLang: (lang) => ipcRenderer.invoke('lang:set', lang),

  // ---- 模式 ----
  getMode: () => ipcRenderer.invoke('mode:get'),
  setMode: (mode) => ipcRenderer.invoke('mode:set', mode),

  // ---- 偵測語言 ----
  getDetect: () => ipcRenderer.invoke('detect:get'),
  setDetect: (mode) => ipcRenderer.invoke('detect:set', mode),

  // ---- 設定 ----
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // ---- 詞庫 ----
  getGlossary: () => ipcRenderer.invoke('glossary:get'),
  setGlossary: (g) => ipcRenderer.invoke('glossary:set', g),
  toggleGlossary: (enabled) => ipcRenderer.invoke('glossary:toggle', enabled),
  addGlossary: (entry) => ipcRenderer.invoke('glossary:add', entry),
  deleteGlossary: (entry) => ipcRenderer.invoke('glossary:delete', entry),

  // ---- overlay ----
  toggleOverlay: (show) => ipcRenderer.invoke('overlay:toggle', show),
  resizeOverlay: (width, height, anchorBottom) => ipcRenderer.invoke('overlay:resize', { width, height, anchorBottom }),
  moveOverlay: (dx, dy) => ipcRenderer.invoke('overlay:move', { dx, dy }),
  setOverlayIgnore: (ignore) => ipcRenderer.invoke('overlay:set-ignore', ignore),

  // ---- 事件訂閱 ----
  onAsrEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('asr:event', listener);
    return () => ipcRenderer.removeListener('asr:event', listener);
  },
  onOverlaySubtitle: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('overlay:subtitle', listener);
    return () => ipcRenderer.removeListener('overlay:subtitle', listener);
  },
  onOverlayFont: (cb) => {
    const listener = (_e, size) => cb(size);
    ipcRenderer.on('overlay:font', listener);
    return () => ipcRenderer.removeListener('overlay:font', listener);
  },
});
