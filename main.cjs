'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const { clipboardText } = require('./lib/terminal-clipboard.cjs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fsp = require('node:fs/promises');
const { StringDecoder } = require('node:string_decoder');
const { SshBackend, DEFAULT_THRESHOLD, normalizeRemote } = require('./lib/ssh-backend.cjs');
const { TerminalGuard } = require('./lib/terminal-guard.cjs');
const { desktopIdentity, desktopLocations } = require('./lib/desktop-preferences.cjs');
const crypto = require('node:crypto');
const net = require('node:net');
const { ActivityLog } = require('./lib/activity-log.cjs');
const { createAuditor, safeUrl, createSystemCommandLogger } = require('./lib/activity-audit.cjs');
const { UploadService } = require('./lib/upload-service.cjs');
const { InstanceBridge, executeRemote } = require('./lib/instance-bridge.cjs');
const { openInteractiveShell } = require('./lib/interactive-shell.cjs');
const { launchLocalTerminal } = require('./lib/local-terminal.cjs');
const { TransferCenter } = require('./lib/transfer-center.cjs');
const { transferDirectory, transferPreferences } = require('./lib/transfer-preferences.cjs');
const { LocalPicker } = require('./lib/local-picker.cjs');
const { registerLocalPaths, transferIdentity, openTransferTarget } = require('./lib/transfer-targets.cjs');
const { createWorkbenchManager } = require('./lib/workbench-manager.cjs');
const { createBrowserManager } = require('./lib/browser-manager.cjs');
const { ensureRemoteStorage } = require('./lib/remote-storage.cjs');
const { VideoService } = require('./lib/video-service.cjs');
const { serverProfile, profilesFromSettings, upsertProfile, storagePreferences, connectionTitle, automaticServerAlias } = require('./lib/server-profiles.cjs');
const { normalizeProgramPreferences, updateProgramPreferences } = require('./lib/program-preferences.cjs');
const { workspacePreferences, workspaceLocations, shellPreferences } = require('./lib/interface-preferences.cjs');
const { normalize: contextMenuPreferences } = require('./app/context-menu.js');

const userDataArgument = process.argv.find(arg => arg.startsWith('--user-data-dir='));
if (userDataArgument) app.setPath('userData', path.resolve(userDataArgument.slice('--user-data-dir='.length)));
let windowRef, backend, desktopService, connecting = false;
let uploader, instanceBridge, workbench, browserManager, localPicker, videoService;
const activityLog = new ActivityLog({ onEvent: value => send('activity:event', value) });
const audit = createAuditor(activityLog);
const cliActivity = new Map();
const transferCenter = new TransferCenter(value => send('download:progress', value));
const selectedLocalPaths = new Set(), selectedDownloadDirectories = new Set();
let settings = { downloadThreshold: DEFAULT_THRESHOLD, scriptEditor: 'monaco', knownHosts: {}, desktopLocations: {}, storageVersion: 2, serverProfiles: [], selectedServerId: '', programPreferences: normalizeProgramPreferences(), ...transferPreferences() };
let settingsQueue = Promise.resolve();
let workspacePreferenceQueue = Promise.resolve();
const selectedKeys = new Set();
const completedDownloads = new Set();
const terminalStarts = new Map();
const desktopPreferenceWrites = new Map();
let sessionTransition = false, allowWindowClose = false, closingApplication = false, quitPromise = null;
let connectionCleanup = Promise.resolve();
const terminalGuard = new TerminalGuard({ getBackend: () => backend,
  onAction: (record, source) => { if (currentSession(source) && !record.terminalId?.startsWith('local-')) activityLog.system(record); },
  closed: id => {
    const start = terminalStarts.get(id);
    if (start && !start.ready) start.releaseLog?.();
    terminalStarts.delete(id); post({ type: 'terminalClosed', id });
  } });
const entryPath = path.join(__dirname, 'app', 'index.html');
const entryUrl = pathToFileURL(entryPath).href;
// Covers the desktop renderer, Monaco frames and embedded browser contents.
// Consume F11 before any renderer can also toggle it; Escape belongs to the
// focused application (including browser/TUI fullscreen modes).
app.on('web-contents-created', (_event, contents) => {
  contents.on('before-input-event', (event, input) => {
    if (input.key !== 'F11' || input.control || input.alt || input.meta || input.shift) return;
    event.preventDefault();
    if (input.type !== 'keyDown' || input.isAutoRepeat || !windowRef || windowRef.isDestroyed()) return;
    windowRef.setFullScreen(!windowRef.isFullScreen());
    post({ type: 'fullscreenResult', ok: true, message: '已切换全屏；F11 切换。' });
  });
});
function requireSender(event) {
  if (!windowRef || event.sender !== windowRef.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== entryUrl) throw new Error('拒绝非应用窗口的请求。');
}
function requireBackend() { if (!backend?.connected || !desktopService) throw new Error('尚未连接 SSH。'); return backend; }
function publicSettings() {
  const { knownHosts, desktopLocations, workspaceLocations: locations, transferUploadDirectories, ...visible } = settings;
  const workspace = workspacePreferences(backend?.connected && locations?.[backend.desktopIdentity]);
  return { ...visible, defaultUploadDirectory: backend?.connected ? transferUploadDirectories?.[backend.desktopIdentity] || backend.remoteStorage?.download || '' : '', shellPreferences: shellPreferences(settings.shellPreferences), contextMenuPreferences: contextMenuPreferences(settings.contextMenuPreferences), workspacePreferences: workspace, workspaceIdentity: backend?.connected ? backend.desktopIdentity : '', downloadsPath: settings.defaultDownloadDirectory || app.getPath('downloads') };
}
function currentSession(source) { return Boolean(source && source === backend && source.connected); }
function queueWorkspacePreferences(task) {
  const pending = workspacePreferenceQueue.catch(() => {}).then(task);
  workspacePreferenceQueue = pending;
  return pending;
}
function accessDenied(error) { return [3, 'EACCES', 'EPERM'].includes(error?.code); }
function accessMessage(error, remotePath) { return `${accessDenied(error) ? '无访问权限：' : ''}${remotePath ? `${remotePath} — ` : ''}${error.message}${error.code !== undefined ? ` (${error.code})` : ''}`; }
async function loadSettings() {
  try { const loaded = JSON.parse(await fsp.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8')); settings = { ...settings, ...Object.fromEntries(Object.entries(loaded).filter(([key]) => ['host', 'port', 'username', 'alias', 'hostKeyFingerprint', 'knownHosts', 'downloadThreshold', 'privateKeyPath', 'selectedServerId'].includes(key))), ...storagePreferences(loaded), ...transferPreferences(loaded), serverProfiles: profilesFromSettings(loaded), programPreferences: normalizeProgramPreferences(loaded.programPreferences), workspaceLocations: workspaceLocations(loaded.workspaceLocations), shellPreferences: shellPreferences(loaded.shellPreferences), contextMenuPreferences: contextMenuPreferences(loaded.contextMenuPreferences) }; } catch (error) { if (error.code !== 'ENOENT') settings.loadWarning = '本地设置不可读，已使用默认值。'; }
  if (!settings.knownHosts || typeof settings.knownHosts !== 'object' || Array.isArray(settings.knownHosts)) settings.knownHosts = {};
  if (!Number.isSafeInteger(settings.downloadThreshold) || settings.downloadThreshold < 1048576 || settings.downloadThreshold > 1073741824) settings.downloadThreshold = DEFAULT_THRESHOLD;
  settings.scriptEditor = 'monaco';
  settings.desktopLocations = desktopLocations(settings.desktopLocations);
  settings.workspaceLocations = workspaceLocations(settings.workspaceLocations);
  settings.shellPreferences = shellPreferences(settings.shellPreferences);
  settings.contextMenuPreferences = contextMenuPreferences(settings.contextMenuPreferences);
}
function saveSettings(patch) {
  const task = settingsQueue.then(async () => {
    const next = { ...settings, ...(typeof patch === 'function' ? patch(settings) : patch) };
    const target = path.join(app.getPath('userData'), 'settings.json'), temp = `${target}.tmp`;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(temp, target); settings = next; return publicSettings();
  });
  settingsQueue = task.catch(() => {}); return task;
}
function send(channel, payload) { if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send(channel, payload); }
function post(payload) { send('desktop:message', payload); }
function bindCommandLogger(source) {
  if (source.commandLogContexts) return;
  source.onCommandActivity = createSystemCommandLogger(activityLog, () => currentSession(source));
  source.commandLogContexts = source.onCommandActivity.operations;
}
function bridgeActivity(event) {
  const id = event.connection.id;
  if (event.type === 'start' && event.action === 'connect') return;
  let session = cliActivity.get(id);
  if (!session) {
    const address = backend?.client?._sock?.localAddress;
    session = activityLog.beginCli({ id, time: event.connection.connectedAt, transport: event.connection.transport, action: event.action,
      ip: net.isIP(address || '') ? address : null, ipSource: 'ssh-local-address' });
    cliActivity.set(id, session);
    activityLog.cli(id, { type: event.action === 'exec' ? 'request' : 'command', action: event.action, args: event.args });
  }
  if (event.type === 'progress') {
    const progress = event.progress;
    activityLog.cli(id, progress?.kind === 'command' ? { type: 'command', command: progress.data, protocol: event.action === 'shell' ? 'SSH PTY' : 'SSH exec' } : ['stdout', 'stderr', 'terminal-input'].includes(progress?.kind) ? { type: progress.kind, data: progress.data } : { type: 'progress', progress });
  } else if (event.type === 'finish' || event.type === 'error') {
    const result = event.action === 'exec' && event.result ? { code: event.result.code, signal: event.result.signal } : event.result;
    activityLog.cli(id, { type: 'end', result, error: event.error }); cliActivity.delete(id);
  }
}
function createWindow() {
  windowRef = new BrowserWindow({ width: 1440, height: 900, minWidth: 820, minHeight: 560, fullscreen: true, autoHideMenuBar: true, backgroundColor: '#202222', show: !process.argv.includes('--smoke-test'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowRef.webContents.on('will-navigate', (event, url) => { if (url !== entryUrl) event.preventDefault(); });
  windowRef.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
  windowRef.loadFile(entryPath);
  windowRef.on('close', event => { if (!allowWindowClose) { event.preventDefault(); void quitSafely(); } });
  windowRef.on('closed', () => { windowRef = null; void backend?.disconnect().catch(() => {}); });
}
function shutdownDeadline(task, label, milliseconds = 5000) {
  let timer;
  return Promise.race([Promise.resolve().then(task), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时`)), milliseconds); })]).finally(() => clearTimeout(timer));
}
function quitSafely() {
  if (allowWindowClose) return Promise.resolve(true);
  if (quitPromise) return quitPromise;
  quitPromise = (async () => {
    closingApplication = true; let ownsTransition = false;
    try {
      if (sessionTransition) {
        post({ type: 'desktopError', error: '正在等待当前连接操作结束，随后退出应用。' });
        // Authentication has no unsaved document state; cancel a hanging SSH
        // handshake so quitting need not wait the full two-minute SSH timeout.
        backend?.connectingClient?.destroy();
        const deadline = Date.now() + 12000;
        while (sessionTransition) {
          if (Date.now() >= deadline) throw new Error('等待连接操作完成超时，请在当前连接操作结束后重试。');
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      sessionTransition = true; ownsTransition = true;
      if (workbench && !await workbench.confirmAll()) return false;
      if (!await terminalGuard.all()) return false;
      const failures = [];
      const closeStep = async (label, task, timeout) => {
        try { await shutdownDeadline(task, label, timeout); }
        catch (error) { failures.push(`${label}：${error.message}`); }
      };
      // Freeze editor input immediately after its save/discard decision, before
      // any potentially slow transport cleanup can allow new unsaved changes.
      await closeStep('关闭文档会话', () => workbench?.disconnect(), 1000);
      // Stop accepting local CLI requests before draining logs/resources. Each
      // cleanup has a deadline; a stuck network stream cannot hide the Exit UI.
      await closeStep('关闭本地接口', () => instanceBridge?.close());
      await closeStep('清理服务器资源', () => closeConnectionResources(), 8000);
      terminalStarts.clear();
      await closeStep('断开 SSH', () => backend?.disconnect()); desktopService = null;
      await closeStep('保存传输历史', () => transferCenter.flush());
      await closeStep('保存应用设置', () => settingsQueue);
      if (failures.length) {
        const choice = await dialog.showMessageBox(windowRef, { type: 'warning', title: 'Exit', message: '部分退出清理未完成。', detail: `${failures.join('\n')}\n\n文档关闭确认已经完成。退出可能保留尚未清理的传输临时文件或未写完的日志。`, buttons: ['返回桌面', '退出'], defaultId: 0, cancelId: 0, noLink: true });
        if (choice.response !== 1) {
          post({ type: 'remoteState', status: 'disconnected', message: 'SSH 已关闭；请重新连接，或再次选择 Exit。' });
          // A canceled shutdown must retain its local CLI entry point.
          await shutdownDeadline(() => instanceBridge?.start(), '恢复本地接口').catch(error => post({ type: 'desktopError', error: error.message }));
          return false;
        }
      }
      await closeStep('关闭文档资源', () => workbench?.dispose());
      allowWindowClose = true;
      // Resolve the IPC request before destroying its renderer.
      setImmediate(() => app.quit()); return true;
    } catch (error) {
      post({ type: 'desktopError', error: `关闭应用未完成：${error.message}` }); return false;
    } finally { closingApplication = false; if (ownsTransition) sessionTransition = false; quitPromise = null; }
  })();
  return quitPromise;
}
function closeConnectionResources() {
  const previousUploader = uploader, previousVideo = videoService;
  uploader = null; videoService = null; windowRef?.setTitle('Remote Desktop'); localPicker?.close(); selectedLocalPaths.clear(); selectedDownloadDirectories.clear();
  const cleanup = connectionCleanup.then(async () => {
    const results = await Promise.allSettled([browserManager?.disconnect(), workbench?.disconnect(), previousUploader?.close(), previousVideo?.disconnect()]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    await workspacePreferenceQueue.catch(() => {});
    activityLog.system({ type: 'connection-closed' });
    await activityLog.disconnect();
  });
  connectionCleanup = cleanup.catch(() => {});
  return cleanup;
}
async function upload(localPath, remoteDirectory, { id = crypto.randomUUID(), signal, onProgress, filesOnly = false, auditCommands = true } = {}) {
  const connection = requireBackend(), source = uploader;
  if (!source || sessionTransition) throw new Error('连接正在切换，请稍后传输。');
  const abort = () => source.cancel(id); signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('上传已取消。');
    return await transferCenter.run({ id, source: localPath, direction: 'upload', destination: remoteDirectory, targetDirectory: normalizeRemote(remoteDirectory), targetSide: 'remote', serverIdentity: transferIdentity(connection) }, progress => source.upload(localPath, remoteDirectory, { id, filesOnly, audit: auditCommands, onProgress: value => { progress(value); onProgress?.(value); } }), abort);
  } finally { signal?.removeEventListener('abort', abort); }
}
async function download(remotePath, { id = crypto.randomUUID(), destination, signal, onProgress, auditCommands = true } = {}) {
  const source = requireBackend();
  if (sessionTransition) throw new Error('连接正在切换，请稍后传输。');
  const abort = () => source.cancelDownload(id); signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('下载已取消。');
    const targetDirectory = path.resolve(destination || settings.defaultDownloadDirectory || app.getPath('downloads'));
    const result = await transferCenter.run({ id, source: remotePath, direction: 'download', destination: targetDirectory, targetDirectory, targetSide: 'local', serverIdentity: transferIdentity(source) }, progress => source.download(remotePath, { id, destination: targetDirectory, audit: auditCommands, onProgress: value => { progress(value); onProgress?.(value); } }), abort);
    completedDownloads.add(result.path); return result;
  } finally { signal?.removeEventListener('abort', abort); }
}
async function inspect(create = false, allowTransition = false) {
  const source = requireBackend();
  return queueWorkspacePreferences(async () => {
    const valid = () => currentSession(source) && (!sessionTransition || allowTransition);
    if (!valid()) return { cancelled: true };
    const service = desktopService;
    if (!source.remoteStorage || create) source.remoteStorage = await ensureRemoteStorage(source);
    if (!valid()) return { cancelled: true };
    const preferences = workspacePreferences(settings.workspaceLocations?.[source.desktopIdentity]);
    await activityLog.attach(source, source.remoteStorage.root, { directory: preferences.logPath || source.remoteStorage.log, preserveDirectoryMode: Boolean(preferences.logPath), isCurrent: valid });
    if (!valid()) return { cancelled: true };
    const logContext = activityLog.capture();
    for (const record of source.startupActivity || []) activityLog.system(record, logContext);
    source.startupActivity = null;
    bindCommandLogger(source);
    const remote = await service.inspect(false, settings.desktopLocations[source.desktopIdentity] || source.remoteStorage.desktop);
    if (!valid()) return { cancelled: true };
    post(remote);
    post({ type: 'interfacePreferences', settings: publicSettings() });
    if (remote.configError) post({ type: 'desktopError', error: remote.configError });
    return { ...remote, found: remote.status === 'ready', path: remote.rootPath, home: remote.homePath };
  });
}
async function serverInfo() {
  const source = backend, service = desktopService;
  try {
    if (source?.connected && service) {
      source.clockSnapshot ||= service.serverInfo().then(value => ({ ...value, localCapturedAt: Date.now() }));
      const result = await source.clockSnapshot;
      if (currentSession(source)) post({ ...result, epochMs: result.epochMs + Date.now() - result.localCapturedAt });
    }
  }
  catch (error) { if (currentSession(source)) post({ type: 'serverInfo', remote: true, available: false, error: error.message }); }
}
async function setDesktop(remotePath) {
  const source = requireBackend();
  if (sessionTransition) throw new Error('正在切换连接，请稍后选择桌面。');
  const target = normalizeRemote(remotePath);
  const identity = source.desktopIdentity, token = {};
  let previousPath, persisted = false;
  try {
    const result = await source.setDesktop(target, { beforeCommit: async () => {
      if (!currentSession(source) || sessionTransition) throw new Error('SSH 连接已改变，请重新选择桌面。');
      await saveSettings(current => {
        if (!currentSession(source) || sessionTransition) throw new Error('SSH 连接已改变，请重新选择桌面。');
        previousPath = current.desktopLocations[identity];
        desktopPreferenceWrites.set(identity, token);
        return { desktopLocations: { ...current.desktopLocations, [identity]: target } };
      });
      persisted = true;
      if (!currentSession(source)) throw new Error('SSH 连接已断开。');
    } });
    if (currentSession(source)) {
      activityLog.system({ type: 'desktop-changed', path: source.desktop });
    }
    return result;
  } catch (error) {
    // A disconnect while local storage is being written must not leave a
    // preference that was never committed by the active desktop transaction.
    if (persisted) {
      try {
        await saveSettings(current => {
          if (desktopPreferenceWrites.get(identity) !== token) return {};
          const locations = { ...current.desktopLocations };
          if (previousPath === undefined) delete locations[identity]; else locations[identity] = previousPath;
          desktopPreferenceWrites.delete(identity);
          return { desktopLocations: locations };
        });
      } catch (restoreError) { throw new Error(`${accessMessage(error, remotePath)}；恢复本地桌面位置失败：${restoreError.message}`); }
    }
    throw new Error(accessMessage(error, remotePath));
  }
}
function compatibilitySettings(requestId) { return { type: 'extensionSettings', requestId, hasWorkspace: false, target: 'user', settings: { openOnStartup: true, remoteRoot: '/', remoteHome: backend?.home || '', scriptEditor: 'monaco' } }; }
async function handleDesktopMessage(message) {
  if (!message || typeof message.type !== 'string') throw new Error('无效的桌面请求。');
  const type = message.type;
  if (type === 'ready' || type === 'getExtensionSettings') { post(compatibilitySettings(message.requestId)); if (type === 'ready' && backend?.connected) { post({ type: 'connectionInfo', profile: backend.connectionProfile }); await inspect(); await serverInfo(); } return; }
  if (type === 'toggleFullscreen') { windowRef.setFullScreen(!windowRef.isFullScreen()); post({ type: 'fullscreenResult', ok: true, message: '已切换全屏；F11 切换。' }); return; }
  if (type === 'getServerInfo') return serverInfo();
  requireBackend();
  if (type === 'createDesktop') { const result = await inspect(true); activityLog.system({ type: 'desktop-created', path: result.path, status: result.status, protocol: 'SFTP MKDIR' }); return; }
  if (type === 'readDirectory') {
    const source = backend, service = desktopService;
    try {
      const { resolvedPath, entries } = await audit('readDirectory', { protocol: 'SFTP REALPATH/READDIR', path: message.path }, async () => {
        const resolvedPath = normalizeRemote(await service.call('realpath', message.path));
        return { resolvedPath, entries: await service.entries(resolvedPath) };
      });
      if (currentSession(source)) post({ type: 'remoteDirectory', path: message.path, resolvedPath, requestId: message.requestId, entries });
    }
    catch (error) { if (currentSession(source)) post({ type: 'remoteDirectory', path: message.path, requestId: message.requestId, error: accessMessage(error, message.path), accessDenied: accessDenied(error) }); }
  } else if (type === 'refreshRemote') {
    await inspect(); for (const remotePath of [...new Set(message.paths || [])]) await handleDesktopMessage({ type: 'readDirectory', path: remotePath });
  } else if (type === 'saveDesktopConfig') {
    try { const config = await audit('saveDesktopConfig', { protocol: 'SFTP write/rename', path: backend.desktop }, () => desktopService.saveConfig(message.config)); post({ type: 'configSaved', ok: true, requestId: message.requestId, config }); }
    catch (error) { post({ type: 'configSaved', ok: false, requestId: message.requestId, error: error.message }); }
  } else if (type === 'pinApp' || type === 'unpinApp') {
    const config = await audit(type, { protocol: 'SFTP write/rename', program: message.app?.program, id: message.id }, () => desktopService.updatePinned(type === 'pinApp' ? message.app : null, type === 'unpinApp' ? message.id : null));
    post({ type: 'configUpdated', config });
  } else if (type === 'fileOperation') {
    try {
      if (message.operation === 'compress' && !message.format) {
        const source = requireBackend();
        const answer = await dialog.showMessageBox(windowRef, { type: 'question', title: '压缩文件', message: '选择服务器压缩格式', detail: '压缩文件将生成在当前目录，同名自动编号。', buttons: ['取消', '.tar.gz', '.zip'], defaultId: 1, cancelId: 0, noLink: true });
        if (!answer.response) { post({ type: 'operationResult', requestId: message.requestId, cancelled: true }); return; }
        if (!currentSession(source) || sessionTransition) throw new Error('SSH 连接已改变，未开始压缩。');
        message = { ...message, format: answer.response === 1 ? 'tar.gz' : 'zip' };
      }
      const result = await audit('fileOperation', { protocol: ['compress', 'extract'].includes(message.operation) ? 'SSH exec' : 'SFTP', operation: message.operation, paths: message.paths || message.clipboard?.paths, mode: message.clipboard?.mode, parent: message.parent, name: message.name }, () => desktopService.operate(message, async paths => {
        const answer = await dialog.showMessageBox(windowRef, { type: 'warning', title: '永久删除远程文件', message: `永久删除 ${paths.length} 个项目？`, detail: `${paths.slice(0, 8).join('\n')}\n远程文件不进入回收站。符号链接只删除链接本身。`, buttons: ['取消', '永久删除'], defaultId: 0, cancelId: 0, noLink: true });
        return answer.response === 1;
      }));
      post({ type: 'operationResult', requestId: message.requestId, ...result });
      post({ type: 'operationCommand', command: `# SFTP ${message.operation}`, status: result.cancelled ? 'cancelled' : 'success' });
    } catch (error) { post({ type: 'operationResult', requestId: message.requestId, success: false, error: error.message }); }
  } else if (type === 'openTerminal') {
    if (sessionTransition) throw new Error('正在关闭或切换连接，请稍后打开终端。');
    const token = {}, terminalBackend = backend, service = desktopService;
    const operationId = crypto.randomUUID(), terminalContext = activityLog.capture();
    const terminalLog = record => { if (currentSession(terminalBackend)) activityLog.system({ ...record, category: 'terminal', operationId, protocol: 'SSH exec + PTY' }, terminalContext); };
    if (terminalStarts.has(message.id)) throw new Error('终端 ID 已存在。');
    terminalStarts.set(message.id, token);
    const releaseTerminalLog = activityLog.retain(terminalContext); let terminalStarted = false;
    token.releaseLog = releaseTerminalLog;
    try {
      const cwd = await service.checked(message.path), program = message.program || 'shell';
      if (!['shell', 'vim', 'htop'].includes(program)) throw new Error('不支持的终端程序。');
      const filePath = message.filePath ? await service.checked(message.filePath) : undefined;
      let readOnly = Boolean(message.readOnly);
      if (filePath) {
        const access = await terminalBackend.checkFileAccess(filePath);
        if (!access.readable) { const error = new Error('无访问权限：当前 SSH 账号无法读取文件。'); error.code = 'EACCES'; throw error; }
        if (!access.writable && !readOnly) {
          const answer = await dialog.showMessageBox(windowRef, { type: 'warning', title: '无编辑权限', message: '该文件无编辑权限，是否只读打开？', detail: filePath, buttons: ['取消', '只读打开'], defaultId: 1, cancelId: 0, noLink: true });
          if (answer.response !== 1) { terminalStarts.delete(message.id); post({ type: 'terminalClosed', id: message.id }); return; }
        }
        readOnly ||= !access.writable;
      }
      if (sessionTransition || terminalStarts.get(message.id) !== token || backend !== terminalBackend || !terminalBackend.connected) return;
      const decoder = new StringDecoder('utf8');
      const output = text => {
        if (!text) return;
        terminalLog({ type: 'terminal-output', terminalId: message.id, data: text });
        post({ type: 'terminalData', id: message.id, data: text });
      };
      terminalLog({ type: 'terminal-open', terminalId: message.id, cwd, program, filePath, readOnly, protocol: 'SSH exec + PTY' });
      backend.openShell(message.id, cwd, data => output(decoder.write(data)), (error, code) => {
        output(decoder.end());
        terminalLog({ type: 'terminal-exit', terminalId: message.id, code: code ?? null, error: error?.message });
        releaseTerminalLog();
        terminalStarts.delete(message.id); post({ type: error ? 'terminalError' : 'terminalExit', id: message.id, error: error?.message, exitCode: code ?? 0 });
      }, { program, filePath, readOnly, cols: message.cols, rows: message.rows,
        onCommand: command => terminalLog({ type: 'terminal-command', terminalId: message.id, command }),
        onInput: data => terminalLog({ type: 'terminal-input', terminalId: message.id, data }),
        onReady: () => { token.ready = true; post({ type: 'terminalOpened', id: message.id }); } });
      terminalStarted = true;
    } catch (error) {
      terminalLog({ type: 'terminal-error', terminalId: message.id, error: error.message });
      if (terminalStarts.get(message.id) === token) {
        terminalStarts.delete(message.id);
        if (message.filePath && accessDenied(error)) post({ type: 'fileAccessError', id: message.id, path: message.filePath, error: accessMessage(error, message.filePath), accessDenied: true });
        else post({ type: 'terminalError', id: message.id, error: error.message });
      }
    } finally { if (!terminalStarted) releaseTerminalLog(); }
  } else if (type === 'terminalInput') backend.writeShell(message.id, message.data);
  else if (type === 'terminalResize') backend.resizeShell(message.id, message.cols, message.rows);
  else if (type === 'terminalClose') { await audit('terminalClose', { terminalId: message.id }, () => terminalGuard.request(message.id)); }
  else throw new Error('该功能未在独立应用中提供。');
}
async function connectSsh(input, trustedLocal = false) {
    if (closingApplication || connecting || sessionTransition) throw new Error('已有连接正在建立或关闭。'); connecting = true; sessionTransition = true;
    try {
      if (!await workbench?.confirmAll() || !await terminalGuard.all()) return { cancelled: true };
      await closeConnectionResources();
      terminalStarts.clear(); await backend?.disconnect(); desktopService = null;
      post({ type: 'remoteState', status: 'disconnected', message: '正在建立新的 SSH 连接。' });
      const profile = serverProfile({ ...input, id: input.profileId });
      const { host, port, username } = profile;
      const hostKey = `${host.toLowerCase()}:${port}`, known = settings.knownHosts[hostKey];
      if (known && input.hostKeyFingerprint && input.hostKeyFingerprint.replace(/=+$/, '') !== known) throw new Error('输入指纹与本机保存的指纹不同。连接已拒绝。');
      let privateKey;
      if (input.privateKeyPath) {
        const savedKey = settings.serverProfiles.some(saved => saved.privateKeyPath === input.privateKeyPath && saved.host === host && saved.port === port && saved.username === username);
        if (!trustedLocal && !selectedKeys.has(input.privateKeyPath) && !savedKey) throw new Error('请使用“选择私钥”按钮选择本地文件。');
        const stats = await fsp.stat(input.privateKeyPath);
        if (!stats.isFile() || stats.size > 1024 * 1024) throw new Error('私钥必须是小于 1 MiB 的普通文件。');
        privateKey = await fsp.readFile(input.privateKeyPath);
      }
      const startupActivity = [];
      const nextBackend = new SshBackend({ threshold: settings.downloadThreshold, downloadsPath: app.getPath('downloads'),
        onCommandActivity: record => { if (startupActivity.length < 100) startupActivity.push(record); },
        verifyHost: async info => {
          const answer = await dialog.showMessageBox(windowRef, { type: 'warning', title: '首次连接：核验 SSH 主机', message: `信任 ${info.host}:${info.port} 的主机密钥？`, detail: `SHA-256 指纹：\n${info.fingerprint}\n\n请与服务器管理员提供的指纹核对。确认后保存到本应用的已知主机记录。`, buttons: ['取消', '指纹无误，信任并连接'], defaultId: 0, cancelId: 0, noLink: true });
          return answer.response === 1;
        }, onDisconnect: () => { if (backend !== nextBackend) return; desktopService = null; terminalStarts.clear(); void closeConnectionResources().catch(error => post({ type: 'desktopError', error: `断线清理未完成：${error.message}` })); post({ type: 'remoteState', status: 'disconnected', message: 'SSH 连接已断开，请重新连接。' }); } });
      backend = nextBackend;
      backend.startupActivity = startupActivity;
      let result;
      try { result = await backend.connect({ host, port, username, password: input.password, privateKey, passphrase: input.passphrase, hostKeyFingerprint: known || input.hostKeyFingerprint }); }
      finally { privateKey?.fill(0); }
      desktopService = backend.desktopService();
      uploader = new UploadService(backend);
      videoService = new VideoService(backend);
      backend.desktopIdentity = desktopIdentity({ host, port, username, hostFingerprint: result.hostFingerprint });
      if (profile.aliasAuto && profile.alias === 'Unknown Server') {
        try { profile.alias = automaticServerAlias(await desktopService.systemInfo()); }
        catch { /* Keep Unknown Server when system metadata is unavailable. */ }
      }
      await saveSettings(current => ({ host, port, username, alias: profile.alias, privateKeyPath: input.privateKeyPath || null, ...upsertProfile(current.serverProfiles, profile), hostKeyFingerprint: result.hostFingerprint, knownHosts: { ...current.knownHosts, [hostKey]: result.hostFingerprint } }));
      result = { ...result, alias: profile.alias, aliasAuto: profile.aliasAuto, port, address: backend.client?._sock?.remoteAddress || host };
      windowRef.setTitle(connectionTitle(profile, result.address));
      backend.connectionProfile = { ...profile, address: result.address };
      post({ type: 'connectionInfo', profile: backend.connectionProfile });
      try { await inspect(false, true); } catch (error) { post({ type: 'remoteState', status: 'error', homePath: backend.home, message: accessMessage(error, settings.desktopLocations[backend.desktopIdentity]) }); }
      if (!trustedLocal) activityLog.system({ type: 'ssh-connected', host, port, username, home: backend.home, desktop: backend.desktop });
      await serverInfo(); return result;
    } finally { connecting = false; sessionTransition = false; }
}

function registerIpc() {
  const audited = {
    'app:save-settings': patch => ({ downloadThreshold: patch?.downloadThreshold }),
    'terminal:close': id => ({ terminalId: id }),
    'ssh:list': path => ({ path, protocol: 'SFTP READDIR' }),
    'ssh:system-info': () => ({ protocol: 'SSH exec' }),
    'ssh:set-desktop': path => ({ path, protocol: 'SFTP REALPATH/READDIR' }),
    'ssh:file-access': path => ({ path, protocol: 'SSH test -r / test -w' }),
    'ssh:image': path => ({ path, protocol: 'SFTP READ' }),
    'ssh:download': (path, id, destination) => ({ path, id, destination, protocol: 'SSH cat / SFTP (automatic)' }),
    'transfer:upload': (localPath, remoteDirectory, id) => ({ localPath, remoteDirectory, id, protocol: 'SSH cat / SFTP (automatic)' }),
    'ssh:cancel-download': id => ({ id }),
    'workbench:open': (path, options) => ({ path, readOnly: Boolean(options?.readOnly), protocol: 'SFTP READ' }),
    'browser:open': url => ({ url: safeUrl(url || 'http://localhost:8888'), protocol: 'HTTP(S) over SSH' }),
    'browser:close': id => ({ id }),
    'ssh:open-local': path => ({ path })
  };
  const handle = (channel, action) => ipcMain.handle(channel, (event, ...args) => {
    requireSender(event);
    return audited[channel] ? audit(channel, audited[channel](...args), () => action(...args)) : action(...args);
  });
  handle('activity:snapshot', () => activityLog.snapshot());
  handle('terminal:clipboard-read', async () => clipboardText(await clipboard.readText()));
  handle('terminal:clipboard-write', async text => { await clipboard.writeText(clipboardText(text)); return true; });
  handle('app:get-settings', () => publicSettings());
  handle('terminal:open-local', async cwd => {
    const source = requireBackend();
    if (sessionTransition || !instanceBridge?.instanceId) throw new Error('连接正在切换，请稍后打开本机终端。');
    const target = await desktopService.checked(cwd || source.home);
    if (!currentSession(source) || sessionTransition) throw new Error('SSH 连接已改变。');
    return launchLocalTerminal({ executable: process.execPath, cliPath: app.isPackaged ? path.join(process.resourcesPath, 'cli/scripts/cli.cjs') : path.join(__dirname, 'scripts/cli.cjs'), userDataDir: app.getPath('userData'), instanceId: instanceBridge.instanceId, cwd: target, identity: source.desktopIdentity });
  });
  handle('app:quit', () => quitSafely());
  handle('app:save-shell-preferences', async input => {
    const saved = await saveSettings({ shellPreferences: shellPreferences(input) });
    post({ type: 'interfacePreferences', settings: saved }); return saved;
  });
  handle('app:save-context-menu-preferences', async input => {
    const saved = await saveSettings({ contextMenuPreferences: contextMenuPreferences(input, true) });
    post({ type: 'interfacePreferences', settings: saved }); return saved;
  });
  handle('app:save-workspace-preferences', (input, identity) => {
    return queueWorkspacePreferences(async () => {
      const source = requireBackend();
      const valid = () => currentSession(source) && !sessionTransition;
      if (!valid() || identity !== source.desktopIdentity) throw new Error('SSH 连接已改变，请重新打开设置。');
      const next = workspacePreferences(input, true), previous = workspacePreferences(settings.workspaceLocations?.[identity]);
      for (const target of [next.logPath, next.trashPath, ...next.shortcuts.map(item => item.path)].filter(Boolean)) {
        try { await desktopService.entries(target); } catch (error) { throw new Error(accessMessage(error, target)); }
        if (!valid()) throw new Error('SSH 连接已改变，未保存目录设置。');
      }
      const attachLog = value => activityLog.attach(source, source.remoteStorage.root, { directory: value.logPath || source.remoteStorage.log, preserveDirectoryMode: Boolean(value.logPath), isCurrent: valid });
      if (next.logPath !== previous.logPath) {
        const result = await attachLog(next);
        if (result.error || !valid()) {
          if (valid()) await attachLog(previous);
          throw new Error(result.error || 'SSH 连接已改变。');
        }
      }
      try {
        const saved = await saveSettings(current => {
          if (!valid()) throw new Error('SSH 连接已改变，未保存目录设置。');
          return { workspaceLocations: { ...current.workspaceLocations, [identity]: next } };
        });
        bindCommandLogger(source);
        post({ type: 'interfacePreferences', settings: saved }); return saved;
      } catch (error) {
        if (valid() && next.logPath !== previous.logPath) await attachLog(previous);
        throw error;
      }
    });
  });
  handle('app:program-preferences', async (action, id) => {
    const saved = await saveSettings(current => ({ programPreferences: updateProgramPreferences(current.programPreferences, action, id) }));
    post({ type: 'programPreferences', preferences: saved.programPreferences });
    return saved.programPreferences;
  });
  handle('app:save-server', async input => {
    const profile = serverProfile(input);
    if (profile.privateKeyPath && !selectedKeys.has(profile.privateKeyPath) && !settings.serverProfiles.some(saved => saved.privateKeyPath === profile.privateKeyPath && saved.host === profile.host && saved.port === profile.port && saved.username === profile.username)) throw new Error('请使用“选择私钥”按钮选择本地文件。');
    return saveSettings(current => upsertProfile(current.serverProfiles, profile));
  });
  handle('app:connection-port', async (port, identity) => {
    const source = requireBackend();
    if (sessionTransition || identity !== source.desktopIdentity) throw new Error('SSH 连接已改变，请重新打开设置。');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须为 1–65535 的整数。');
    const profile = serverProfile({ ...source.connectionProfile, port });
    const saved = await saveSettings(current => {
      if (!currentSession(source) || sessionTransition) throw new Error('SSH 连接已改变，端口未保存。');
      return upsertProfile(current.serverProfiles, profile);
    });
    return { settings: saved, profile };
  });
  handle('app:save-settings', async patch => {
    const threshold = Number(patch?.downloadThreshold);
    if (!Number.isSafeInteger(threshold) || threshold < 1048576 || threshold > 1073741824) throw new Error('下载阈值必须为 1–1024 MiB。');
    const directories = {}, source = backend?.connected ? backend : null;
    if (patch.workspaceIdentity !== undefined && patch.workspaceIdentity !== (source?.desktopIdentity || '')) throw new Error('SSH 连接已改变，请重新打开设置。');
    if (patch.defaultUploadDirectory !== undefined) {
      directories.defaultUploadDirectory = transferDirectory(patch.defaultUploadDirectory, 'remote');
      if (directories.defaultUploadDirectory && directories.defaultUploadDirectory !== publicSettings().defaultUploadDirectory) {
        requireBackend();
        await desktopService.entries(directories.defaultUploadDirectory);
        if (!currentSession(source) || sessionTransition) throw new Error('SSH 连接已改变，请重新设置上传目录。');
      }
    }
    if (patch.defaultDownloadDirectory !== undefined) {
      directories.defaultDownloadDirectory = transferDirectory(patch.defaultDownloadDirectory, 'local');
      if (directories.defaultDownloadDirectory && !(await fsp.stat(directories.defaultDownloadDirectory)).isDirectory()) throw new Error('默认下载位置必须是文件夹。');
    }
    const saved = await saveSettings(current => {
      if (source && (!currentSession(source) || sessionTransition)) throw new Error('SSH 连接已改变，请重新保存。');
      const { defaultUploadDirectory, ...local } = directories;
      return { downloadThreshold: threshold, scriptEditor: 'monaco', ...local,
        ...(source && defaultUploadDirectory !== undefined ? { transferUploadDirectories: { ...current.transferUploadDirectories, [source.desktopIdentity]: defaultUploadDirectory } } : {}) };
    });
    if (backend) backend.threshold = threshold;
    return saved;
  });
  handle('app:choose-download-directory', async () => {
    const result = await dialog.showOpenDialog(windowRef, { title: '选择默认下载目录', defaultPath: settings.defaultDownloadDirectory || app.getPath('downloads'), properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('app:quit-fullscreen', () => { windowRef.setFullScreen(false); return true; });
  handle('terminal:close', id => terminalGuard.request(id));
  handle('app:choose-private-key', async () => {
    const result = await dialog.showOpenDialog(windowRef, { properties: ['openFile'], title: '选择 SSH 私钥' });
    if (result.canceled) return null; const selected = result.filePaths[0]; selectedKeys.add(selected); return selected;
  });
  handle('ssh:connect', input => connectSsh(input));
  handle('ssh:disconnect', async () => {
    if (sessionTransition) return false; sessionTransition = true;
    try {
      if (!await workbench?.confirmAll() || !await terminalGuard.all()) return false;
      await closeConnectionResources();
      terminalStarts.clear(); await backend?.disconnect(); desktopService = null;
      post({ type: 'remoteState', status: 'disconnected', message: 'SSH 已断开。' }); return true;
    } finally { sessionTransition = false; }
  });
  handle('ssh:discover-desktop', create => inspect(Boolean(create)));
  handle('ssh:list', async remotePath => {
    const source = requireBackend();
    try { const entries = await desktopService.entries(remotePath); if (!currentSession(source)) throw new Error('SSH 连接已改变。'); return entries; }
    catch (error) { throw new Error(accessMessage(error, remotePath)); }
  });
  handle('ssh:system-info', () => { requireBackend(); return desktopService.systemInfo(); });
  handle('ssh:set-desktop', setDesktop);
  handle('ssh:file-access', async remotePath => {
    const source = requireBackend();
    try {
      const result = await source.checkFileAccess(remotePath);
      if (!currentSession(source)) throw new Error('SSH 连接已改变。');
      return { ...result, ...(!result.readable ? { error: `无访问权限：${remotePath} — 当前 SSH 账号无法读取文件 (EACCES)` } : {}) };
    } catch (error) { throw new Error(accessMessage(error, remotePath)); }
  });
  handle('ssh:image', async remotePath => {
    try { return await requireBackend().readImage(remotePath); }
    catch (error) { throw new Error(accessMessage(error, remotePath)); }
  });
  handle('video:open', remotePath => { requireBackend(); if (sessionTransition || !videoService) throw new Error('SSH 连接正在切换。'); return audit('video:open', { path: remotePath, protocol: 'SFTP READ / HTTP Range' }, () => videoService.open(remotePath)); });
  handle('video:release', id => videoService?.release(id));
  handle('ssh:download', (remotePath, id, destination) => {
    if (destination && !selectedDownloadDirectories.has(destination)) throw new Error('请先选择本地下载目录。');
    return download(remotePath, { id, destination });
  });
  handle('transfer:choose-local', async kind => {
    const source = requireBackend();
    const paths = await localPicker.choose(kind);
    if (!currentSession(source) || sessionTransition) return [];
    return registerLocalPaths(paths, selectedLocalPaths, () => currentSession(source) && !sessionTransition);
  });
  handle('transfer:accept-drop', async paths => {
    const source = requireBackend();
    return registerLocalPaths(paths, selectedLocalPaths, () => currentSession(source) && !sessionTransition);
  });
  handle('transfer:choose-download-directory', async () => {
    const source = requireBackend();
    const result = await dialog.showOpenDialog(windowRef, { title: '选择本地保存目录', defaultPath: settings.defaultDownloadDirectory || app.getPath('downloads'), properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !currentSession(source) || sessionTransition) return null; selectedDownloadDirectories.add(result.filePaths[0]); return result.filePaths[0];
  });
  handle('transfer:upload', (localPath, remoteDirectory, id) => {
    if (!selectedLocalPaths.has(localPath)) throw new Error('请使用选择按钮选择本地文件。');
    return upload(localPath, remoteDirectory, { id, filesOnly: true });
  });
  handle('transfer:list', () => transferCenter.publicList());
  handle('transfer:remove', id => transferCenter.remove(id));
  handle('transfer:clear', () => transferCenter.clearHistory());
  handle('transfer:open-target', id => openTransferTarget(transferCenter.get(id), { getBackend: requireBackend, shell }));
  handle('ssh:cancel-download', id => { return browserManager?.cancel(id) || transferCenter.cancel(id) || backend?.cancelDownload(id) || false; });
  handle('workbench:open', (remotePath, options) => { requireBackend(); if (sessionTransition) throw new Error('SSH 连接正在切换。'); return workbench.open(remotePath, { readOnly: Boolean(options?.readOnly) }); });
  handle('workbench:embedded-call', (id, action, payload) => workbench.call(id, action, payload));
  handle('workbench:list', () => workbench.list());
  handle('browser:open', url => { requireBackend(); if (sessionTransition) throw new Error('SSH 连接正在切换。'); return browserManager.open(url); });
  handle('browser:layout', (id, bounds, hidden, snapshot) => browserManager.setLayout(id, bounds, Boolean(hidden), Boolean(snapshot)));
  handle('browser:close', id => browserManager.close(id));
  handle('ssh:open-local', filePath => { if (!completedDownloads.has(filePath)) throw new Error('只能定位当前应用完成下载的文件。'); shell.showItemInFolder(filePath); });
  ipcMain.on('desktop:send', (event, message) => { try { requireSender(event); handleDesktopMessage(message).catch(error => post({ type: 'desktopError', error: error.message })); } catch {} });
}
app.whenReady().then(async () => {
  await loadSettings();
  let historyWarning;
  try { await transferCenter.load(path.join(app.getPath('userData'), 'transfer-history.json')); } catch (error) { historyWarning = `无法读取传输历史：${error.message}`; }
  localPicker = new LocalPicker({ dialog, getParent: () => windowRef });
  const logging = { audit, captureLog: source => (!source || currentSession(source)) ? activityLog.capture() : null, log: (record, context) => activityLog.system(record, context) };
  workbench = createWorkbenchManager({ ...logging, embedded: true, onEvent: value => send('workbench:event', value), getBackend: requireBackend, getParent: () => windowRef, getConnectionId: () => backend?.client, createPreview: (remotePath, options) => browserManager.createPreview(remotePath, options) });
  browserManager = createBrowserManager({ ...logging, embedded: true, getBackend: requireBackend, getParent: () => windowRef, onEvent: value => send('browser:event', value), onTransfer: value => transferCenter.update({ ...value, status: value.status === 'completed' ? 'complete' : value.status }),
    getDownloadsPath: () => settings.defaultDownloadDirectory || app.getPath('downloads'),
    uploadFile: ({ localPath, remoteDirectory, id, signal, onProgress }) => { requireBackend(); if (!uploader || sessionTransition) throw new Error('SSH 连接正在切换。'); return uploader.upload(localPath, remoteDirectory, { id, signal, onProgress }); } });
  registerIpc(); createWindow();
  if (historyWarning) windowRef.webContents.once('did-finish-load', () => post({ type: 'desktopError', error: historyWarning }));
  instanceBridge = new InstanceBridge({ userDataDir: app.getPath('userData'), onActivity: bridgeActivity, metadata: { pid: process.pid, executable: process.execPath }, callbacks: {
    status: async () => ({ connected: Boolean(backend?.connected), host: settings.host, port: settings.port, username: settings.username, privateKeyPath: settings.privateKeyPath, desktop: backend?.desktop, home: backend?.home, identity: backend?.desktopIdentity }),
    focus: async () => { windowRef.show(); windowRef.focus(); return { ok: true }; },
    shell: async (input, context) => {
      const source = requireBackend();
      if (sessionTransition || (input.identity && input.identity !== source.desktopIdentity)) throw new Error('SSH 连接已改变，请重新打开本机终端。');
      const cwd = await desktopService.checked(input.cwd || source.home);
      if (!currentSession(source) || sessionTransition) throw new Error('SSH 连接已改变。');
      return openInteractiveShell(source, { ...input, cwd }, context);
    },
    connect: input => connectSsh(input, true),
    exec: (input, context) => { if (sessionTransition) throw new Error('SSH 连接正在切换。'); return executeRemote(requireBackend(), input, { ...context, onCommand: command => context.onProgress({ kind: 'command', data: command }) }); },
    upload: (input, context) => upload(input.localPath, input.remoteDirectory, { id: input.id, ...context, auditCommands: false }),
    download: (input, context) => download(input.remotePath, { id: input.id, destination: input.destination, ...context, auditCommands: false }),
    cancel: async input => browserManager.cancel(input.id) || transferCenter.cancel(input.id)
  } });
  try { await instanceBridge.start(); } catch(error) { post({type:'desktopError',error:`本地命令行接口启动失败：${error.message}`}); }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (allowWindowClose) return;
  event.preventDefault(); void quitSafely();
});
