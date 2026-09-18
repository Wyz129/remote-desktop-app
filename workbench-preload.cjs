'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('workbench', Object.freeze({
  call: (action, payload = {}) => ipcRenderer.invoke('workbench:call', { action, payload }),
  onEvent: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('workbench:event', listener); return () => ipcRenderer.removeListener('workbench:event', listener); }
}));
