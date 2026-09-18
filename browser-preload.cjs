'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('serverBrowser', {
  call: async (action, payload = {}) => { const result = await ipcRenderer.invoke('browser:call', { action, payload }); if (!result.ok) throw new Error(result.error); return result.value; },
  onEvent: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('browser:event', listener); return () => ipcRenderer.removeListener('browser:event', listener); }
});
