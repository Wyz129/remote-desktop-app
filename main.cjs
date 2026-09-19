'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
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
const { createAuditor, safeUrl } = require('./lib/activity-audit.cjs');
const { UploadService } = require('./lib/upload-service.cjs');
const { InstanceBridge, executeRemote } = require('./lib/instance-bridge.cjs');
const { TransferCenter } = require('./lib/transfer-center.cjs');
const { LocalPicker } = require('./lib/local-picker.cjs');
const { registerLocalPaths, transferIdentity, openTransferTarget } = require('./lib/transfer-targets.cjs');
const { createWorkbenchManager } = require('./lib/workbench-manager.cjs');
const { createBrowserManager } = require('./lib/browser-manager.cjs');

const userDataArgument = process.argv.find(arg => arg.startsWith('--user-data-dir='));
if (userDataArgument) app.setPath('userData', path.resolve(userDataArgument.slice('--user-data-dir='.length)));
let windowRef, backend, desktopService, connecting = false;
let uploader, instanceBridge, workbench, browserManager, localPicker;
const activityLog = new ActivityLog({ onEvent: value => send('activity:event', value) });
const audit = createAuditor(activityLog);
const cliActivity = new Map();
const transferCenter = new TransferCenter(value => send('download:progress', value));
const selectedLocalPaths = new Set(), selectedDownloadDirectories = new Set();
let settings = { downloadThreshold: DEFAULT_THRESHOLD, scriptEditor: 'monaco', knownHosts: {}, desktopLocations: {} };
let settingsQueue = Promise.resolve();
const selectedKeys = new Set();
const completedDownloads = new Set();
const terminalStarts = new Map();
const desktopPreferenceWrites = new Map();
let sessionTransition = false, allowWindowClose = false, closingApplication = false;
let connectionCleanup = Promise.resolve();
const terminalGuard = new TerminalGuard({ getBackend: () => backend,
  onAction: (record, source) => { if (currentSession(source)) activityLog.system(record); },
  closed: id => { terminalStarts.delete(id); post({ type: 'terminalClosed', id }); } });
const entryPath = path.join(__dirname, 'app', 'index.html');
const entryUrl = pathToFileURL(entryPath).href;
function requireSender(event) {
  if (!windowRef || event.sender !== windowRef.webContents || event.senderFrame?.url !== entryUrl) throw new Error('拒绝非应用窗口的请求。');
}
function requireBackend() { if (!backend?.connected || !desktopService) throw new Error('尚未连接 SSH。'); return backend; }
function publicSettings() { const { knownHosts, desktopLocations, ...visible } = settings; return { ...visible, downloadsPath: app.getPath('downloads') }; }
function currentSession(source) { return Boolean(source && source === backend && source.connected); }
function accessDenied(error) { return [3, 'EACCES', 'EPERM'].includes(error?.code); }
function accessMessage(error, remotePath) { return `${accessDenied(error) ? '无访问权限：' : ''}${remotePath ? `${remotePath} — ` : ''}${error.message}${error.code !== undefined ? ` (${error.code})` : ''}`; }
async function loadSettings() {
  try { const loaded = JSON.parse(await fsp.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8')); settings = { ...settings, ...Object.fromEntries(Object.entries(loaded).filter(([key]) => ['host', 'port', 'username', 'hostKeyFingerprint', 'knownHosts', 'downloadThreshold', 'desktopLocations', 'privateKeyPath'].includes(key))) }; } catch (error) { if (error.code !== 'ENOENT') settings.loadWarning = '本地设置不可读，已使用默认值。'; }
  if (!settings.knownHosts || typeof settings.knownHosts !== 'object' || Array.isArray(settings.knownHosts)) settings.knownHosts = {};
  if (!Number.isSafeInteger(settings.downloadThreshold) || settings.downloadThreshold < 1048576 || settings.downloadThreshold > 1073741824) settings.downloadThreshold = DEFAULT_THRESHOLD;
  settings.scriptEditor = 'monaco';
  settings.desktopLocations = desktopLocations(settings.desktopLocations);
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
function bridgeActivity(event) {
  const id = event.connection.id;
  if (event.type === 'start' && event.action === 'connect') return;
  let session = cliActivity.get(id);
  if (!session) {
    const address = backend?.client?._sock?.localAddress;
    session = activityLog.beginCli({ id, time: event.connection.connectedAt, transport: event.connection.transport, action: event.action,
      ip: net.isIP(address || '') ? address : null, ipSource: 'ssh-local-address' });
    cliActivity.set(id, session);
    activityLog.cli(id, { type: 'command', action: event.action, args: event.args });
  }
  if (event.type === 'progress') {
    const progress = event.progress;
    activityLog.cli(id, ['stdout', 'stderr'].includes(progress?.kind) ? { type: progress.kind, data: progress.data } : { type: 'progress', progress });
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
  windowRef.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { event.preventDefault(); windowRef.setFullScreen(!windowRef.isFullScreen()); }
    else if (input.key === 'Escape' && windowRef.isFullScreen()) windowRef.setFullScreen(false);
  });
  windowRef.loadFile(entryPath);
  windowRef.on('close', event => { if (!allowWindowClose) { event.preventDefault(); void quitSafely(); } });
  windowRef.on('closed', () => { windowRef = null; backend?.disconnect(); });
}
async function quitSafely() {
  if (closingApplication || sessionTransition) return;
  closingApplication = true; sessionTransition = true;
  try {
    if (!await workbench?.confirmAll() || !await terminalGuard.all()) return;
    await closeConnectionResources();
    terminalStarts.clear(); await backend?.disconnect(); await instanceBridge?.close(); await transferCenter.flush(); allowWindowClose = true; app.quit();
  } catch (error) { post({ type: 'desktopError', error: `关闭应用未完成：${error.message}` });
  } finally { closingApplication = false; sessionTransition = false; }
}
function closeConnectionResources() {
  const previousUploader = uploader;
  uploader = null; localPicker?.close(); selectedLocalPaths.clear(); selectedDownloadDirectories.clear();
  const cleanup = connectionCleanup.then(async () => {
    const results = await Promise.allSettled([browserManager?.disconnect(), workbench?.disconnect(), previousUploader?.close()]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    activityLog.system({ type: 'connection-closed' });
    await activityLog.disconnect();
  });
  connectionCleanup = cleanup.catch(() => {});
  return cleanup;
}
async function upload(localPath, remoteDirectory, { id = crypto.randomUUID(), signal, onProgress, filesOnly = false } = {}) {
  const connection = requireBackend(), source = uploader;
  if (!source || sessionTransition) throw new Error('连接正在切换，请稍后传输。');
  const abort = () => source.cancel(id); signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('上传已取消。');
    return await transferCenter.run({ id, source: localPath, direction: 'upload', destination: remoteDirectory, targetDirectory: normalizeRemote(remoteDirectory), targetSide: 'remote', serverIdentity: transferIdentity(connection) }, progress => source.upload(localPath, remoteDirectory, { id, filesOnly, onProgress: value => { progress(value); onProgress?.(value); } }), abort);
  } finally { signal?.removeEventListener('abort', abort); }
}
async function download(remotePath, { id = crypto.randomUUID(), destination, signal, onProgress } = {}) {
  const source = requireBackend();
  if (sessionTransition) throw new Error('连接正在切换，请稍后传输。');
  const abort = () => source.cancelDownload(id); signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('下载已取消。');
    const targetDirectory = path.resolve(destination || app.getPath('downloads'));
    const result = await transferCenter.run({ id, source: remotePath, direction: 'download', destination: targetDirectory, targetDirectory, targetSide: 'local', serverIdentity: transferIdentity(source) }, progress => source.download(remotePath, { id, destination: targetDirectory, onProgress: value => { progress(value); onProgress?.(value); } }), abort);
    completedDownloads.add(result.path); return result;
  } finally { signal?.removeEventListener('abort', abort); }
}
async function inspect(create = false) {
  const source = requireBackend();
  const remote = await desktopService.inspect(create, create ? null : settings.desktopLocations[source.desktopIdentity]);
  if (!currentSession(source)) return { cancelled: true };
  if (remote.status === 'ready') await activityLog.attach(source, source.desktop);
  post(remote);
  if (remote.configError) post({ type: 'desktopError', error: remote.configError });
  return { ...remote, found: remote.status === 'ready', path: remote.rootPath, home: remote.homePath };
}
async function serverInfo() {
  const source = backend, service = desktopService;
  try { if (source?.connected && service) { const result = await service.serverInfo(); if (currentSession(source)) post(result); } }
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
      await activityLog.attach(source, source.desktop);
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
  if (type === 'ready' || type === 'getExtensionSettings') { post(compatibilitySettings(message.requestId)); if (type === 'ready' && backend?.connected) { await inspect(); await serverInfo(); } return; }
  if (type === 'toggleFullscreen') { windowRef.setFullScreen(!windowRef.isFullScreen()); post({ type: 'fullscreenResult', ok: true, message: '已切换全屏；Esc 退出全屏，F11 切换。' }); return; }
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
      const result = await audit('fileOperation', { protocol: 'SFTP', operation: message.operation, paths: message.paths || message.clipboard?.paths, mode: message.clipboard?.mode, parent: message.parent, name: message.name }, () => desktopService.operate(message, async paths => {
        const answer = await dialog.showMessageBox(windowRef, { type: 'warning', title: '永久删除远程文件', message: `永久删除 ${paths.length} 个项目？`, detail: `${paths.slice(0, 8).join('\n')}\n远程文件不进入回收站。符号链接只删除链接本身。`, buttons: ['取消', '永久删除'], defaultId: 0, cancelId: 0, noLink: true });
        return answer.response === 1;
      }));
      post({ type: 'operationResult', requestId: message.requestId, ...result });
      post({ type: 'operationCommand', command: `# SFTP ${message.operation}`, status: result.cancelled ? 'cancelled' : 'success' });
    } catch (error) { post({ type: 'operationResult', requestId: message.requestId, success: false, error: error.message }); }
  } else if (type === 'openTerminal') {
    if (sessionTransition) throw new Error('正在关闭或切换连接，请稍后打开终端。');
    const token = {}, terminalBackend = backend, service = desktopService;
    const terminalLog = record => { if (currentSession(terminalBackend)) activityLog.system(record); };
    if (terminalStarts.has(message.id)) throw new Error('终端 ID 已存在。');
    terminalStarts.set(message.id, token);
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
        terminalStarts.delete(message.id); post({ type: error ? 'terminalError' : 'terminalExit', id: message.id, error: error?.message, exitCode: code ?? 0 });
      }, { program, filePath, readOnly, cols: message.cols, rows: message.rows,
        onCommand: command => terminalLog({ type: 'terminal-command', terminalId: message.id, command }),
        onReady: () => post({ type: 'terminalOpened', id: message.id }) });
    } catch (error) {
      terminalLog({ type: 'terminal-error', terminalId: message.id, error: error.message });
      if (terminalStarts.get(message.id) === token) {
        terminalStarts.delete(message.id);
        if (message.filePath && accessDenied(error)) post({ type: 'fileAccessError', id: message.id, path: message.filePath, error: accessMessage(error, message.filePath), accessDenied: true });
        else post({ type: 'terminalError', id: message.id, error: error.message });
      }
    }
  } else if (type === 'terminalInput') backend.writeShell(message.id, message.data);
  else if (type === 'terminalResize') backend.resizeShell(message.id, message.cols, message.rows);
  else if (type === 'terminalClose') { await audit('terminalClose', { terminalId: message.id }, () => terminalGuard.request(message.id)); }
  else throw new Error('该功能未在独立应用中提供。');
}
async function connectSsh(input, trustedLocal = false) {
    if (connecting || sessionTransition) throw new Error('已有连接正在建立或关闭。'); connecting = true; sessionTransition = true;
    try {
      if (!await workbench?.confirmAll() || !await terminalGuard.all()) return { cancelled: true };
      await closeConnectionResources();
      terminalStarts.clear(); await backend?.disconnect(); desktopService = null;
      post({ type: 'remoteState', status: 'disconnected', message: '正在建立新的 SSH 连接。' });
      const host = String(input.host || '').trim(), port = Number(input.port) || 22, username = String(input.username || '').trim();
      const hostKey = `${host.toLowerCase()}:${port}`, known = settings.knownHosts[hostKey];
      if (known && input.hostKeyFingerprint && input.hostKeyFingerprint.replace(/=+$/, '') !== known) throw new Error('输入指纹与本机保存的指纹不同。连接已拒绝。');
      let privateKey;
      if (input.privateKeyPath) {
        const savedKey = settings.privateKeyPath === input.privateKeyPath && settings.host === host && settings.port === port && settings.username === username;
        if (!trustedLocal && !selectedKeys.has(input.privateKeyPath) && !savedKey) throw new Error('请使用“选择私钥”按钮选择本地文件。');
        const stats = await fsp.stat(input.privateKeyPath);
        if (!stats.isFile() || stats.size > 1024 * 1024) throw new Error('私钥必须是小于 1 MiB 的普通文件。');
        privateKey = await fsp.readFile(input.privateKeyPath);
      }
      const nextBackend = new SshBackend({ threshold: settings.downloadThreshold, downloadsPath: app.getPath('downloads'),
        verifyHost: async info => {
          const answer = await dialog.showMessageBox(windowRef, { type: 'warning', title: '首次连接：核验 SSH 主机', message: `信任 ${info.host}:${info.port} 的主机密钥？`, detail: `SHA-256 指纹：\n${info.fingerprint}\n\n请与服务器管理员提供的指纹核对。确认后保存到本应用的已知主机记录。`, buttons: ['取消', '指纹无误，信任并连接'], defaultId: 0, cancelId: 0, noLink: true });
          return answer.response === 1;
        }, onDisconnect: () => { if (backend !== nextBackend) return; desktopService = null; terminalStarts.clear(); void closeConnectionResources().catch(error => post({ type: 'desktopError', error: `断线清理未完成：${error.message}` })); post({ type: 'remoteState', status: 'disconnected', message: 'SSH 连接已断开，请重新连接。' }); } });
      backend = nextBackend;
      let result;
      try { result = await backend.connect({ host, port, username, password: input.password, privateKey, passphrase: input.passphrase, hostKeyFingerprint: known || input.hostKeyFingerprint }); }
      finally { privateKey?.fill(0); }
      desktopService = backend.desktopService();
      uploader = new UploadService(backend);
      backend.desktopIdentity = desktopIdentity({ host, port, username, hostFingerprint: result.hostFingerprint });
      await saveSettings({ host, port, username, privateKeyPath: input.privateKeyPath || null, hostKeyFingerprint: result.hostFingerprint, knownHosts: { ...settings.knownHosts, [hostKey]: result.hostFingerprint } });
      try { await inspect(); } catch (error) { post({ type: 'remoteState', status: 'error', homePath: backend.home, message: accessMessage(error, settings.desktopLocations[backend.desktopIdentity]) }); }
      if (!trustedLocal) activityLog.system({ type: 'ssh-connected', host, port, username, home: backend.home, desktop: backend.desktop });
      await serverInfo(); return result;
    } finally { connecting = false; sessionTransition = false; }
}

function registerIpc() {
  const audited = {
    'app:save-settings': patch => ({ downloadThreshold: patch?.downloadThreshold }),
    'terminal:close': id => ({ terminalId: id }),
    'ssh:list': path => ({ path, protocol: 'SFTP READDIR' }),
    'ssh:system-info': () => ({ protocol: 'SSH exec', command: 'read system information' }),
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
  handle('app:get-settings', () => publicSettings());
  handle('app:save-settings', patch => {
    const threshold = Number(patch?.downloadThreshold);
    if (!Number.isSafeInteger(threshold) || threshold < 1048576 || threshold > 1073741824) throw new Error('下载阈值必须为 1–1024 MiB。');
    if (backend) backend.threshold = threshold;
    return saveSettings({ downloadThreshold: threshold, scriptEditor: 'monaco' });
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
    const result = await dialog.showOpenDialog(windowRef, { title: '选择本地保存目录', properties: ['openDirectory', 'createDirectory'] });
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
  handle('browser:open', url => { requireBackend(); if (sessionTransition) throw new Error('SSH 连接正在切换。'); return browserManager.open(url); });
  handle('browser:layout', (id, bounds, hidden) => browserManager.setLayout(id, bounds, Boolean(hidden)));
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
  workbench = createWorkbenchManager({ ...logging, getBackend: requireBackend, getParent: () => windowRef, getConnectionId: () => backend?.client, createPreview: (remotePath, options) => browserManager.createPreview(remotePath, options) });
  browserManager = createBrowserManager({ ...logging, embedded: true, getBackend: requireBackend, getParent: () => windowRef, onEvent: value => send('browser:event', value), onTransfer: value => transferCenter.update({ ...value, status: value.status === 'completed' ? 'complete' : value.status }),
    uploadFile: ({ localPath, remoteDirectory, id, signal, onProgress }) => { requireBackend(); if (!uploader || sessionTransition) throw new Error('SSH 连接正在切换。'); return uploader.upload(localPath, remoteDirectory, { id, signal, onProgress }); } });
  registerIpc(); createWindow();
  if (historyWarning) windowRef.webContents.once('did-finish-load', () => post({ type: 'desktopError', error: historyWarning }));
  instanceBridge = new InstanceBridge({ userDataDir: app.getPath('userData'), onActivity: bridgeActivity, metadata: { pid: process.pid, executable: process.execPath }, callbacks: {
    status: async () => ({ connected: Boolean(backend?.connected), host: settings.host, port: settings.port, username: settings.username, privateKeyPath: settings.privateKeyPath, desktop: backend?.desktop, home: backend?.home }),
    focus: async () => { windowRef.show(); windowRef.focus(); return { ok: true }; },
    connect: input => connectSsh(input, true),
    exec: (input, context) => { if (sessionTransition) throw new Error('SSH 连接正在切换。'); return executeRemote(requireBackend(), input, context); },
    upload: (input, context) => upload(input.localPath, input.remoteDirectory, { id: input.id, ...context }),
    download: (input, context) => download(input.remotePath, { id: input.id, destination: input.destination, ...context }),
    cancel: async input => browserManager.cancel(input.id) || transferCenter.cancel(input.id)
  } });
  try { await instanceBridge.start(); } catch(error) { post({type:'desktopError',error:`本地命令行接口启动失败：${error.message}`}); }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (allowWindowClose) return;
  event.preventDefault(); void quitSafely();
});
