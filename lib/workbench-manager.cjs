'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, ipcMain, dialog } = require('electron');
const { DocumentService } = require('./document-service.cjs');
const { JupyterClient } = require('./jupyter-client.cjs');
const { safeUrl } = require('./activity-audit.cjs');
const ROOT = path.resolve(__dirname, '..');
const PAGE = pathToFileURL(path.join(ROOT, 'app/workbench.html')).href;
const ASSETS = pathToFileURL(path.join(ROOT, 'media/workbench')).href + '/';
const LOCAL_FILES = new Set([PAGE, ...['workbench.js', 'workbench.css'].map(name => pathToFileURL(path.join(ROOT, 'app', name)).href)]);
class WorkbenchManager {
  constructor(options) {
    this.options = options; this.windows = new Map(); this.generation = 0;
    ipcMain.handle('workbench:call', async (event, message) => {
      const state = this.windows.get(event.sender.id);
      if (!state || event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== PAGE || event.senderFrame.url !== PAGE) throw new Error('工作台请求来源无效。');
      try {
        const action = String(message?.action), payload = message?.payload || {}, task = () => this.action(state, action, payload);
        const details = { path: state.document.path, protocol: action.startsWith('kernel') || action.startsWith('jupyter') || action === 'execute' ? 'Jupyter over SSH' : 'SFTP',
          ...(action === 'execute' ? { command: payload.code, cellId: payload.cellId } : {}),
          ...(action === 'saveAs' ? { destination: payload.path } : {}),
          ...(action === 'jupyterConnect' ? { endpoint: safeUrl(payload.endpoint) } : {}),
          ...(action === 'preview' ? { root: payload.root } : {}) };
        return { ok: true, value: await (this.options.audit && !['load', 'update', 'save', 'jupyterInfo'].includes(action) ? this.options.audit(`workbench:${action}`, details, task, this.options.captureLog?.(state.backend)) : task()) };
      }
      catch (error) { return { ok: false, error: error.message, code: error.code }; }
    });
  }
  send(state, value) { if (!state.window.isDestroyed()) state.window.webContents.send('workbench:event', value); }
  assertConnected(state) { if (!state.backend.connected || this.options.getBackend() !== state.backend || this.options.getConnectionId() !== state.connectionId || state.disconnected) throw new Error('SSH 连接已改变或断开。请保留内容并重新打开文件。'); }
  async open(remotePath, options = {}) {
    const generation = this.generation;
    const backend = this.options.getBackend(); if (!backend?.connected) throw new Error('尚未连接 SSH。');
    const connectionId = this.options.getConnectionId(), service = new DocumentService(backend), document = await service.read(remotePath);
    if (generation !== this.generation || !backend.connected || connectionId !== this.options.getConnectionId() || backend !== this.options.getBackend()) throw new Error('SSH 连接已改变。');
    for (const state of this.windows.values()) if (!state.disconnected && state.connectionId === connectionId && state.document.path === document.path) { state.window.show(); state.window.focus(); return { path: document.path }; }
    if (options.readOnly) document.readOnly = true;
    const window = new BrowserWindow({ width: 1180, height: 820, minWidth: 720, minHeight: 500, parent: this.options.getParent(), show: false, title: document.name, autoHideMenuBar: true,
      webPreferences: { preload: path.join(ROOT, 'workbench-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, partition: `workbench-${crypto.randomUUID()}` } });
    const state = { window, backend, connectionId, service, document, forcedReadOnly: Boolean(options.readOnly), text: document.text, dirty: false, disconnected: false, allowedClose: false, client: null, preview: null, closePromise: null };
    const contentsId = window.webContents.id;
    this.windows.set(contentsId, state);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-frame-navigate', (event, details) => { const url = details?.url || event.url; if (url !== PAGE && url !== 'about:blank' && !url?.startsWith(state.preview?.prefix || 'INVALID-PREVIEW:')) event.preventDefault(); });
    window.webContents.on('will-frame-redirect', (event, url) => { if (!(typeof url === 'string' ? url : event.url)?.startsWith(state.preview?.prefix || 'INVALID-PREVIEW:')) event.preventDefault(); });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const allowedLocal = LOCAL_FILES.has(details.url) || details.url.startsWith(ASSETS);
      const allowedPreview = state.preview?.prefix && details.url.startsWith(state.preview.prefix);
      callback({ cancel: !allowedLocal && !allowedPreview });
    });
    window.on('close', event => { if (!state.allowedClose) { event.preventDefault(); this.confirm(state).then(ok => { if (ok && !window.isDestroyed()) { state.allowedClose = true; window.close(); } }); } });
    window.on('closed', () => { this.windows.delete(contentsId); state.client?.close(); state.preview?.dispose?.(); });
    await window.loadFile(path.join(ROOT, 'app/workbench.html'));
    if (generation !== this.generation || state.disconnected) { state.allowedClose = true; window.close(); throw new Error('SSH 连接已改变，打开文件已取消。'); }
    if (!process.argv.includes('--smoke-test')) window.show(); return { path: document.path, readOnly: document.readOnly };
  }
  async action(state, action, payload) {
    if (action === 'load') return { document: state.document, connected: !state.disconnected };
    if (action === 'update') { if (typeof payload.text !== 'string' || Buffer.byteLength(payload.text) > 16 * 1024 * 1024) throw new Error('文档内容超过 16 MiB。'); state.text = payload.text; state.dirty = state.text !== state.document.text; state.window.setTitle(`${state.dirty ? '● ' : ''}${state.document.name} — 文档工作台`); return { dirty: state.dirty }; }
    if (action === 'close') { state.window.close(); return true; }
    this.assertConnected(state);
    if (action === 'save') return this.save(state, payload.text);
    if (action === 'saveAs') { const document = await state.service.saveAs(payload.path, payload.text); state.document = document; state.text = document.text; state.dirty = false; this.send(state, { type: 'saved', document }); return document; }
    if (action === 'reload') { if (state.dirty) { const result = await dialog.showMessageBox(state.window, { type: 'warning', message: '重新载入将丢弃未保存修改。', buttons: ['重新载入', '取消'], defaultId: 1, cancelId: 1 }); if (result.response !== 0) return null; } state.document = await state.service.read(state.document.path); state.document.readOnly ||= state.forcedReadOnly; state.text = state.document.text; state.dirty = false; return state.document; }
    if (action === 'preview') { const next = await this.options.createPreview(state.document.path, { root: payload.root || undefined }); try { this.assertConnected(state); } catch (error) { next.dispose?.(); throw error; } state.preview?.dispose?.(); state.preview = next; return { url: state.preview.url }; }
    if (action === 'jupyterConnect') { state.client?.close(); const client = new JupyterClient(state.backend.client, payload.endpoint, payload.token); state.client = client; client.on('output', value => {
      this.options.log?.({ type: 'jupyter-output', path: state.document.path, output: value }, this.options.captureLog?.(state.backend));
      this.send(state, { ...value, outputType: value.type, type: 'jupyterOutput' });
    }); client.on('notice', value => this.send(state, { type: 'jupyterNotice', ...value })); return client.info(); }
    const client = state.client; if (!client) throw new Error('请先连接 Jupyter 服务。');
    if (action === 'jupyterInfo') return client.info();
    if (action === 'kernelStart') return client.start(payload.name);
    if (action === 'kernelAttach') return client.attach(payload.id);
    if (action === 'execute') return client.execute(payload.code, payload.cellId);
    if (action === 'kernelInterrupt') return client.interrupt();
    if (action === 'kernelRestart' || action === 'kernelShutdown') {
      const label = action === 'kernelRestart' ? '重启内核' : '关闭内核';
      const answer = await dialog.showMessageBox(state.window, { type: 'warning', message: `${label}会停止执行并清空内存中的变量。`, buttons: [label, '取消'], defaultId: 1, cancelId: 1 });
      if (answer.response !== 0) return false;
      this.assertConnected(state); if (state.client !== client) throw new Error('Jupyter 连接已改变，请重新操作。');
      await (action === 'kernelRestart' ? client.restart() : client.shutdown()); return true;
    }
    throw new Error('未知工作台操作。');
  }
  async save(state, text = state.text) {
    const task = () => this.saveDocument(state, text);
    return this.options.audit ? this.options.audit('workbench:save', { path: state.document.path, bytes: Buffer.byteLength(text), protocol: 'SFTP conflict check/write/rename' }, task, this.options.captureLog?.(state.backend)) : task();
  }
  async saveDocument(state, text) {
    this.assertConnected(state); if (state.document.readOnly) throw new Error('无编辑权限：请使用另存为。');
    state.document = await state.service.save(state.document, text); state.dirty = state.text !== text; state.window.setTitle(`${state.dirty ? '● ' : ''}${state.document.name} — 文档工作台`); this.send(state, { type: 'saved', document: state.document }); return state.document;
  }
  confirm(state) {
    if (state.closePromise) return state.closePromise;
    state.closePromise = (async () => {
      if (!state.dirty) return true;
      const result = await dialog.showMessageBox(state.window, { type: 'warning', message: `${state.document.name} 有未保存修改。`, detail: '保存会检测远程文件是否已被其他程序修改。', buttons: ['保存', '不保存', '取消'], defaultId: 0, cancelId: 2 });
      if (result.response === 1) return true; if (result.response !== 0) return false;
      try { await this.save(state); return !state.dirty; } catch (error) { await dialog.showMessageBox(state.window, { type: 'error', message: '无法保存，工作台已保留。', detail: error.message, buttons: ['确定'] }); return false; }
    })().finally(() => { state.closePromise = null; }); return state.closePromise;
  }
  async confirmAll() { for (const state of this.windows.values()) if (!await this.confirm(state)) return false; return true; }
  disconnect() { this.generation++; for (const state of this.windows.values()) { state.disconnected = true; state.client?.close(); state.preview?.dispose?.(); state.preview = null; this.send(state, { type: 'disconnected' }); } }
}
module.exports = { WorkbenchManager, createWorkbenchManager: options => new WorkbenchManager(options) };
