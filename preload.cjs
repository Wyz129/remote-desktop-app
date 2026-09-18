'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => { const listener = (_, value) => callback(value); ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener); };
contextBridge.exposeInMainWorld('remoteDesktop', {
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  saveSettings: patch => ipcRenderer.invoke('app:save-settings', patch),
  choosePrivateKey: () => ipcRenderer.invoke('app:choose-private-key'),
  quitFullscreen: () => ipcRenderer.invoke('app:quit-fullscreen'),
  connect: input => ipcRenderer.invoke('ssh:connect', input),
  disconnect: () => ipcRenderer.invoke('ssh:disconnect'),
  discoverDesktop: create => ipcRenderer.invoke('ssh:discover-desktop', create),
  list: remotePath => ipcRenderer.invoke('ssh:list', remotePath),
  image: remotePath => ipcRenderer.invoke('ssh:image', remotePath),
  download: (remotePath, id) => ipcRenderer.invoke('ssh:download', remotePath, id),
  cancelDownload: id => ipcRenderer.invoke('ssh:cancel-download', id),
  openLocal: filePath => ipcRenderer.invoke('ssh:open-local', filePath),
  send: message => ipcRenderer.send('desktop:send', message),
  onMessage: callback => subscribe('desktop:message', callback),
  onDownloadProgress: callback => subscribe('download:progress', callback)
});
