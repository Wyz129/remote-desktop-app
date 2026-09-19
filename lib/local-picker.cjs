'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const CHANNEL = 'local-picker:action';
const ROOT = path.resolve(__dirname, '..');
const PICKER_PAGE = path.join(ROOT, 'app', 'local-picker.html');
const PICKER_URL = pathToFileURL(PICKER_PAGE).href;

class LocalPicker {
  constructor({ app, dialog, getParent }, runtime = {}) {
    this.app = app; this.dialog = dialog; this.getParent = getParent; this.runtime = runtime;
    this.child = null; this.pending = null; this.cancel = null; this.generation = 0;
  }
  choose(kind) {
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.pending = this._choose(kind, generation).finally(() => { this.pending = null; });
    return this.pending;
  }
  async _choose(kind, generation) {
    if (kind && !['files', 'directory'].includes(kind)) throw new Error('无效的本地选择方式。');
    const parent = this.getParent();
    if ((this.runtime.platform || process.platform) !== 'win32' || kind) {
      const result = await this.dialog.showOpenDialog(parent, { title: '选择上传文件或文件夹', properties: kind === 'directory' ? ['openDirectory', 'multiSelections'] : kind === 'files' ? ['openFile', 'multiSelections'] : ['openFile', 'openDirectory', 'multiSelections'] });
      return result.canceled || generation !== this.generation ? [] : result.filePaths;
    }
    return this._explorer(parent);
  }
  _explorer(parent) {
    const { BrowserWindow, ipcMain } = this.runtime.electron || require('electron');
    const spawnProcess = this.runtime.spawn || spawn;
    const directory = this.app.isPackaged ? path.join(process.resourcesPath, 'native-picker') : path.join(ROOT, 'scripts', 'native-picker');
    return new Promise((resolve, reject) => {
      let child, panel, capturedHandle, timer, launchTimer, output = '', stderr = '', settled = false, selecting = false;
      const restoreParent = Boolean(parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized());
      let minimizedParent = false;
      const state = (text, ready = false) => { if (panel && !panel.isDestroyed()) panel.webContents.send('local-picker:state', { text, ready }); };
      const finish = (error, paths = []) => {
        if (settled) return; settled = true; clearInterval(timer); clearTimeout(launchTimer);
        if (this.cancel === cancel) this.cancel = null;
        ipcMain.removeHandler(CHANNEL); parent?.removeListener('closed', cancel);
        if (child && !child.killed) { child.stdin?.end('cancel\n'); child.kill(); }
        if (this.child === child) this.child = null;
        if (panel && !panel.isDestroyed()) panel.destroy();
        if (restoreParent && minimizedParent && parent && !parent.isDestroyed()) { parent.restore(); parent.focus(); }
        error ? reject(error) : resolve(paths);
      };
      const cancel = () => finish(null);
      this.cancel = cancel;
      const fail = message => finish(new Error(`无法完成本地项目选择：${message}`));
      try {
        panel = new BrowserWindow({ width: 470, height: 220, minWidth: 420, minHeight: 190, resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true, show: false, autoHideMenuBar: true, title: '选择上传项目',
          webPreferences: { preload: path.join(ROOT, 'app', 'local-picker-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, partition: `local-picker-${crypto.randomUUID()}` } });
        const contents = panel.webContents;
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        contents.on('will-navigate', event => event.preventDefault());
        contents.on('will-attach-webview', event => event.preventDefault());
        contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        contents.session.setPermissionCheckHandler(() => false);
        const allowed = new Set(['local-picker.html', 'local-picker.js', 'local-picker.css'].map(name => pathToFileURL(path.join(ROOT, 'app', name)).href));
        contents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback({ cancel: !allowed.has(details.url) }));
        ipcMain.handle(CHANNEL, (event, action) => {
          if (settled || event.sender !== contents || event.senderFrame?.url !== PICKER_URL) throw new Error('拒绝非本地选择窗口的请求。');
          if (action === 'cancel') { cancel(); return true; }
          if (action !== 'select') throw new Error('仅允许确认或取消选择。');
          if (!capturedHandle || selecting) return false;
          selecting = true; state('正在读取该资源管理器窗口的选中项目…'); child.stdin.write('select\n'); return true;
        });
        panel.on('closed', cancel); parent?.once('closed', cancel);
        panel.loadFile(PICKER_PAGE).then(() => {
          if (settled) return;
          if (restoreParent && parent && !parent.isDestroyed()) { parent.minimize(); minimizedParent = true; }
          panel.showInactive(); state('正在打开 Windows 资源管理器…');
          child = spawnProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-NonInteractive', '-File', path.join(directory, 'local-picker.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
          this.child = child;
          launchTimer = setTimeout(() => fail('未能识别新资源管理器窗口，请重试。'), 20000);
          child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
          child.stdin.on('error', error => { if (!settled) fail(error.message); });
          child.stdout.on('data', value => {
            if (settled) return; output += value;
            if (output.length > 1024 * 1024) { fail('选择的路径超过允许大小。'); return; }
            let end;
            while (!settled && (end = output.indexOf('\n')) >= 0) {
              const line = output.slice(0, end).trim().replace(/^\uFEFF/, ''); output = output.slice(end + 1); if (!line) continue;
              let result; try { result = JSON.parse(line); } catch { fail('资源管理器返回了无效结果。'); return; }
              if (result.type === 'ready') {
                if (capturedHandle || !/^\d+$/.test(result.handle || '') || result.handle === '0') { fail('资源管理器窗口标识无效。'); return; }
                capturedHandle = result.handle; clearTimeout(launchTimer);
                state('在刚打开的资源管理器中，用 Ctrl / Shift 选择文件和文件夹，然后点击“使用所选项目”。', true);
                timer = setInterval(() => { if (!settled && child.stdin.writable) child.stdin.write('ping\n'); }, 500);
              } else if (result.type === 'selection-error') {
                selecting = false; state(`未选择项目：${result.error || '请在资源管理器中选择文件或文件夹。'}`, true);
              } else if (result.type === 'selected') {
                if (!selecting || result.handle !== capturedHandle || !Array.isArray(result.paths) || !result.paths.length || result.paths.length > 1000 || result.paths.some(value => typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))) { fail('选择结果与指定资源管理器窗口不匹配。'); return; }
                finish(null, [...new Set(result.paths)]);
              } else if (result.type === 'cancelled') cancel();
              else if (result.type === 'error') fail(result.error || '资源管理器选择失败。');
              else { fail('资源管理器返回了未知结果。'); return; }
            }
          });
          child.stderr.on('data', value => { if (stderr.length < 4000) stderr += value; });
          child.once('error', error => fail(error.message));
          child.once('close', () => { if (!settled) fail(stderr.trim() || '资源管理器选择已中断。'); });
        }).catch(error => fail(error.message));
      } catch (error) { fail(error.message); }
    });
  }
  close() { this.generation++; this.cancel?.(); }
}
module.exports = { LocalPicker };
