'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// メイン画面には必要最小限の操作だけを公開する。
contextBridge.exposeInMainWorld('postclip', {
  settings: () => ipcRenderer.invoke('settings'),
  paste: () => ipcRenderer.invoke('paste-url'),
  capture: input => ipcRenderer.invoke('capture', input),
  cancel: () => ipcRenderer.invoke('cancel'),
  save: () => ipcRenderer.invoke('save-png'),
  copy: () => ipcRenderer.invoke('copy-image'),
  openX: url => ipcRenderer.invoke('open-x', url),
  openSource: () => ipcRenderer.invoke('open-source'),
  clearLogin: () => ipcRenderer.invoke('clear-x-data'),
  onProgress: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('capture-progress', listener); return () => ipcRenderer.removeListener('capture-progress', listener); }
});
