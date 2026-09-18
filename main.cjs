'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fsp = require('node:fs/promises');
const { StringDecoder } = require('node:string_decoder');
const { SshBackend, DEFAULT_THRESHOLD, normalizeRemote } = require('./lib/ssh-backend.cjs');
const { TerminalGuard } = require('./lib/terminal-guard.cjs');
const { desktopIdentity, desktopLocations } = require('./lib/desktop-preferences.cjs');

const userDataArgument = process.argv.find(arg => arg.startsWith('--user-data-dir='));
if (userDataArgument) app.setPath('userData', path.resolve(userDataArgument.slice('--user-data-dir='.length)));
let windowRef, backend, desktopService, connecting = false;
let settings = { downloadThreshold: DEFAULT_THRESHOLD, scriptEditor: 'vim', knownHosts: {}, desktopLocations: {} };
let settingsQueue = Promise.resolve();
const selectedKeys = new Set();
const completedDownloads = new Set();
const terminalStarts = new Map();
const desktopPreferenceWrites = new Map();
let sessionTransition = false, allowWindowClose = false, closingApplication = false;
const terminalGuard = new TerminalGuard({ getBackend: () => backend,
  ask: options => dialog.showMessageBox(windowRef, options), report: options => dialog.showMessageBox(windowRef, options),
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
  try { const loaded = JSON.parse(await fsp.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8')); settings = { ...settings, ...Object.fromEntries(Object.entries(loaded).filter(([key]) => ['host', 'port', 'username', 'hostKeyFingerprint', 'knownHosts', 'downloadThreshold', 'desktopLocations'].includes(key))) }; } catch (error) { if (error.code !== 'ENOENT') settings.loadWarning = '本地设置不可读，已使用默认值。'; }
  if (!settings.knownHosts || typeof settings.knownHosts !== 'object' || Array.isArray(settings.knownHosts)) settings.knownHosts = {};
  if (!Number.isSafeInteger(settings.downloadThreshold) || settings.downloadThreshold < 1048576 || settings.downloadThreshold > 1073741824) settings.downloadThreshold = DEFAULT_THRESHOLD;
  settings.scriptEditor = 'vim';
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
    if (!await terminalGuard.all()) return;
    terminalStarts.clear(); await backend?.disconnect(); allowWindowClose = true; app.quit();
  } catch (error) { post({ type: 'desktopError', error: `关闭应用未完成：${error.message}` });
  } finally { closingApplication = false; sessionTransition = false; }
}
async function inspect(create = false) {
  const source = requireBackend();
  const remote = await desktopService.inspect(create, create ? null : settings.desktopLocations[source.desktopIdentity]);
  if (!currentSession(source)) return { cancelled: true };
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
    return await source.setDesktop(target, { beforeCommit: async () => {
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
function compatibilitySettings(requestId) { return { type: 'extensionSettings', requestId, hasWorkspace: false, target: 'user', settings: { openOnStartup: true, remoteRoot: '/', remoteHome: backend?.home || '', scriptEditor: 'vim' } }; }
async function handleDesktopMessage(message) {
  if (!message || typeof message.type !== 'string') throw new Error('无效的桌面请求。');
  const type = message.type;
  if (type === 'ready' || type === 'getExtensionSettings') { post(compatibilitySettings(message.requestId)); if (type === 'ready' && backend?.connected) { await inspect(); await serverInfo(); } return; }
  if (type === 'toggleFullscreen') { windowRef.setFullScreen(!windowRef.isFullScreen()); post({ type: 'fullscreenResult', ok: true, message: '已切换全屏；Esc 退出全屏，F11 切换。' }); return; }
  if (type === 'getServerInfo') return serverInfo();
  requireBackend();
  if (type === 'createDesktop') { await inspect(true); return; }
  if (type === 'readDirectory') {
    const source = backend, service = desktopService;
    try { const entries = await service.entries(message.path); if (currentSession(source)) post({ type: 'remoteDirectory', path: message.path, requestId: message.requestId, entries }); }
    catch (error) { if (currentSession(source)) post({ type: 'remoteDirectory', path: message.path, requestId: message.requestId, error: accessMessage(error, message.path), accessDenied: accessDenied(error) }); }
  } else if (type === 'refreshRemote') {
    await inspect(); for (const remotePath of [...new Set(message.paths || [])]) await handleDesktopMessage({ type: 'readDirectory', path: remotePath });
  } else if (type === 'saveDesktopConfig') {
    try { const config = await desktopService.saveConfig(message.config); post({ type: 'configSaved', ok: true, requestId: message.requestId, config }); }
    catch (error) { post({ type: 'configSaved', ok: false, requestId: message.requestId, error: error.message }); }
  } else if (type === 'pinApp' || type === 'unpinApp') {
    const config = await desktopService.updatePinned(type === 'pinApp' ? message.app : null, type === 'unpinApp' ? message.id : null);
    post({ type: 'configUpdated', config });
  } else if (type === 'fileOperation') {
    try {
      const result = await desktopService.operate(message, async paths => {
        const answer = await dialog.showMessageBox(windowRef, { type: 'warning', title: '永久删除远程文件', message: `永久删除 ${paths.length} 个项目？`, detail: `${paths.slice(0, 8).join('\n')}\n远程文件不进入回收站。符号链接只删除链接本身。`, buttons: ['取消', '永久删除'], defaultId: 0, cancelId: 0, noLink: true });
        return answer.response === 1;
      });
      post({ type: 'operationResult', requestId: message.requestId, ...result });
      post({ type: 'operationCommand', command: `# SFTP ${message.operation}`, status: result.cancelled ? 'cancelled' : 'success' });
    } catch (error) { post({ type: 'operationResult', requestId: message.requestId, success: false, error: error.message }); }
  } else if (type === 'openTerminal') {
    if (sessionTransition) throw new Error('正在关闭或切换连接，请稍后打开终端。');
    const token = {}, terminalBackend = backend, service = desktopService;
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
      backend.openShell(message.id, cwd, data => post({ type: 'terminalData', id: message.id, data: decoder.write(data) }), error => { terminalStarts.delete(message.id); post({ type: error ? 'terminalError' : 'terminalExit', id: message.id, error: error?.message, exitCode: 0 }); }, { program, filePath, readOnly, cols: message.cols, rows: message.rows, onReady: () => post({ type: 'terminalOpened', id: message.id }) });
    } catch (error) {
      if (terminalStarts.get(message.id) === token) {
        terminalStarts.delete(message.id);
        if (message.filePath && accessDenied(error)) post({ type: 'fileAccessError', id: message.id, path: message.filePath, error: accessMessage(error, message.filePath), accessDenied: true });
        else post({ type: 'terminalError', id: message.id, error: error.message });
      }
    }
  } else if (type === 'terminalInput') backend.writeShell(message.id, message.data);
  else if (type === 'terminalResize') backend.resizeShell(message.id, message.cols, message.rows);
  else if (type === 'terminalClose') { await terminalGuard.request(message.id); }
  else throw new Error('该功能未在独立应用中提供。');
}
function registerIpc() {
  const handle = (channel, action) => ipcMain.handle(channel, (event, ...args) => { requireSender(event); return action(...args); });
  handle('app:get-settings', () => publicSettings());
  handle('app:save-settings', patch => {
    const threshold = Number(patch?.downloadThreshold);
    if (!Number.isSafeInteger(threshold) || threshold < 1048576 || threshold > 1073741824) throw new Error('下载阈值必须为 1–1024 MiB。');
    if (backend) backend.threshold = threshold;
    return saveSettings({ downloadThreshold: threshold, scriptEditor: 'vim' });
  });
  handle('app:quit-fullscreen', () => { windowRef.setFullScreen(false); return true; });
  handle('terminal:close', id => terminalGuard.request(id));
  handle('app:choose-private-key', async () => {
    const result = await dialog.showOpenDialog(windowRef, { properties: ['openFile'], title: '选择 SSH 私钥' });
    if (result.canceled) return null; const selected = result.filePaths[0]; selectedKeys.add(selected); return selected;
  });
  handle('ssh:connect', async input => {
    if (connecting || sessionTransition) throw new Error('已有连接正在建立或关闭。'); connecting = true; sessionTransition = true;
    try {
      if (!await terminalGuard.all()) return { cancelled: true };
      terminalStarts.clear(); await backend?.disconnect(); desktopService = null;
      post({ type: 'remoteState', status: 'disconnected', message: '正在建立新的 SSH 连接。' });
      const host = String(input.host || '').trim(), port = Number(input.port) || 22, username = String(input.username || '').trim();
      const hostKey = `${host.toLowerCase()}:${port}`, known = settings.knownHosts[hostKey];
      if (known && input.hostKeyFingerprint && input.hostKeyFingerprint.replace(/=+$/, '') !== known) throw new Error('输入指纹与本机保存的指纹不同。连接已拒绝。');
      let privateKey;
      if (input.privateKeyPath) {
        if (!selectedKeys.has(input.privateKeyPath)) throw new Error('请使用“选择私钥”按钮选择本地文件。');
        const stats = await fsp.stat(input.privateKeyPath);
        if (!stats.isFile() || stats.size > 1024 * 1024) throw new Error('私钥必须是小于 1 MiB 的普通文件。');
        privateKey = await fsp.readFile(input.privateKeyPath);
      }
      backend = new SshBackend({ threshold: settings.downloadThreshold, downloadsPath: app.getPath('downloads'),
        verifyHost: async info => {
          const answer = await dialog.showMessageBox(windowRef, { type: 'warning', title: '首次连接：核验 SSH 主机', message: `信任 ${info.host}:${info.port} 的主机密钥？`, detail: `SHA-256 指纹：\n${info.fingerprint}\n\n请与服务器管理员提供的指纹核对。确认后保存到本应用的已知主机记录。`, buttons: ['取消', '指纹无误，信任并连接'], defaultId: 0, cancelId: 0, noLink: true });
          return answer.response === 1;
        }, onDisconnect: () => { desktopService = null; post({ type: 'remoteState', status: 'disconnected', message: 'SSH 连接已断开，请重新连接。' }); } });
      let result;
      try { result = await backend.connect({ host, port, username, password: input.password, privateKey, passphrase: input.passphrase, hostKeyFingerprint: known || input.hostKeyFingerprint }); }
      finally { privateKey?.fill(0); }
      desktopService = backend.desktopService();
      backend.desktopIdentity = desktopIdentity({ host, port, username, hostFingerprint: result.hostFingerprint });
      await saveSettings({ host, port, username, hostKeyFingerprint: result.hostFingerprint, knownHosts: { ...settings.knownHosts, [hostKey]: result.hostFingerprint } });
      try { await inspect(); } catch (error) { post({ type: 'remoteState', status: 'error', homePath: backend.home, message: accessMessage(error, settings.desktopLocations[backend.desktopIdentity]) }); }
      await serverInfo(); return result;
    } finally { connecting = false; sessionTransition = false; }
  });
  handle('ssh:disconnect', async () => {
    if (sessionTransition) return false; sessionTransition = true;
    try {
      if (!await terminalGuard.all()) return false;
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
  handle('ssh:download', async (remotePath, id) => {
    const sourceBackend = requireBackend();
    const result = await sourceBackend.download(remotePath, { id, onProgress: value => send('download:progress', value) });
    completedDownloads.add(result.path); return result;
  });
  handle('ssh:cancel-download', id => { backend?.cancelDownload(id); return true; });
  handle('ssh:open-local', filePath => { if (!completedDownloads.has(filePath)) throw new Error('只能定位当前应用完成下载的文件。'); shell.showItemInFolder(filePath); });
  ipcMain.on('desktop:send', (event, message) => { try { requireSender(event); handleDesktopMessage(message).catch(error => post({ type: 'desktopError', error: error.message })); } catch {} });
}
app.whenReady().then(async () => { await loadSettings(); registerIpc(); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (allowWindowClose) return;
  event.preventDefault(); void quitSafely();
});
