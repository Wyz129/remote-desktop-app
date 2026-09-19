'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, ipcMain, dialog } = require('electron');
const { DocumentService } = require('./document-service.cjs');
const { JupyterClient } = require('./jupyter-client.cjs');
const { safeUrl } = require('./activity-audit.cjs');
const { createWorkbenchAssets } = require('./workbench-assets.cjs');
const ROOT = path.resolve(__dirname, '..');
const PAGE = pathToFileURL(path.join(ROOT, 'app/workbench.html')).href;
const ASSETS = pathToFileURL(path.join(ROOT, 'media/workbench')).href + '/';
const LOCAL_FILES = new Set([PAGE, ...['workbench.js', 'workbench.css', 'workbench-frame.js'].map(name => pathToFileURL(path.join(ROOT, 'app', name)).href)]);
const ACTIONS = new Set(['load', 'update', 'close', 'open', 'save', 'saveAs', 'reload', 'preview', 'jupyterConnect', 'jupyterInfo', 'kernelStart', 'kernelAttach', 'execute', 'kernelInterrupt', 'kernelRestart', 'kernelShutdown']);
class WorkbenchManager {
  constructor(options) {
    this.options = options; this.windows = new Map(); this.generation = 0;
    ipcMain.handle('workbench:call', async (event, message) => {
      const state = this.windows.get(event.sender.id);
      if (!state || event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== PAGE || event.senderFrame.url !== PAGE) throw new Error('工作台请求来源无效。');
      return this.dispatch(state, message?.action, message?.payload);
    });
  }
  async dispatch(state, action, payload = {}) {
      try {
        if (!ACTIONS.has(action) || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('工作台请求无效。');
        const task = () => this.action(state, action, payload);
        const details = { path: action === 'open' ? payload.path : state.document.path, protocol: action.startsWith('kernel') || action.startsWith('jupyter') || action === 'execute' ? 'Jupyter over SSH' : 'SFTP',
          ...(action === 'execute' ? { command: payload.code, cellId: payload.cellId } : {}),
          ...(action === 'saveAs' ? { destination: payload.path } : {}),
          ...(action === 'jupyterConnect' ? { endpoint: safeUrl(payload.endpoint) } : {}),
          ...(action === 'preview' ? { root: payload.root } : {}) };
        return { ok: true, value: await (this.options.audit && !['load', 'update', 'save', 'jupyterInfo'].includes(action) ? this.options.audit(`workbench:${action}`, details, task, this.options.captureLog?.(state.backend)) : task()) };
      }
      catch (error) { return { ok: false, error: error.message, code: error.code }; }
  }
  descriptor(state) { return { id: state.id, ...(state.embedded ? { url: state.url } : {}), path: state.document.path, name: state.document.name, readOnly: Boolean(state.document.readOnly), dirty: state.dirty, disconnected: state.disconnected, title: `${state.dirty ? '● ' : ''}${state.document.name} — Monaco Editor` }; }
  emit(event) { this.options.onEvent?.(event); }
  send(state, value) { if (state.embedded) this.emit({ type: 'message', id: state.id, event: value }); else if (!state.window.isDestroyed()) state.window.webContents.send('workbench:event', value); }
  title(state) { if (state.embedded) this.emit({ type: 'title', ...this.descriptor(state) }); else state.window.setTitle(this.descriptor(state).title); }
  async call(id, action, payload = {}) {
    const state = this.windows.get(id);
    if (!state?.embedded || state.closed) return { ok: false, error: 'Monaco Editor 窗口已关闭或不存在。' };
    return this.dispatch(state, action, payload);
  }
  async close(state) {
    if (!state.embedded) { state.window.close(); return true; }
    if (!await this.confirm(state)) return false;
    if (state.closed) return true;
    state.closed = true; this.windows.delete(state.id); state.client?.close(); state.preview?.dispose?.();
    this.emit({ type: 'closed', id: state.id }); return true;
  }
  list() { return [...this.windows.values()].filter(state => state.embedded && !state.closed).map(state => this.descriptor(state)); }
  assertConnected(state) { if (!state.backend.connected || this.options.getBackend() !== state.backend || this.options.getConnectionId() !== state.connectionId || state.disconnected) throw new Error('SSH 连接已改变或断开。请保留内容并重新打开文件。'); }
  async open(remotePath, options = {}) {
    const generation = this.generation;
    const backend = this.options.getBackend(); if (!backend?.connected) throw new Error('尚未连接 SSH。');
    const connectionId = this.options.getConnectionId(), service = new DocumentService(backend);
    const document = remotePath ? await service.read(remotePath) : { path: '', name: 'Untitled.txt', text: '', kind: 'text', readOnly: false, untitled: true };
    if (generation !== this.generation || !backend.connected || connectionId !== this.options.getConnectionId() || backend !== this.options.getBackend()) throw new Error('SSH 连接已改变。');
    for (const state of this.windows.values()) if (!state.disconnected && state.connectionId === connectionId && state.document.path === document.path) { if (state.embedded) { this.emit({ type: 'focus', ...this.descriptor(state) }); return this.descriptor(state); } state.window.show(); state.window.focus(); return { path: document.path }; }
    if (options.readOnly) document.readOnly = true;
    if (this.options.embedded) {
      this.assetsPromise ||= createWorkbenchAssets().catch(error => { this.assetsPromise = null; throw error; });
      const assets = await this.assetsPromise;
      if (generation !== this.generation || !backend.connected || connectionId !== this.options.getConnectionId() || backend !== this.options.getBackend()) throw new Error('SSH 连接已改变。');
      for (const state of this.windows.values()) if (!state.disconnected && state.connectionId === connectionId && state.document.path === document.path) { this.emit({ type: 'focus', ...this.descriptor(state) }); return this.descriptor(state); }
      const state = { id: crypto.randomUUID(), url: assets.url, embedded: true, window: this.options.getParent(), backend, connectionId, service, document, forcedReadOnly: Boolean(options.readOnly), text: document.text, dirty: false, disconnected: false, client: null, preview: null, closePromise: null };
      this.windows.set(state.id, state); const descriptor = this.descriptor(state); this.emit({ type: 'open', ...descriptor }); return descriptor;
    }
    const window = new BrowserWindow({ width: 1180, height: 820, minWidth: 720, minHeight: 500, parent: this.options.getParent(), show: false, title: `${document.name} — Monaco Editor`, autoHideMenuBar: true,
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
    this.title(state);
    if (!process.argv.includes('--smoke-test')) window.show(); return { path: document.path, readOnly: document.readOnly };
  }
  async action(state, action, payload) {
    if (action === 'load') return { document: state.document, draftText: state.text, dirty: state.dirty, connected: !state.disconnected, defaultDirectory: state.backend.desktop || state.backend.home || '/' };
    if (action === 'update') { if (typeof payload.text !== 'string' || Buffer.byteLength(payload.text) > 16 * 1024 * 1024) throw new Error('文档内容超过 16 MiB。'); state.text = payload.text; state.dirty = state.text !== state.document.text; this.title(state); return { dirty: state.dirty }; }
    if (action === 'close') return this.close(state);
    this.assertConnected(state);
    if (action === 'open') {
      if (!await this.confirm(state)) return null;
      this.assertConnected(state);
      const document = await state.service.read(payload.path); this.assertConnected(state);
      state.client?.close(); state.client = null; state.preview?.dispose?.(); state.preview = null;
      state.document = document; state.text = document.text; state.dirty = false; state.forcedReadOnly = false;
      this.title(state); return document;
    }
    if (action === 'save') return this.save(state, payload.text);
    if (action === 'saveAs') {
      const textAtStart = state.text, document = await state.service.saveAs(payload.path, payload.text); this.assertConnected(state);
      state.preview?.dispose?.(); state.preview = null;
      state.document = document; state.forcedReadOnly = false;
      if (state.text === textAtStart) state.text = document.text;
      state.dirty = state.text !== document.text; this.title(state); this.send(state, { type: 'saved', document }); return document;
    }
    if (action === 'reload') {
      if (state.document.untitled) throw new Error('新文档尚未保存，无法重新载入。');
      if (state.dirty) { const result = await dialog.showMessageBox(state.window, { type: 'warning', message: '重新载入将丢弃未保存修改。', buttons: ['重新载入', '取消'], defaultId: 1, cancelId: 1 }); if (result.response !== 0) return null; }
      this.assertConnected(state); const document = await state.service.read(state.document.path); this.assertConnected(state);
      state.document = document; state.document.readOnly ||= state.forcedReadOnly; state.text = state.document.text; state.dirty = false; this.title(state); return state.document;
    }
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
    if (state.document.untitled) throw new Error('请先另存为到服务器路径。');
    this.assertConnected(state); if (state.document.readOnly) throw new Error('无编辑权限：请使用另存为。');
    state.document = await state.service.save(state.document, text); state.dirty = state.text !== text; this.title(state); this.send(state, { type: 'saved', document: state.document }); return state.document;
  }
  confirm(state) {
    if (state.closePromise) return state.closePromise;
    state.closePromise = (async () => {
      if (!state.dirty) return true;
      if (state.document.untitled) {
        const choice = await dialog.showMessageBox(state.window, { type: 'warning', message: 'Monaco Editor 的新文档尚未保存。', buttons: ['返回编辑器另存为', '不保存', '取消'], defaultId: 0, cancelId: 2 });
        if (choice.response === 0) this.send(state, { type: 'requestSaveAs' });
        return choice.response === 1;
      }
      const result = await dialog.showMessageBox(state.window, { type: 'warning', message: `${state.document.name} 有未保存修改。`, detail: '保存会检测远程文件是否已被其他程序修改。', buttons: ['保存', '不保存', '取消'], defaultId: 0, cancelId: 2 });
      if (result.response === 1) return true; if (result.response !== 0) return false;
      try { await this.save(state); return !state.dirty; } catch (error) { await dialog.showMessageBox(state.window, { type: 'error', message: '无法保存，Monaco Editor 已保留。', detail: error.message, buttons: ['确定'] }); return false; }
    })().finally(() => { state.closePromise = null; }); return state.closePromise;
  }
  async confirmAll() { for (const state of this.windows.values()) if (!await this.confirm(state)) return false; return true; }
  disconnect() { this.generation++; for (const state of this.windows.values()) { state.disconnected = true; state.client?.close(); state.preview?.dispose?.(); state.preview = null; this.send(state, { type: 'disconnected' }); } }
  async dispose() { this.disconnect(); await (await this.assetsPromise)?.close(); }
}
module.exports = { WorkbenchManager, createWorkbenchManager: options => new WorkbenchManager(options) };
