'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, WebContentsView, ipcMain, dialog, session } = require('electron');
const { createSshProxy } = require('./ssh-network.cjs');
const { createPreview } = require('./preview-server.cjs');
const ROOT = path.resolve(__dirname, '..');
const PAGE = pathToFileURL(path.join(ROOT, 'app/browser.html')).href;
const TOOLBAR_HEIGHT = 116;

function webUrl(value) {
  let text = String(value || 'http://localhost:8888').trim();
  if (!/^[a-z][a-z\d+.-]*:/i.test(text)) text = `https://${text}`;
  const url = new URL(text);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('浏览器仅支持不含内嵌账号密码的 HTTP/HTTPS 地址。');
  return url.href;
}
function safeName(value) { let name = path.basename(String(value || 'download').replace(/\\/g, '/')).replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180).replace(/[. ]+$/g, '') || 'download'; if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`; return name; }
function cancelled() { const error = new Error('下载已取消。'); error.name = 'AbortError'; return error; }

class BrowserManager {
  constructor(options) {
    this.options = options; this.windows = new Map(); this.transfers = new Map(); this.previews = new Set(); this.context = null; this.contextPromise = null; this.generation = 0;
    ipcMain.handle('browser:call', async (event, message) => {
      const state = this.windows.get(event.sender.id);
      if (!state || event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== PAGE || event.senderFrame.url !== PAGE) throw new Error('浏览器请求来源无效。');
      try { return { ok: true, value: await this.action(state, String(message?.action), message?.payload || {}) }; }
      catch (error) { return { ok: false, error: error.message }; }
    });
  }
  async getContext() {
    const backend = this.options.getBackend();
    if (!backend?.connected) throw new Error('请先连接 SSH，再打开服务器网络浏览器。');
    if (this.context?.client === backend.client) return this.context;
    if (this.contextPromise && this.contextGeneration === this.generation) return this.contextPromise;
    const generation = this.generation;
    this.contextGeneration = generation;
    const pending = (async () => {
      const client = backend.client, proxy = await createSshProxy(backend);
      const partition = session.fromPartition(`remote-browser-${crypto.randomUUID()}`, { cache: false });
      try {
        // <-loopback> removes Chromium's implicit localhost/loopback bypass.
        await partition.setProxy({ mode: 'fixed_servers', proxyRules: proxy.url, proxyBypassRules: '<-loopback>' });
        await partition.closeAllConnections();
        partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        partition.setPermissionCheckHandler(() => false);
        partition.setDevicePermissionHandler(() => false);
        partition.setSpellCheckerEnabled(false);
        partition.webRequest.onBeforeRequest((details, callback) => {
          const scheme = /^([a-z][a-z\d+.-]*):/i.exec(details.url)?.[1]?.toLowerCase();
          callback({ cancel: !['http', 'https', 'ws', 'wss', 'blob', 'data', 'about'].includes(scheme) });
        });
        const context = { backend, client, proxy, partition, generation, closed: false };
        partition.on('will-download', (event, item, contents) => this.beginDownload(context, event, item, contents));
        if (generation !== this.generation || !backend.connected || backend.client !== client) throw new Error('SSH 连接已改变。');
        this.context = context; return context;
      } catch (error) { await proxy.close(); await partition.closeAllConnections(); await partition.clearStorageData(); throw error; }
    })().finally(() => { if (this.contextPromise === pending) this.contextPromise = null; });
    this.contextPromise = pending;
    return pending;
  }
  assertActive(state) {
    if (state.context.closed || this.context !== state.context || !state.context.backend.connected || state.context.backend.client !== state.context.client) throw new Error('SSH 连接已断开。');
  }
  send(state, value) { if (!state.window.isDestroyed()) state.window.webContents.send('browser:event', value); }
  status(state, error = '') {
    if (state.view.webContents.isDestroyed()) return;
    const contents = state.view.webContents;
    this.send(state, { type: 'state', url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading(), canBack: contents.navigationHistory.canGoBack(), canForward: contents.navigationHistory.canGoForward(), error });
  }
  async open(value) {
    const url = webUrl(value), context = await this.getContext();
    const window = new BrowserWindow({ width: 1180, height: 820, minWidth: 620, minHeight: 400, parent: this.options.getParent?.(), show: false, autoHideMenuBar: true, title: '服务器网络浏览器',
      webPreferences: { preload: path.join(ROOT, 'browser-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, partition: `browser-toolbar-${crypto.randomUUID()}` } });
    const view = new WebContentsView({ webPreferences: { session: context.partition, nodeIntegration: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, navigateOnDragDrop: false, safeDialogs: true, spellcheck: false } });
    view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    const viewContents = view.webContents;
    const state = { window, view, context, serverDirectory: '', downloadDestination: 'local', popupNotice: '' };
    const windowId = window.webContents.id;
    this.windows.set(windowId, state); window.contentView.addChildView(view);
    const layout = () => { if (!window.isDestroyed()) { const [width, height] = window.getContentSize(); view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) }); } };
    window.on('resize', layout); layout();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    view.webContents.setWindowOpenHandler(details => {
      this.status(state, `已阻止网页弹出窗口。需要时请在地址栏打开：${details.url}`);
      return { action: 'deny' };
    });
    const checkNavigation = (event, target) => { try { webUrl(target); } catch (error) { event.preventDefault(); this.status(state, error.message); } };
    view.webContents.on('will-navigate', checkNavigation); view.webContents.on('will-redirect', checkNavigation);
    view.webContents.on('will-attach-webview', event => event.preventDefault());
    for (const name of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) view.webContents.on(name, () => this.status(state));
    view.webContents.on('did-fail-load', (_event, code, description, target, isMainFrame) => { if (isMainFrame && code !== -3) this.status(state, `加载失败：${description} (${code}) — ${target}`); });
    view.webContents.on('render-process-gone', (_event, details) => this.status(state, `网页进程已结束：${details.reason}`));
    window.on('closed', () => {
      this.windows.delete(windowId);
      // `window.webContents` is invalid after `closed`; use the captured view
      // reference while Chromium tears down the child contents.
      if (!viewContents.isDestroyed()) viewContents.close();
    });
    try {
      await window.loadFile(path.join(ROOT, 'app/browser.html'));
      this.assertActive(state);
      if (!process.argv.includes('--smoke-test')) window.show();
      void view.webContents.loadURL(url).catch(error => this.status(state, error.message));
      return { id: windowId, url };
    } catch (error) { if (!window.isDestroyed()) window.destroy(); throw error; }
  }
  async action(state, action, payload) {
    this.assertActive(state); const contents = state.view.webContents;
    if (action === 'load') { this.status(state); return { destination: state.downloadDestination, serverDirectory: state.serverDirectory }; }
    if (action === 'navigate') { const url = webUrl(payload.url); void contents.loadURL(url).catch(error => this.status(state, error.message)); return { url }; }
    if (action === 'back') { if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); return true; }
    if (action === 'forward') { if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); return true; }
    if (action === 'reload') { contents.reload(); return true; }
    if (action === 'stop') { contents.stop(); return true; }
    if (action === 'destination') { const serverDirectory = String(payload.serverDirectory || '').trim(); if (serverDirectory && (!serverDirectory.startsWith('/') || /[\x00\r\n]/.test(serverDirectory))) throw new Error('服务器下载目录必须是绝对路径。'); state.downloadDestination = payload.destination === 'server' ? 'server' : 'local'; state.serverDirectory = serverDirectory; return true; }
    if (action === 'clearSession') { await state.context.partition.clearStorageData(); await state.context.partition.clearCache(); return true; }
    if (action === 'download') { contents.downloadURL(webUrl(payload.url)); return true; }
    throw new Error('未知浏览器操作。');
  }
  report(task, patch = {}) {
    Object.assign(task.info, patch);
    try { this.options.onTransfer?.({ ...task.info }); } catch { /* Status listeners cannot interrupt cleanup. */ }
  }
  beginDownload(context, event, item, contents) {
    const state = [...this.windows.values()].find(value => value.view.webContents === contents);
    if (context.closed || !state) { event.preventDefault(); return; }
    let staging;
    try { staging = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-desktop-web-')); fs.chmodSync(staging, 0o700); }
    catch (error) { event.preventDefault(); this.status(state, `无法创建下载暂存目录：${error.message}`); return; }
    const filePath = path.join(staging, safeName(item.getFilename())), id = `web-${crypto.randomUUID()}`;
    const task = { id, context, item, staging, filePath, controller: new AbortController(), finished: false, finishing: false, webFinished: false, destination: null, choice: null, info: { id, kind: 'web', direction: 'download', status: 'choosing', done: 0, total: item.getTotalBytes(), name: path.basename(filePath), source: item.getURL(), method: 'SSH 浏览器' } };
    task.completion = new Promise(resolve => { task.resolveCompletion = resolve; });
    this.transfers.set(id, task);
    // Electron requires setSavePath synchronously during will-download. Pause
    // immediately; asynchronous native destination selection then resumes it.
    item.setSavePath(filePath); item.pause(); this.report(task);
    item.on('updated', (_event, status) => {
      if (task.finishing || task.finished) return;
      if (status === 'interrupted') {
        // Chromium may keep an interrupted item alive indefinitely while it
        // waits for a resumable response. End it here so the transfer center
        // reports a deterministic error and removes its staging file.
        task.transportError = new Error('网页下载中断；服务器未提供可恢复的下载。');
        item.cancel();
      }
      this.report(task, { done: item.getReceivedBytes(), total: item.getTotalBytes(), status: task.destination ? 'running' : 'choosing', ...(status === 'interrupted' ? { error: task.transportError.message } : { error: '' }) });
    });
    item.once('done', (_event, status) => { task.webFinished = true; void this.finishDownload(task, status); });
    task.choice = this.chooseDestination(state, task).then(destination => {
      if (task.finished || task.controller.signal.aborted || context.closed) throw cancelled();
      if (!destination) throw cancelled(); task.destination = destination; this.report(task, { status: 'running', path: destination.path || destination.remoteDirectory }); item.resume(); return destination;
    }).catch(error => { task.choiceError = error; if (!task.webFinished) item.cancel(); return null; });
  }
  async chooseDestination(state, task) {
    if (state.downloadDestination === 'server') {
      if (!this.options.uploadFile) throw new Error('服务器保存不可用：尚未配置上传功能。');
      const remoteDirectory = this.options.chooseServerDirectory ? await this.options.chooseServerDirectory() : state.serverDirectory;
      if (!remoteDirectory) throw new Error('请在浏览器工具栏输入服务器保存目录后重新下载。');
      if (typeof remoteDirectory !== 'string' || !remoteDirectory.startsWith('/') || /[\x00\r\n]/.test(remoteDirectory)) throw new Error('服务器保存目录无效。');
      return { type: 'server', remoteDirectory };
    }
    const result = await dialog.showSaveDialog(state.window, { title: '网页下载保存到本机', defaultPath: task.info.name, buttonLabel: '保存', properties: ['createDirectory', 'showOverwriteConfirmation'] });
    if (result.canceled || !result.filePath) return null;
    return { type: 'local', path: result.filePath };
  }
  async finishDownload(task, status) {
    if (task.finishing || task.finished) return;
    task.finishing = true;
    try {
      await task.choice;
      if (task.choiceError) throw task.choiceError;
      if (task.transportError) throw task.transportError;
      if (task.controller.signal.aborted || task.context.closed || status === 'cancelled') throw cancelled();
      if (status !== 'completed') throw new Error(`网页下载失败：${status}。请重新登录或重试；不支持的网站后台下载方式请改用直接下载链接。`);
      if (!task.destination) throw cancelled();
      task.info.total = task.item.getReceivedBytes();
      if (task.destination.type === 'server') {
        this.report(task, { status: 'running', method: 'SSH 浏览器 → 上传', done: 0 });
        const result = await this.options.uploadFile({ localPath: task.filePath, remoteDirectory: task.destination.remoteDirectory, id: task.id, signal: task.controller.signal, onProgress: progress => this.report(task, { done: Number(progress.done) || 0, total: Number(progress.total) || task.info.total, method: `SSH 浏览器 → ${progress.method || '上传'}` }) });
        if (task.controller.signal.aborted) throw cancelled();
        this.report(task, { status: 'completed', done: task.info.total, path: result?.path || task.destination.remoteDirectory });
      } else {
        let created = false;
        try {
          const output = fs.createWriteStream(task.destination.path, { flags: 'wx', mode: 0o600 });
          output.once('open', () => { created = true; });
          await pipeline(fs.createReadStream(task.filePath), output, { signal: task.controller.signal });
          if (task.controller.signal.aborted) throw cancelled();
        } catch (error) {
          if (created) await fsp.unlink(task.destination.path).catch(() => {});
          if (error.code === 'EEXIST') throw new Error('本机目标文件已存在，未覆盖。请重新下载并选择其他文件名。');
          throw error;
        }
        this.report(task, { status: 'completed', done: task.info.total, path: task.destination.path });
      }
    } catch (error) { this.report(task, { status: error.name === 'AbortError' || task.controller.signal.aborted ? 'cancelled' : 'error', error: error.message }); }
    finally { task.finished = true; this.transfers.delete(task.id); await fsp.rm(task.staging, { recursive: true, force: true }).catch(() => {}); task.resolveCompletion(); }
  }
  cancel(id) { const task = this.transfers.get(String(id)); if (!task) return false; task.controller.abort(); if (!task.webFinished) task.item.cancel(); return true; }
  async createPreview(remotePath, options) {
    const backend = this.options.getBackend(); if (!backend?.connected) throw new Error('尚未连接 SSH。');
    const generation = this.generation, client = backend.client;
    const preview = await createPreview(backend, remotePath, options);
    if (generation !== this.generation || backend.client !== client || !backend.connected) { await preview.close(); throw new Error('SSH 连接已改变。'); }
    this.previews.add(preview);
    return { url: preview.url, root: preview.root, prefix: preview.prefix, dispose: async () => { this.previews.delete(preview); await preview.close(); } };
  }
  async disconnect() {
    ++this.generation;
    const context = this.context; this.context = null;
    if (context) context.closed = true;
    const transfers = [...this.transfers.values()];
    for (const task of transfers) this.cancel(task.id);
    for (const state of this.windows.values()) if (!state.window.isDestroyed()) state.window.destroy();
    this.windows.clear();
    await Promise.allSettled([...this.previews].map(preview => preview.close())); this.previews.clear();
    await Promise.allSettled(transfers.map(task => task.completion));
    if (context) { await context.proxy.close(); await context.partition.closeAllConnections(); await context.partition.clearStorageData(); await context.partition.clearCache(); }
  }
}
module.exports = { BrowserManager, createBrowserManager: options => new BrowserManager(options), webUrl, safeName };
