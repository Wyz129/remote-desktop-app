'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('localPicker', Object.freeze({
  select: () => ipcRenderer.invoke('local-picker:action', 'select'),
  cancel: () => ipcRenderer.invoke('local-picker:action', 'cancel'),
  onState: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('local-picker:state', listener); return () => ipcRenderer.removeListener('local-picker:state', listener); }
}));
