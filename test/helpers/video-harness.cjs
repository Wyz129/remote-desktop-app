'use strict';
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 860, height: 560, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await window.loadFile(process.env.REMOTE_DESKTOP_VIDEO_TEST_HTML);
}).catch(error => { console.error(error); app.exit(1); });
