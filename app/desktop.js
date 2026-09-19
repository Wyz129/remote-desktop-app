'use strict';
const api = window.remoteDesktop;
const host = { postMessage(message) { Promise.resolve(api.send(message)).catch(error => notify(error.message || String(error))); }, getState: () => null, setState: () => {} };
const $ = id => document.getElementById(id);
const GRID = 112;
const EMPTY_ROOT = '/';
const previous = {}; // Window sessions are scoped to this authenticated connection.
const state = {
  rootPath: previous.rootPath || EMPTY_ROOT,
  positions: previous.positions && typeof previous.positions === 'object' ? previous.positions : {},
  shortcuts: Array.isArray(previous.shortcuts) ? previous.shortcuts.filter(isCommandShortcut) : [],
  pinnedApps: [],
  viewMode: previous.viewMode === 'icons' ? 'icons' : 'details',
  wallpaper: ['teal', 'purple', 'slate'].includes(previous.wallpaper) ? previous.wallpaper : 'teal',
  showHiddenFiles: previous.showHiddenFiles !== false,
  windows: [],
  activeWindow: null,
  clipboard: null
};
let rootPath = EMPTY_ROOT;
let homePath = EMPTY_ROOT;
let remoteMode = false;
let desktopAvailable = false;
let desktopAccessError = '';
let initialized = false;
let directories = Object.create(null);
const items = new Map();
const windowElements = new Map();
let browserOpening = null, browserLayoutFrame = null;
const directoryRequests = new Map();
const latestDirectoryRequests = new Map();
const pendingOperations = new Map();
const terminals = new Map();
const PROGRAM_LABELS = { shell: '终端', vim: 'Vim', htop: 'htop' };
let serverInfo = null;
let serverClockAnchor = null;
let lastServerResponseAt = null;
let connectionStatus = '正在连接…';
let appContextId = null;
let appContextWindowId = null;
let selection = { scope: 'desktop', keys: new Set() };
let menuContext = { scope: 'desktop', parent: rootPath };
let nextWindow = 1;
let nextRequest = 1;
let nextLayer = 1;
let editor = null;
let saveTimer;
let pendingConfig = {};
let settingsRequest = null;
let settingsTimer;
let extensionSettings = { downloadThreshold: 50 * 1024 * 1024, scriptEditor: 'vim' };
let extensionSettingsFormBaseline = { ...extensionSettings };
let extensionSettingsRequest = null;
let extensionSettingsRead = null;
let extensionSettingsTimer;
let extensionSettingsReady = false;
let extensionSettingsHasWorkspace = false;
let extensionSettingsReopenRequired = false;
let fullscreenTimer;
let dragPayload = null;
let systemInfoRequest = 0;
let systemInfoLoading = false;
let connectionGeneration = 0;
let settingsBaseline = null;
let settingsWindow = null;
let directoryPicker = null;
let fileAccessChoice = null;
const fileAccessRequests = new Set();
let transferDestination = null, transferPicker = null;
const activity = { sessions: [], entries: [], systemLogPath: '', error: '', connected: false, selected: '', toastSession: '', revision: 0 };
const ACTIVITY_ENTRY_LIMIT = 600, ACTIVITY_SESSION_LIMIT = 100, ACTIVITY_BYTE_LIMIT = 2 * 1024 * 1024;
let activityFrame = null;

function isCommandShortcut(value) { return value && typeof value.command === 'string' && value.command.trim(); }
function toolIcon(name) {
  return lucide.createElement(lucide.icons[name], { width: 17, height: 17, 'stroke-width': 1.6, 'aria-hidden': 'true', class: 'tool-icon' });
}
function renderToolIcons(root) {
  const names = { minimize: 'Minus', maximize: 'Square', close: 'X', 'new-folder': 'FolderPlus', cut: 'Scissors', copy: 'Copy', paste: 'ClipboardPaste', rename: 'TextCursorInput', delete: 'Trash2', back: 'ArrowLeft', forward: 'ArrowRight', up: 'ArrowUp', refresh: 'RefreshCw', details: 'List', icons: 'LayoutGrid' };
  for (const button of root.querySelectorAll('[data-window-action]')) {
    const name = names[button.dataset.windowAction];
    if (!name) continue;
    const label = button.querySelector('span:first-child');
    if (label) label.replaceChildren(toolIcon(name)); else button.replaceChildren(toolIcon(name));
  }
}
function save() {
  state.rootPath = rootPath;
  // A restored webview must never restart a shell or application without a click.
  host.setState({ ...state, windows: state.windows.filter(win => !win.kind).map(({ pendingNavigation, error, ...win }) => win) });
}
function notify(text) { $('notice').textContent = text; $('notice').title = text; }
function showOperationCommand(command, status = 'success', detail = '') {
  $('operationCommand').textContent = command || '—';
  $('operationCommand').title = `${command || '—'}${detail ? `\n${detail}` : ''}`;
  $('operationStatus').textContent = { success: '完成', error: '失败', cancelled: '已取消' }[status] || '';
  $('operationStatus').dataset.status = status;
  $('operationStatus').title = detail;
}
function showInterfaceAction(text) { showOperationCommand(`# ${text}（界面操作，无 Linux 指令）`); }
function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }
function renderServerInfo() {
  $('accountName').textContent = serverInfo?.username || (initialized ? '账号不可用' : '未连接 SSH');
  $('accountName').title = serverInfo?.hostname ? `${serverInfo.username || ''}@${serverInfo.hostname}` : '';
  $('connection').textContent = connectionStatus;
  if (serverInfo?.error) $('connection').title = serverInfo.error;
  else $('connection').title = serverInfo?.hostname || '';
  updateClock();
}
function updateClock() {
  const clock = $('serverClock');
  const remote = serverInfo ? serverInfo.remote !== false : remoteMode;
  const stale = lastServerResponseAt !== null && performance.now() - lastServerResponseAt > 90000;
  $('connection').textContent = remote && stale && connectionStatus.includes('已连接') ? 'SSH · 等待服务器响应' : connectionStatus;
  if (!serverClockAnchor || performance.now() - serverClockAnchor.receivedAt > 90000) {
    clock.textContent = `${remote ? '服务器' : '本地'}时间 —`;
    clock.removeAttribute('datetime');
    return;
  }
  const current = new Date(serverClockAnchor.epochMs + performance.now() - serverClockAnchor.receivedAt);
  const display = new Date(current.getTime() + serverClockAnchor.offsetMs);
  clock.textContent = `${serverClockAnchor.formatter.format(display)} · ${serverClockAnchor.label}`;
  clock.dateTime = current.toISOString();
  clock.title = `服务器本地时间 · ${serverClockAnchor.label}`;
  clock.setAttribute('aria-label', `${remote ? '服务器' : '本地'}时间 ${clock.textContent}`);
}
function receiveServerInfo(message) {
  serverInfo = message;
  lastServerResponseAt = performance.now();
  serverClockAnchor = null;
  if (message.available !== false && Number.isFinite(message.epochMs)) {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
    const offset = Number.isFinite(message.utcOffsetMinutes) && Math.abs(message.utcOffsetMinutes) <= 1440 ? message.utcOffsetMinutes : null;
    const offsetLabel = offset === null ? '' : `UTC${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
    const label = message.timeZoneLabel || [message.timeZone, offsetLabel].filter(Boolean).join(' · ');
    try {
      if (typeof message.timeZone !== 'string' || !message.timeZone) throw new Error('No IANA zone');
      serverClockAnchor = { epochMs: message.epochMs, receivedAt: performance.now(), offsetMs: 0, label, formatter: new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: message.timeZone }) };
    } catch {
      if (offset !== null) serverClockAnchor = { epochMs: message.epochMs, receivedAt: performance.now(), offsetMs: offset * 60000, label: label || offsetLabel, formatter: new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: 'UTC' }) };
    }
  }
  renderServerInfo();
}
function parentOf(path) { return path === '/' ? '/' : path.slice(0, path.lastIndexOf('/')) || '/'; }
function joinPath(parent, name) { return `${parent === '/' ? '' : parent}/${name}`; }
function resolveDirectoryAddress(value, base) {
  let path = value.trim();
  if (!path || /[\x00-\x1f\x7f]/.test(path)) throw new Error('请输入有效的目录地址');
  if (path === '~' || path.startsWith('~/')) {
    if (!homePath) throw new Error('尚未取得服务器主目录，请使用绝对路径');
    path = homePath + path.slice(1);
  } else if (path.startsWith('~')) throw new Error('仅支持 ~ 或 ~/，不支持其他账号的主目录缩写');
  if (!path.startsWith('/')) path = joinPath(base, path);
  const segments = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segments.pop(); else segments.push(part);
  }
  return `/${segments.join('/')}`;
}
function basename(path) { return path.split('/').filter(Boolean).pop() || '/'; }
function clamp(value, maximum) { return Math.max(0, Math.min(Number.isFinite(value) ? value : 0, Math.max(0, maximum))); }
function getWindow(id) { return state.windows.find(win => win.id === id); }
function getSurface(scope) { return scope === 'desktop' ? $('icons') : windowElements.get(scope)?.querySelector('.listing'); }
function contextFor(scope) { return { scope, parent: scope === 'desktop' ? rootPath : getWindow(scope)?.folder || rootPath }; }
function keyOf(item) { return item.kind === 'command' ? `command:${item.id}` : item.path; }
function commandItem(shortcut, index) {
  const id = shortcut.id || `command-${index}`;
  return { ...shortcut, id, name: shortcut.label || shortcut.command, type: 'command', kind: 'command', path: `command:${id}` };
}
function selectedItems(scope = selection.scope) {
  if (scope !== selection.scope) return [];
  return [...selection.keys].map(key => items.get(key)).filter(item => item && visibleEntry(item));
}
function selectedFilePaths(scope = selection.scope) { return selectedItems(scope).filter(item => item.kind !== 'command').map(item => item.path); }
function setDirectory(path, entries) {
  directories[path] = entries.map(entry => ({ ...entry, type: entry.type === 'directory' ? 'folder' : entry.type, size: typeof entry.size === 'number' ? entry.size + ' B' : entry.size, path: entry.path || joinPath(path, entry.name), remoteUri: entry.uri || entry.remoteUri }));
  rebuildItems();
}
function rebuildItems() {
  items.clear();
  items.set(rootPath, { name: basename(rootPath), type: 'folder', path: rootPath });
  for (const entries of Object.values(directories)) for (const item of entries) items.set(item.path, item);
  state.shortcuts.forEach((shortcut, index) => { const item = commandItem(shortcut, index); items.set(keyOf(item), item); });
}
function persistConfig(patch) {
  save();
  if (!desktopAvailable) return;
  Object.assign(pendingConfig, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const config = pendingConfig;
    pendingConfig = {};
    host.postMessage({ type: 'saveDesktopConfig', config });
  }, 220);
}
function applyConfig(config, initial = false) {
  if (!config || typeof config !== 'object') config = {};
  state.wallpaper = ['teal', 'purple', 'slate'].includes(config.wallpaper) ? config.wallpaper : 'teal';
  const showHiddenFiles = typeof config.showHiddenFiles === 'boolean' ? config.showHiddenFiles : true;
  if (state.showHiddenFiles !== showHiddenFiles) selection.keys.clear();
  state.showHiddenFiles = showHiddenFiles;
  $('desktop').dataset.wallpaper = state.wallpaper;
  if (!Object.hasOwn(pendingConfig, 'viewMode')) {
    if (config.viewMode === 'details' || config.viewMode === 'icons') state.viewMode = config.viewMode;
    else if (initial) state.viewMode = 'details';
    for (const win of state.windows) if (!win.kind) win.viewMode = state.viewMode;
  }
  if (!Object.hasOwn(pendingConfig, 'positions')) {
    if (config.positions && typeof config.positions === 'object' && !Array.isArray(config.positions)) state.positions = { ...config.positions };
    else if (initial) state.positions = {};
  }
  if (!Object.hasOwn(pendingConfig, 'shortcuts')) {
    if (Array.isArray(config.shortcuts)) state.shortcuts = [];
    else if (initial) state.shortcuts = [];
  }
  if (Array.isArray(config.pinnedApps)) state.pinnedApps = config.pinnedApps.filter(app => app && typeof app.id === 'string' && Object.hasOwn(PROGRAM_LABELS, app.program)).map(app => ({ id: app.id, label: app.label || PROGRAM_LABELS[app.program], program: app.program }));
  else if (initial) state.pinnedApps = [];
  renderPinnedApps();
  rebuildItems();
  save();
}
function visibleEntry(item) { return state.showHiddenFiles || item.kind === 'command' || !item.name.startsWith('.'); }
function settingsBusy(busy) {
  for (const control of $('settingsForm').querySelectorAll('button, select, input')) control.disabled = busy || Boolean(extensionSettingsRequest) || (control.id !== 'cancelSettings' && !remoteMode);
  $('closeSettings').disabled = busy || Boolean(extensionSettingsRequest);
  $('applySettings').textContent = busy ? '正在保存…' : '应用';
  extensionSettingsBusy();
}
function closeSettings(force = false) {
  if (force !== true && (settingsRequest || extensionSettingsRequest)) return;
  extensionSettingsRead = null; clearTimeout(extensionSettingsTimer);
  const element = $('settingsDialog');
  element.close(); element.classList.remove('window', 'active', 'maximized'); element.hidden = false;
  if (settingsWindow) {
    windowElements.delete(settingsWindow.id);
    state.windows = state.windows.filter(win => win.id !== settingsWindow.id);
    if (state.activeWindow === settingsWindow.id) {
      state.activeWindow = null;
      const visible = state.windows.filter(win => !win.minimized).sort((a, b) => b.z - a.z)[0];
      if (visible) focusWindow(visible.id);
    }
  }
  renderDock(); save(); $('desktopSettings').focus();
}
function showSettingsWindow() {
  const element = $('settingsDialog');
  if (!settingsWindow) {
    settingsWindow = { id: 'settings-window', kind: 'settings', title: '设置 · 控制面板', minimized: false, maximized: false, position: { x: 80, y: 28 }, size: { width: 620, height: 670 }, z: ++nextLayer };
    element.dataset.windowId = settingsWindow.id;
    $('windows').append(element);
    element.addEventListener('pointerdown', () => { if (state.activeWindow !== settingsWindow.id) focusWindow(settingsWindow.id); });
    element.addEventListener('click', event => {
      const action = event.target.closest('[data-window-action]')?.dataset.windowAction;
      if (action === 'close') closeSettings();
      else if (action) windowAction(action, settingsWindow);
    });
    element.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); closeSettings(); }
    });
    bindWindowDrag(settingsWindow, element); bindWindowResize(settingsWindow, element); renderToolIcons(element);
  }
  if (!getWindow(settingsWindow.id)) state.windows.push(settingsWindow);
  windowElements.set(settingsWindow.id, element); element.classList.add('window');
  if (!element.open) element.show();
  focusWindow(settingsWindow.id);
}
function openSettings() {
  $('context').hidden = true; $('appContext').hidden = true;
  if ($('settingsDialog').open && settingsWindow) { focusWindow(settingsWindow.id); return; }
  $('settingsViewMode').value = state.viewMode;
  $('settingsWallpaper').value = state.wallpaper;
  $('settingsHidden').checked = state.showHiddenFiles;
  settingsBaseline = { viewMode: state.viewMode, wallpaper: state.wallpaper, showHiddenFiles: state.showHiddenFiles };
  $('settingsDesktopPath').value = desktopAvailable ? rootPath : (homePath ? joinPath(homePath, 'rdesktop') : '');
  $('settingsError').textContent = desktopAccessError;
  $('settingsLocation').textContent = remoteMode ? '桌面位置保存到本机。更改外观时才写入远程桌面配置，需要配置文件的写入权限。' : '连接 SSH 后可选择桌面目录；应用设置始终可用。';
  settingsBusy(false); setSettingsTab('desktop'); showSettingsWindow();
  loadExtensionSettings();
}
function setSettingsTab(name) {
  for (const button of $('settingsDialog').querySelectorAll('[data-settings-tab]')) {
    const selected = button.dataset.settingsTab === name;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    $(button.getAttribute('aria-controls')).hidden = !selected;
  }
  if (name === 'system') loadSystemInfo();
}
function resetSystemInfo() {
  systemInfoRequest++; systemInfoLoading = false;
  $('systemInfoFields').hidden = true;
  for (const field of $('systemInfoFields').querySelectorAll('[data-system-info]')) field.textContent = '';
  $('systemInfoError').textContent = '';
  $('systemInfoStatus').textContent = '连接 SSH 后查看远程系统信息。';
  $('refreshSystemInfo').disabled = !remoteMode;
}
async function loadSystemInfo() {
  if (!remoteMode) { resetSystemInfo(); return; }
  if (systemInfoLoading) return;
  const request = ++systemInfoRequest;
  systemInfoLoading = true; $('refreshSystemInfo').disabled = true;
  $('systemInfoError').textContent = ''; $('systemInfoStatus').textContent = '正在读取远程系统信息…';
  try {
    const info = await api.getSystemInfo();
    if (request !== systemInfoRequest || !remoteMode) return;
    for (const field of $('systemInfoFields').querySelectorAll('[data-system-info]')) {
      const value = info?.[field.dataset.systemInfo];
      field.textContent = typeof value === 'string' && value.trim() ? value : '当前服务器未提供';
    }
    $('systemInfoFields').hidden = false;
    $('systemInfoStatus').textContent = '远程系统信息（只读快照，点击刷新以更新）。';
  } catch (error) {
    if (request !== systemInfoRequest || !remoteMode) return;
    $('systemInfoFields').hidden = true; $('systemInfoStatus').textContent = '系统信息读取失败，可重试。';
    $('systemInfoError').textContent = error.message || String(error);
  } finally {
    if (request === systemInfoRequest) { systemInfoLoading = false; $('refreshSystemInfo').disabled = !remoteMode; }
  }
}
function openHome() {
  if (!remoteMode || !homePath) { notify('请先连接 SSH，再打开服务器主目录。'); if (!$('connectionDialog').open) $('connectionDialog').showModal(); return; }
  const existing = state.windows.find(win => !win.kind && win.folder === homePath);
  if (existing) { focusWindow(existing.id); return; }
  openFolder(homePath);
}
function updateBuiltinShortcuts() {
  $('homeShortcut').title = remoteMode && homePath ? `Home · ${homePath}` : 'Home · 连接 SSH 后打开远程主目录';
  $('refreshSystemInfo').disabled = !remoteMode || systemInfoLoading;
}
function extensionSettingsBusy() {
  const busy = Boolean(extensionSettingsRequest || extensionSettingsRead || settingsRequest);
  for (const control of $('extensionSettingsForm').querySelectorAll('button, select, input')) control.disabled = busy;
  $('saveExtensionSettings').textContent = extensionSettingsRequest ? '正在保存…' : '保存应用设置';
}
function showExtensionSettings(settings) {
  extensionSettingsFormBaseline = { ...settings };
  $('settingsDownloadThreshold').value = String(Math.round((Number(settings.downloadThreshold) || 50 * 1024 * 1024) / 1024 / 1024));
  $('settingsScriptEditor').value = 'vim';
  $('downloadsLocation').textContent = settings.downloadsPath ? '默认下载目录：' + settings.downloadsPath : '默认下载到当前用户的系统 Downloads 文件夹。';
}
async function loadExtensionSettings() {
  if (extensionSettingsRequest || settingsRequest) return;
  extensionSettingsRead = true; extensionSettingsBusy();
  $('extensionSettingsError').textContent = '';
  try { extensionSettings = { ...extensionSettings, ...await api.getSettings() }; showExtensionSettings(extensionSettings); $('extensionSettingsStatus').textContent = '设置已读取。'; }
  catch(error) { $('extensionSettingsError').textContent = error.message; }
  finally { extensionSettingsRead = null; extensionSettingsReady = true; extensionSettingsBusy(); }
}
async function submitExtensionSettings(event) {
  event.preventDefault(); if (extensionSettingsRequest || settingsRequest) return;
  const threshold = Number($('settingsDownloadThreshold').value);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 1024) { $('extensionSettingsError').textContent = '阈值须为 1–1024 MiB 的整数。'; return; }
  extensionSettingsRequest = true; extensionSettingsBusy(); $('extensionSettingsError').textContent = '';
  try { extensionSettings = { ...extensionSettings, ...await api.saveSettings({ downloadThreshold: threshold * 1024 * 1024, scriptEditor: 'vim' }) }; showExtensionSettings(extensionSettings); $('extensionSettingsStatus').textContent = '应用设置已保存。'; }
  catch(error) { $('extensionSettingsError').textContent = error.message; }
  finally { extensionSettingsRequest = null; extensionSettingsBusy(); }
}
function applyDesktopSettings(config) {
  // Only this request's preference fields are applied. A config reply may also
  // contain older positions or shortcuts changed while the write was pending.
  state.viewMode = config.viewMode; state.wallpaper = config.wallpaper; state.showHiddenFiles = config.showHiddenFiles;
  $('desktop').dataset.wallpaper = state.wallpaper;
  for (const win of state.windows) if (!win.kind) win.viewMode = state.viewMode;
  selection.keys.clear(); renderIcons(); state.windows.forEach(renderWindow); save();
  showInterfaceAction('更新桌面设置'); notify(remoteMode ? '桌面设置已保存到服务器' : '桌面设置已保存');
}
async function submitSettings(event) {
  event.preventDefault(); if (settingsRequest || extensionSettingsRequest) return;
  if (!remoteMode) { $('settingsError').textContent = '请先连接 SSH。'; return; }
  const config = { viewMode: $('settingsViewMode').value, wallpaper: $('settingsWallpaper').value, showHiddenFiles: $('settingsHidden').checked };
  const requestedPath = $('settingsDesktopPath').value.trim();
  let desktopPath;
  try { desktopPath = resolveDirectoryAddress(requestedPath, rootPath); } catch (error) { $('settingsError').textContent = error.message; return; }
  clearTimeout(saveTimer); clearTimeout(settingsTimer);
  const requestId = `settings-${nextRequest++}`;
  const request = { requestId, config, pendingPatch: pendingConfig, generation: connectionGeneration, switched: false };
  settingsRequest = request;
  settingsBusy(true); $('settingsError').textContent = '';
  const changedConfig = Object.fromEntries(Object.entries(config).filter(([key, value]) => settingsBaseline?.[key] !== value));
  try {
    if (!desktopAvailable || desktopPath !== rootPath) {
      // The backend owns the deadline through validation and commits the path
      // together with its persisted preference. Await that definitive outcome.
      const result = await api.setDesktop(desktopPath);
      if (settingsRequest !== request || request.generation !== connectionGeneration || !remoteMode) return;
      if (!result || !Array.isArray(result.entries) || typeof result.rootPath !== 'string') throw new Error('服务器未返回有效桌面内容');
      request.switched = true; request.pendingPatch = {}; pendingConfig = {};
      rootPath = result.rootPath; homePath = result.homePath || homePath; desktopAvailable = true; desktopAccessError = ''; initialized = true;
      selection = { scope: 'desktop', keys: new Set() };
      setDirectory(rootPath, result.entries); applyConfig(result.config || {}, true);
      $('desktopPath').textContent = rootPath; $('settingsDesktopPath').value = rootPath;
      connectionStatus = 'SSH · 已连接'; renderServerInfo();
      renderIcons(); state.windows.forEach(renderWindow); renderDock(); updateBuiltinShortcuts(); save();
      notify(`已将 ${rootPath} 设置为桌面`);
    }
    if (Object.keys(changedConfig).length || (!request.switched && Object.keys(pendingConfig).length)) {
      const patch = { ...pendingConfig, ...changedConfig }; pendingConfig = {};
      request.config = { viewMode: state.viewMode, wallpaper: state.wallpaper, showHiddenFiles: state.showHiddenFiles, ...changedConfig };
      settingsTimer = setTimeout(() => {
        if (settingsRequest !== request) return;
        if (!request.switched) pendingConfig = { ...request.pendingPatch, ...pendingConfig };
        settingsRequest = null; settingsBusy(false);
        $('settingsError').textContent = `${request.switched ? '桌面位置已更新；' : ''}外观保存未收到确认，请刷新桌面核对后重试。`;
      }, 15000);
      host.postMessage({ type: 'saveDesktopConfig', config: patch, requestId });
    } else {
      clearTimeout(settingsTimer); settingsRequest = null; settingsBusy(false); closeSettings();
    }
  } catch (error) {
    if (settingsRequest !== request || request.generation !== connectionGeneration) return;
    clearTimeout(settingsTimer); settingsRequest = null; settingsBusy(false);
    $('settingsError').textContent = error.message || String(error);
  }
}
function requestFullscreen() {
  $('fullscreen').disabled = true;
  host.postMessage({ type: 'toggleFullscreen' });
  clearTimeout(fullscreenTimer);
  fullscreenTimer = setTimeout(() => { $('fullscreen').disabled = false; notify('未收到全屏请求确认，请重试'); }, 15000);
}
function accessError(error, fallback = '无访问权限') {
  const detail = error?.message || String(error || '服务器拒绝访问');
  return /无访问权限|无编辑权限/.test(detail) ? detail : `${fallback}：${detail}`;
}
function withTimeout(promise, message, milliseconds = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]).finally(() => clearTimeout(timer));
}
function closeDirectoryPicker() {
  directoryPicker = null; $('desktopPickerDialog').close();
}
async function loadPickerDirectory(path) {
  const picker = directoryPicker;
  if (!picker || !remoteMode) return;
  const request = ++picker.request;
  $('desktopPickerError').textContent = ''; $('desktopPickerEntries').setAttribute('aria-busy', 'true');
  $('desktopPickerSelect').disabled = true;
  try {
    const entries = await withTimeout(api.list(path), '目录读取超时，请重试。');
    if (directoryPicker !== picker || picker.request !== request || picker.generation !== connectionGeneration) return;
    if (!Array.isArray(entries)) throw new Error('服务器未返回目录列表');
    picker.path = path; $('desktopPickerPath').value = path;
    $('desktopPickerUp').disabled = path === '/';
    $('desktopPickerEntries').replaceChildren();
    for (const entry of entries.filter(item => item.type === 'directory' || item.type === 'folder')) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'directory-picker-entry';
      button.textContent = `📁 ${entry.name}`; button.dataset.path = entry.path || joinPath(path, entry.name);
      button.addEventListener('dblclick', () => loadPickerDirectory(button.dataset.path));
      button.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); loadPickerDirectory(button.dataset.path); } });
      $('desktopPickerEntries').append(button);
    }
    if (!$('desktopPickerEntries').children.length) $('desktopPickerEntries').textContent = '此目录没有子文件夹，可直接使用此目录。';
  } catch (error) {
    if (directoryPicker !== picker || picker.request !== request || picker.generation !== connectionGeneration) return;
    $('desktopPickerPath').value = picker.path || path;
    $('desktopPickerError').textContent = `${accessError(error)}\n请求目录：${path}`;
  } finally {
    if (directoryPicker === picker && picker.request === request) {
      $('desktopPickerEntries').removeAttribute('aria-busy'); $('desktopPickerSelect').disabled = !picker.path;
    }
  }
}
function openDirectoryPicker() {
  if (!remoteMode || settingsRequest) return;
  directoryPicker = { path: null, request: 0, generation: connectionGeneration };
  $('desktopPickerEntries').replaceChildren(); $('desktopPickerError').textContent = '';
  $('desktopPickerDialog').showModal();
  loadPickerDirectory(desktopAvailable ? rootPath : homePath || '/');
}
function showFileAccessDialog(item, readOnly, detail, mode = 'workbench') {
  fileAccessChoice = readOnly ? { item, mode, generation: connectionGeneration } : null;
  $('fileAccessTitle').textContent = readOnly ? '无编辑权限' : '无访问权限';
  $('fileAccessDetail').textContent = `${item.path}\n${detail || (readOnly ? '当前账号不能写入此文件，可只读打开。' : '当前账号无法读取此文件。')}`;
  $('fileAccessReadOnly').hidden = !readOnly;
  $('fileAccessCancel').textContent = readOnly ? '取消' : '关闭';
  if (!$('fileAccessDialog').open) $('fileAccessDialog').showModal();
}
function glyph(item) {
  const picture = document.createElement('span');
  const type = ['folder', 'large', 'command'].includes(item.type) ? item.type : 'file';
  picture.className = `glyph ${type}${item.broken ? ' broken' : ''}`;
  picture.setAttribute('aria-hidden', 'true');
  if (type === 'command') picture.textContent = '>_';
  else if (type !== 'folder') picture.textContent = item.name.includes('.') ? item.name.split('.').pop().toUpperCase().slice(0, 4) : 'FILE';
  if (item.isSymbolicLink || item.kind === 'command') {
    const mark = document.createElement('span'); mark.className = 'shortcut-mark'; mark.textContent = item.broken ? '!' : '↗'; picture.append(mark);
  }
  return picture;
}
function itemType(item) {
  if (item.broken) return '失效的符号链接';
  if (item.isSymbolicLink) return item.type === 'folder' ? '文件夹快捷方式' : '文件快捷方式';
  return item.type === 'folder' ? '文件夹' : item.type === 'large' ? '大型文件' : '文件';
}
async function openItem(item, scope = 'desktop', mode = 'auto') {
  if (!item || !remoteMode) return;
  if (item.broken) { notify('快捷方式目标不存在：' + item.path); return; }
  if (item.kind === 'command') { notify('原 VS Code 命令快捷方式不适用于独立应用。'); return; }
  if (item.type === 'folder') { openFolder(item.path, scope === 'desktop' ? undefined : scope); return; }
  if (transferPicker?.windowId === scope) {
    setServerPickerPath(item.path);
    if (!transferPicker.directoryOnly) void confirmServerPicker();
    return;
  }
  if (fileAccessRequests.has(item.path)) return;
  const generation = connectionGeneration;
  fileAccessRequests.add(item.path);
  let access;
  try {
    access = await withTimeout(api.checkFileAccess(item.path), '文件权限检查超时，请重试。');
    if (!remoteMode || generation !== connectionGeneration) return;
    if (!access?.readable) { showFileAccessDialog(item, false, access?.error); return; }
  } catch (error) {
    if (remoteMode && generation === connectionGeneration) showFileAccessDialog(item, false, accessError(error));
    return;
  } finally { if (generation === connectionGeneration) fileAccessRequests.delete(item.path); }
  if (mode === 'auto' && /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(item.name)) { openImage(item); return; }
  if (mode === 'auto' && /\.(zip|gz|bz2|xz|7z|rar|tar|exe|dll|so|bin|odb|pdf|docx?|xlsx?|pptx?|mp4|mp3|wav|sqlite|db)$/i.test(item.name)) { notify('此文件适合下载后在本地打开，请右键选择“下载到本地”。'); return; }
  if (!access.writable) { showFileAccessDialog(item, true, access.error, mode); return; }
  await openDocument(item, mode, false);
}
async function openDocument(item, mode, readOnly) {
  if (mode === 'vim' || !api.openDocument) { openTerminal(parentOf(item.path), 'vim', item.path, readOnly); return; }
  try { await api.openDocument(item.path, { readOnly }); }
  catch(error) { notify(error.message || String(error)); }
}

function syncSelection() {
  document.querySelectorAll('.icon, .entry').forEach(element => {
    const selected = element.dataset.scope === selection.scope && selection.keys.has(element.dataset.key);
    element.classList.toggle('selected', selected);
    element.setAttribute('aria-selected', String(selected));
  });
  for (const win of state.windows) updateWindowStatus(win);
}
function selectItem(item, scope, additive = false) {
  const key = keyOf(item);
  if (selection.scope !== scope || !additive) selection = { scope, keys: new Set(additive && selection.scope === scope ? selection.keys : []) };
  if (additive && selection.keys.has(key)) selection.keys.delete(key); else selection.keys.add(key);
  if (transferPicker?.windowId === scope) setServerPickerPath(item.path);
  syncSelection();
}
function preserveSelection(item, scope) {
  if (selection.scope !== scope || !selection.keys.has(keyOf(item))) selectItem(item, scope);
}
function bindItem(element, item, scope) {
  element.dataset.path = item.path;
  element.dataset.key = keyOf(item);
  element.dataset.scope = scope;
  element.dataset.type = item.type;
  if (item.isSymbolicLink || item.kind === 'command') element.dataset.shortcut = 'true';
  element.title = item.kind === 'command' ? item.command : `${item.path}${item.broken ? '（目标不存在）' : item.isSymbolicLink ? '（符号链接）' : ''}`;
  element.setAttribute('aria-label', `${item.name}${item.isSymbolicLink || item.kind === 'command' ? ' 快捷方式' : ''}`);
  element.addEventListener('click', event => {
    if (event.target.closest('input') || element.suppressClick) return;
    selectItem(item, scope, event.ctrlKey || event.metaKey);
  });
  element.addEventListener('dblclick', event => { if (!event.target.closest('input') && !element.suppressClick) openItem(item, scope); });
  element.addEventListener('contextmenu', event => {
    if (event.target.closest('input')) return;
    preserveSelection(item, scope); showMenu(event, contextFor(scope));
  });
  if (scope === 'desktop') bindDesktopDrag(element, item);
  else {
    element.draggable = true;
    element.addEventListener('dragstart', event => {
      if (editor) { event.preventDefault(); return; }
      preserveSelection(item, scope);
      dragPayload = { paths: selectedFilePaths(scope), scope };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-remote-desktop', JSON.stringify(dragPayload));
      event.dataTransfer.setData('text/plain', dragPayload.paths.join('\n'));
    });
    element.addEventListener('dragend', () => { dragPayload = null; clearDropHighlight(); });
  }
}
function makeDesktopIcon(item, pending = false) {
  const element = document.createElement('button');
  element.type = 'button'; element.className = `icon${pending ? ' editing' : ''}`; element.draggable = false;
  element.dataset.id = item.kind === 'command' ? item.id : item.path;
  const label = document.createElement('span'); label.className = 'icon-label'; label.textContent = item.name;
  element.append(glyph(item), label);
  if (!pending) bindItem(element, item, 'desktop');
  return element;
}
function gridColumns() { return Math.max(1, Math.floor($('icons').clientWidth / GRID)); }
function gridPosition(index) { const columns = gridColumns(); return { x: (index % columns) * GRID, y: Math.floor(index / columns) * GRID }; }
function availablePosition(preferred, occupied) {
  const columns = gridColumns();
  const column = clamp(Math.round((Number(preferred?.x) || 0) / GRID), columns - 1);
  const row = Math.max(0, Math.round((Number(preferred?.y) || 0) / GRID));
  const cell = `${column},${row}`;
  if (!occupied.has(cell)) { occupied.add(cell); return { x: column * GRID, y: row * GRID }; }
  let best;
  for (let y = 0; y <= row + occupied.size + 1; y++) {
    for (let x = 0; x < columns; x++) {
      if (occupied.has(`${x},${y}`)) continue;
      const distance = Math.abs(x - column) + Math.abs(y - row);
      if (!best || distance < best.distance) best = { x, y, distance };
    }
  }
  occupied.add(`${best.x},${best.y}`);
  return { x: best.x * GRID, y: best.y * GRID };
}
function positionIcon(element, position) { element.style.left = `${position.x}px`; element.style.top = `${position.y}px`; }
function renderIcons() {
  if (editor?.scope === 'desktop') { editor.needsRefresh = true; return; }
  const scroll = $('icons').scrollTop;
  $('icons').replaceChildren();
  const entries = desktopAvailable ? [...(directories[rootPath] || []), ...state.shortcuts.map(commandItem)].filter(visibleEntry) : [];
  const occupied = new Set();
  entries.forEach((item, index) => {
    const element = makeDesktopIcon(item);
    const preferred = state.positions[element.dataset.id] || gridPosition(index);
    positionIcon(element, availablePosition(preferred, occupied));
    $('icons').append(element);
  });
  $('icons').scrollTop = scroll;
  $('cacheStatus').textContent = `${entries.length} 项`;
  syncSelection();
}
function arrange() {
  if (editor) return;
  state.positions = {};
  renderIcons();
  $('icons').querySelectorAll('.icon').forEach(element => { state.positions[element.dataset.id] = { x: element.offsetLeft, y: element.offsetTop }; });
  persistConfig({ positions: state.positions });
  showInterfaceAction('整理桌面'); notify('桌面图标已按网格整理');
}
function clearDropHighlight() { document.querySelectorAll('.drop-target').forEach(element => element.classList.remove('drop-target')); }
function dropDestination(element) {
  const tab = element?.closest('.window-tab');
  if (tab) return { element: tab, parent: getWindow(tab.dataset.windowId)?.folder };
  const entry = element?.closest('.entry, .icon');
  const item = entry && items.get(entry.dataset.key);
  if (item?.type === 'folder' && !item.broken) return { element: entry, parent: item.path };
  const win = element?.closest('.window');
  if (win) return { element: win.querySelector('.listing'), parent: getWindow(win.dataset.windowId)?.folder };
  if (element?.closest('#icons')) return { element: $('icons'), parent: rootPath };
  return null;
}
function canMove(paths, parent) {
  return parent && paths.length && paths.every(path => path !== parent && !parent.startsWith(`${path}/`)) && paths.some(path => parentOf(path) !== parent);
}
function moveFiles(paths, parent) {
  const moving = paths.filter(path => parentOf(path) !== parent);
  if (!canMove(moving, parent)) return;
  sendOperation({ operation: 'paste', parent, clipboard: { mode: 'move', paths: moving } });
}
function bindDesktopDrag(element, item) {
  element.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('input') || editor) return;
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    let moving = [];
    element.setPointerCapture(event.pointerId);
    function move(next) {
      const dx = next.clientX - start.x, dy = next.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      if (!moved) {
        moved = true; preserveSelection(item, 'desktop');
        moving = [...$('icons').querySelectorAll('.icon.selected')].map(icon => ({ element: icon, x: icon.offsetLeft, y: icon.offsetTop }));
        moving.forEach(record => record.element.classList.add('dragging'));
        $('dragGhost').textContent = moving.length === 1 ? item.name : `${moving.length} 项`;
        $('dragGhost').hidden = false;
      }
      $('dragGhost').style.left = `${next.clientX + 15}px`; $('dragGhost').style.top = `${next.clientY + 12}px`;
      const target = dropDestination(document.elementFromPoint(next.clientX, next.clientY));
      clearDropHighlight();
      if (target && canMove(selectedFilePaths('desktop'), target.parent)) target.element.classList.add('drop-target');
    }
    function finish(next) {
      element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', finish); element.removeEventListener('pointercancel', finish);
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      $('dragGhost').hidden = true; clearDropHighlight();
      if (!moved) return;
      element.suppressClick = true; setTimeout(() => { element.suppressClick = false; }, 0);
      moving.forEach(record => record.element.classList.remove('dragging'));
      if (next.type === 'pointercancel') return;
      const target = dropDestination(document.elementFromPoint(next.clientX, next.clientY));
      const paths = selectedFilePaths('desktop');
      if (target && target.parent !== rootPath && canMove(paths, target.parent)) { moveFiles(paths, target.parent); return; }
      const dx = Math.round((next.clientX - start.x) / GRID) * GRID;
      const dy = Math.round((next.clientY - start.y) / GRID) * GRID;
      const movingElements = new Set(moving.map(record => record.element));
      const occupied = new Set([...$('icons').querySelectorAll('.icon')].filter(icon => !movingElements.has(icon)).map(icon => `${Math.round(icon.offsetLeft / GRID)},${Math.round(icon.offsetTop / GRID)}`));
      moving.forEach(record => {
        const position = availablePosition({ x: record.x + dx, y: record.y + dy }, occupied);
        positionIcon(record.element, position); state.positions[record.element.dataset.id] = position;
      });
      persistConfig({ positions: state.positions });
    }
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', finish); element.addEventListener('pointercancel', finish);
  });
}
function bindDropSurface(surface) {
  surface.addEventListener('dragover', event => {
    if (!dragPayload && ![...event.dataTransfer.types].includes('application/x-remote-desktop')) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
    clearDropHighlight();
    const target = dropDestination(event.target);
    if (target) target.element.classList.add('drop-target');
  });
  surface.addEventListener('dragleave', event => { if (!surface.contains(event.relatedTarget)) clearDropHighlight(); });
  surface.addEventListener('drop', event => {
    event.preventDefault(); event.stopPropagation(); clearDropHighlight();
    let payload = dragPayload;
    try { const raw = event.dataTransfer.getData('application/x-remote-desktop'); if (raw) payload = JSON.parse(raw); } catch { return; }
    const target = dropDestination(event.target);
    if (target && Array.isArray(payload?.paths) && payload.paths.every(path => typeof path === 'string')) moveFiles(payload.paths, target.parent);
    dragPayload = null;
  });
}
function bindMarquee(surface, scope) {
  surface.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('.icon, .entry, input') || editor) return;
    event.preventDefault();
    if (scope !== 'desktop') focusWindow(scope);
    $('context').hidden = true;
    const additive = event.ctrlKey || event.metaKey;
    const original = additive && selection.scope === scope ? new Set(selection.keys) : new Set();
    selection = { scope, keys: new Set(original) }; syncSelection();
    const start = { x: event.clientX, y: event.clientY };
    surface.setPointerCapture(event.pointerId);
    function move(next) {
      const bounds = surface.getBoundingClientRect();
      const endX = Math.max(bounds.left, Math.min(next.clientX, bounds.right));
      const endY = Math.max(bounds.top, Math.min(next.clientY, bounds.bottom));
      const left = Math.min(start.x, endX), top = Math.min(start.y, endY), width = Math.abs(endX - start.x), height = Math.abs(endY - start.y);
      const box = $('selectionBox'); box.hidden = false;
      box.style.left = `${left}px`; box.style.top = `${top}px`; box.style.width = `${width}px`; box.style.height = `${height}px`;
      selection.keys = new Set(original);
      surface.querySelectorAll('.icon, .entry').forEach(element => {
        const rect = element.getBoundingClientRect();
        if (rect.right > left && rect.left < left + width && rect.bottom > top && rect.top < top + height) selection.keys.add(element.dataset.key);
      });
      syncSelection();
    }
    function finish() {
      surface.removeEventListener('pointermove', move); surface.removeEventListener('pointerup', finish); surface.removeEventListener('pointercancel', finish);
      if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
      $('selectionBox').hidden = true;
    }
    surface.addEventListener('pointermove', move); surface.addEventListener('pointerup', finish); surface.addEventListener('pointercancel', finish);
  });
}
function scheduleBrowserLayout() {
  if (browserLayoutFrame !== null) return;
  browserLayoutFrame = requestAnimationFrame(() => {
    browserLayoutFrame = null;
    const obscured = document.hidden || Boolean(document.querySelector('dialog:modal')) || ['downloadsPanel', 'context', 'appContext', 'activityToast'].some(id => !$(id).hidden);
    for (const win of state.windows.filter(current => current.kind === 'browser')) {
      const surface = windowElements.get(win.id)?.querySelector('.browser-surface');
      if (!surface) continue;
      const rect = surface.getBoundingClientRect();
      const hidden = obscured || win.minimized || state.activeWindow !== win.id || rect.width < 1 || rect.height < 1;
      const bounds = { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
      const key = JSON.stringify([bounds, hidden]);
      if (win.browserLayout === key) continue;
      win.browserLayout = key;
      void api.layoutBrowser?.(win.browserId, bounds, hidden).catch(error => { win.browserLayout = null; notify(error.message); });
    }
  });
}
async function openServerBrowser() {
  if (!remoteMode) { notify('请先连接 SSH，再打开服务器浏览器。'); return; }
  const existing = state.windows.find(win => win.kind === 'browser');
  if (existing) { focusWindow(existing.id); return; }
  if (browserOpening) return browserOpening;
  const generation = connectionGeneration;
  browserOpening = (async () => {
    try {
      const result = await api.openBrowser();
      if (!remoteMode || generation !== connectionGeneration) { await api.closeBrowser(result.id); return; }
      const win = { id: `browser-${result.id}`, kind: 'browser', browserId: result.id, minimized: false, maximized: false, position: { x: 46, y: 24 }, size: { width: 1050, height: 700 }, z: ++nextLayer };
      const element = $('windowTemplate').content.firstElementChild.cloneNode(true);
      element.classList.add('browser-window'); element.dataset.windowId = win.id; element.setAttribute('aria-label', '服务器浏览器');
      for (const child of [...element.children]) if (!child.classList.contains('titlebar')) child.remove();
      // The browser is a virtual application window, so keep its titlebar icon
      // distinct from the folder icon used by the explorer template.
      const appIcon = element.querySelector('.window-app-icon');
      if (appIcon) {
        appIcon.className = 'window-app-icon browser-app-icon';
        appIcon.replaceChildren(toolIcon('Globe'));
      }
      element.querySelector('.window-title').textContent = '服务器浏览器';
      element.querySelector('[data-window-action="close"]').setAttribute('aria-label', '关闭浏览器窗口');
      const surface = document.createElement('div'); surface.className = 'browser-surface';
      const resume = document.createElement('button'); resume.type = 'button'; resume.textContent = '点击继续浏览'; resume.addEventListener('click', () => focusWindow(win.id)); surface.append(resume); element.append(surface);
      renderToolIcons(element); state.windows.push(win); windowElements.set(win.id, element); $('windows').append(element);
      element.addEventListener('pointerdown', () => { if (state.activeWindow !== win.id) focusWindow(win.id); });
      element.addEventListener('click', event => { const action = event.target.closest('[data-window-action]')?.dataset.windowAction; if (action) void windowAction(action, win); });
      bindWindowDrag(win, element); bindWindowResize(win, element); focusWindow(win.id);
    } catch (error) { notify(error.message || String(error)); }
    finally { browserOpening = null; }
  })();
  return browserOpening;
}
api.onBrowserEvent?.(event => {
  const win = state.windows.find(current => current.kind === 'browser' && current.browserId === event.id);
  if (!win) return;
  if (event.type === 'closed') void windowAction('close-confirmed', win);
  else if (event.type === 'focus') focusWindow(win.id);
});
function activityText(value) {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return text.length > 32768 ? text.slice(0, 32768) + '\n[界面显示已截断；完整内容请查看日志文件]' : text;
}
function activityTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' }) : activityText(value || '未知');
}
function activityIp(session) {
  return session?.ip ? `${session.ip}${session.ipSource === 'ssh-local-address' ? '（SSH 本机出口地址）' : ''}` : '本机命名管道（无网络 IP）';
}
function mergeActivitySessions(sessions, preferExisting = false) {
  const merged = new Map(activity.sessions.map(session => [session.id, session]));
  for (const session of sessions || []) {
    if (!session || typeof session.id !== 'string') continue;
    const safe = Object.fromEntries(Object.entries(session).map(([key, value]) => [key, typeof value === 'string' ? activityText(value) : key === 'logPaths' && Array.isArray(value) ? value.slice(-100).map(activityText) : value]));
    merged.set(session.id, preferExisting ? { ...safe, ...merged.get(session.id) } : { ...merged.get(session.id), ...safe });
  }
  activity.sessions = [...merged.values()].slice(-ACTIVITY_SESSION_LIMIT);
  if (!activity.selected || !activity.sessions.some(session => session.id === activity.selected)) activity.selected = activity.sessions.at(-1)?.id || '';
}
function mergeActivityEntries(entries) {
  const merged = new Map(activity.entries.map(entry => [entry.key, entry]));
  for (const record of entries || []) {
    if (!record || typeof record !== 'object') continue;
    const key = record.id != null ? String(record.id) : record.seq != null ? `seq-${record.seq}` : null;
    if (!key || merged.has(key)) continue;
    const content = Object.fromEntries(Object.entries(record).filter(([name]) => !['id', 'seq', 'sessionId', 'source', 'scope', 'time', 'type'].includes(name)));
    const labels = { action: '操作', command: '指令', cwd: '工作目录', args: '参数', result: '结果', error: '错误', progress: '进度', exitCode: '退出码' };
    const fields = Object.entries(content).flatMap(([name, value]) => name === 'args' && value && typeof value === 'object' ? Object.entries(value) : [[name, value]]);
    const text = fields.filter(([name]) => name !== 'stream').map(([name, value]) => name === 'data' ? activityText(value) : `${labels[name] || name}: ${activityText(value)}`).join('\n');
    const entry = { key, seq: record.seq, sessionId: record.sessionId, time: record.time, type: record.type, content: activityText(text), stream: record.stream };
    entry.bytes = entry.content.length * 2 + 256;
    merged.set(key, entry);
  }
  activity.entries = [...merged.values()].sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0)).slice(-ACTIVITY_ENTRY_LIMIT);
  let size = activity.entries.reduce((sum, entry) => sum + entry.bytes, 0);
  while (size > ACTIVITY_BYTE_LIMIT && activity.entries.length) size -= activity.entries.shift().bytes;
}
function receiveActivitySnapshot(snapshot, preferExisting = false) {
  if (!snapshot || typeof snapshot !== 'object') return;
  mergeActivitySessions(snapshot.sessions, preferExisting); mergeActivityEntries(snapshot.entries);
  if (!preferExisting) {
    activity.systemLogPath = activityText(snapshot.systemLogPath || '');
    activity.error = activityText(snapshot.error || ''); activity.connected = Boolean(snapshot.connected);
  }
  scheduleActivityRender();
}
function scheduleActivityRender() {
  if (activityFrame !== null) return;
  activityFrame = requestAnimationFrame(() => { activityFrame = null; renderActivityWindow(); });
}
function renderActivityWindow() {
  const toastSession = activity.sessions.find(session => session.id === activity.toastSession);
  $('activityToast').querySelector('.activity-toast-note').textContent = activity.error || toastSession?.error ? `日志写入异常：${activity.error || toastSession.error}` : '监听已自动开启，操作历史自动保存到日志。';
  const element = windowElements.get('activity-window');
  if (!element) return;
  const select = element.querySelector('.activity-session');
  select.replaceChildren();
  for (const session of activity.sessions.slice().reverse()) {
    const option = document.createElement('option'); option.value = session.id;
    option.textContent = `${activityTime(session.time)} · ${session.action || 'CLI'}`; select.append(option);
  }
  select.value = activity.selected; select.disabled = !activity.sessions.length;
  const session = activity.sessions.find(current => current.id === activity.selected);
  element.querySelector('.activity-status').textContent = activity.connected ? '监听已自动开启 · 关闭窗口不停止记录' : '当前连接已断开 · 可查看本次应用运行期间的记录';
  const paths = session?.logPaths?.length ? session.logPaths.join('\n') : session?.logPath || '尚无命令行日志';
  element.querySelector('.activity-metadata').textContent = session ? `IP：${activityIp(session)}\n连接时间：${activityTime(session.time)}\n命令行日志：${paths}\n系统日志：${activity.systemLogPath || '尚未创建'}` : `尚未检测到本地命令行操作。\n系统日志：${activity.systemLogPath || '尚未创建'}`;
  const error = element.querySelector('.activity-error'); error.textContent = [activity.error, session?.error].filter(Boolean).join('\n'); error.hidden = !error.textContent;
  const events = element.querySelector('.activity-events');
  const follow = element.querySelector('.activity-follow').checked;
  const scrollTop = events.scrollTop;
  events.replaceChildren();
  const entries = activity.entries.filter(entry => entry.sessionId === activity.selected);
  if (!entries.length) {
    const empty = document.createElement('p'); empty.className = 'activity-empty'; empty.textContent = session ? '等待指令与回复…' : '命令行连接后将在这里实时显示指令与回复。'; events.append(empty);
  }
  const labels = { command: '发送指令', start: '请求开始', request: '请求', stdout: '标准输出', stderr: '错误输出', output: '服务器回复', progress: '进度', result: '执行结果', end: '请求结束', error: '错误' };
  for (const entry of entries) {
    const row = document.createElement('section'); row.className = 'activity-entry'; row.dataset.entryId = entry.key;
    const heading = document.createElement('div'); heading.className = 'activity-entry-heading'; heading.textContent = `${activityTime(entry.time)} · ${labels[entry.type] || entry.type || '活动'}`;
    const text = document.createElement('pre'); text.textContent = entry.content; if (entry.type === 'error' || entry.type === 'stderr' || entry.stream === 'stderr') text.className = 'activity-error-output';
    row.append(heading, text); events.append(row);
  }
  events.scrollTop = follow ? events.scrollHeight : scrollTop;
}
function openActivityWindow(sessionId) {
  $('activityToast').hidden = true; $('downloadsPanel').hidden = true; $('context').hidden = true; $('appContext').hidden = true;
  if (typeof sessionId === 'string' && activity.sessions.some(session => session.id === sessionId)) activity.selected = sessionId;
  let win = getWindow('activity-window');
  if (!win) {
    win = { id: 'activity-window', kind: 'activity', minimized: false, maximized: false, position: { x: 84, y: 42 }, size: { width: 850, height: 620 }, z: ++nextLayer };
    const element = $('windowTemplate').content.firstElementChild.cloneNode(true); element.dataset.windowId = win.id; element.classList.add('activity-window'); element.setAttribute('aria-label', '实时监听');
    for (const child of [...element.children]) if (!child.classList.contains('titlebar') && !child.classList.contains('resize-handle')) child.remove();
    const icon = element.querySelector('.window-app-icon'); icon.className = 'window-app-icon activity-app-icon'; icon.replaceChildren(toolIcon('Activity'));
    element.querySelector('.window-title').textContent = '实时监听 · 本地命令行'; element.querySelector('[data-window-action="close"]').setAttribute('aria-label', '关闭实时监听窗口');
    const toolbar = document.createElement('div'); toolbar.className = 'activity-toolbar';
    const label = document.createElement('label'); label.append('连接 '); const select = document.createElement('select'); select.className = 'activity-session'; select.setAttribute('aria-label', '命令行连接'); label.append(select);
    select.addEventListener('change', () => { activity.selected = select.value; renderActivityWindow(); });
    const followLabel = document.createElement('label'), follow = document.createElement('input'); follow.type = 'checkbox'; follow.checked = true; follow.className = 'activity-follow'; followLabel.append(follow, '自动滚动');
    const status = document.createElement('span'); status.className = 'activity-status'; toolbar.append(label, followLabel, status);
    const metadata = document.createElement('div'); metadata.className = 'activity-metadata';
    const error = document.createElement('p'); error.className = 'activity-error'; error.setAttribute('role', 'alert'); error.hidden = true;
    const events = document.createElement('div'); events.className = 'activity-events'; events.setAttribute('aria-label', '实时指令与回复'); events.tabIndex = 0;
    const footer = document.createElement('div'); footer.className = 'window-footer'; footer.textContent = '界面最多保留最近 600 条活动（约 2 MiB）；完整历史保存在服务器桌面的 .log 目录。';
    element.append(toolbar, metadata, error, events, footer); renderToolIcons(element);
    state.windows.push(win); windowElements.set(win.id, element); $('windows').append(element);
    element.addEventListener('pointerdown', () => { if (state.activeWindow !== win.id) focusWindow(win.id); });
    element.addEventListener('click', event => { const action = event.target.closest('[data-window-action]')?.dataset.windowAction; if (action) void windowAction(action, win); });
    element.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); void windowAction('close', win); } });
    bindWindowDrag(win, element); bindWindowResize(win, element);
  }
  renderActivityWindow(); focusWindow(win.id);
}
api.onActivityEvent?.(event => {
  activity.revision++;
  if (event?.type === 'connection' && event.session) {
    mergeActivitySessions([event.session]); activity.toastSession = event.session.id; activity.connected = true;
    $('activityToastIp').textContent = `IP：${activityIp(event.session)}`;
    $('activityToastTime').textContent = `连接时间：${activityTime(event.session.time)}`;
    $('activityToast').hidden = false; scheduleBrowserLayout();
  } else if (event?.type === 'session' && event.session) mergeActivitySessions([event.session]);
  else if (event?.type === 'entry') mergeActivityEntries([event.entry]);
  else if (event?.type === 'state') receiveActivitySnapshot(event.snapshot || event);
  scheduleActivityRender();
});
if (api.getActivitySnapshot) {
  const revision = activity.revision;
  api.getActivitySnapshot().then(snapshot => receiveActivitySnapshot(snapshot, activity.revision !== revision)).catch(error => { activity.error = `无法读取监听状态：${error.message || error}`; scheduleActivityRender(); });
}
function renderDock() {
  scheduleBrowserLayout();
  $('windowTabs').replaceChildren();
  for (const win of state.windows) {
    const tab = document.createElement('button');
    tab.className = `window-tab${win.id === state.activeWindow && !win.minimized ? ' active' : ''}${win.minimized ? ' minimized' : ''}`;
    const appTitle = { browser: '服务器浏览器', settings: '设置', activity: '实时监听' }[win.kind];
    const title = appTitle || (win.kind === 'terminal' ? `${PROGRAM_LABELS[win.program]} · ${win.folder}` : win.kind === 'image' ? win.imageName : win.folder);
    tab.dataset.windowId = win.id; tab.title = `${title}${win.minimized ? '（已最小化）' : ''}`;
    tab.setAttribute('aria-label', `${win.minimized ? '恢复' : '切换到'} ${title}`);
    const label = document.createElement('span'); label.className = 'tab-label'; label.textContent = appTitle || (win.kind === 'terminal' ? PROGRAM_LABELS[win.program] : win.kind === 'image' ? win.imageName : basename(win.folder));
    const appIcon = { browser: 'Globe', settings: 'Settings', activity: 'Activity', image: 'Image', terminal: 'Terminal' }[win.kind];
    tab.append(appIcon ? toolIcon(appIcon) : glyph({ type: 'folder', name: '' }), label);
    tab.addEventListener('click', () => { win.minimized = false; focusWindow(win.id); save(); });
    if (win.kind === 'terminal') tab.addEventListener('contextmenu', event => showAppMenu(event, null, win));
    $('windowTabs').append(tab);
  }
}
function renderPinnedApps() {
  $('pinnedApps').replaceChildren();
  for (const app of state.pinnedApps) {
    const button = document.createElement('button');
    button.className = 'pinned-app'; button.dataset.appId = app.id; button.dataset.program = app.program;
    button.title = `启动 ${app.label} · 右键取消固定`; button.setAttribute('aria-label', `启动 ${app.label}`);
    const label = document.createElement('span'); label.textContent = app.label; label.className = 'tab-label';
    button.append(toolIcon(app.program === 'htop' ? 'Activity' : app.program === 'vim' ? 'FilePenLine' : 'Terminal'), label);
    button.addEventListener('click', () => openTerminal(rootPath, app.program));
    button.addEventListener('contextmenu', event => showAppMenu(event, app));
    $('pinnedApps').append(button);
  }
}
function showAppMenu(event, app, win) {
  event.preventDefault(); event.stopPropagation(); $('context').hidden = true;
  appContextId = app?.id || null; appContextWindowId = win?.id || null;
  const toggle = $('togglePinApp'), unpin = $('unpinApp');
  toggle.hidden = !win; unpin.hidden = Boolean(win);
  if (win) toggle.textContent = state.pinnedApps.some(current => current.program === win.program) ? '从任务栏取消固定' : '固定到任务栏';
  const menu = $('appContext'); menu.hidden = false;
  menu.style.left = `${clamp(event.clientX, innerWidth - menu.offsetWidth - 6)}px`;
  menu.style.top = `${clamp(event.clientY, innerHeight - menu.offsetHeight - 6)}px`;
}
function fitTerminal(win) {
  const record = terminals.get(win.id), element = windowElements.get(win.id);
  if (!record || !element || win.minimized || document.hidden || !element.offsetWidth || !element.offsetHeight) return;
  record.fit.fit();
  if (record.opened && (record.cols !== record.terminal.cols || record.rows !== record.terminal.rows)) {
    record.cols = record.terminal.cols; record.rows = record.terminal.rows;
    host.postMessage({ type: 'terminalResize', id: win.id, cols: record.cols, rows: record.rows });
  }
}
function openTerminal(path, program = 'shell', filePath, readOnly = false) {
  if (!remoteMode) { notify('请先连接 SSH'); return; }
  if (!Object.hasOwn(PROGRAM_LABELS, program)) return;
  const offset = state.windows.length * 34;
  const win = { id: `terminal-${nextWindow++}`, kind: 'terminal', program, folder: path, minimized: false, maximized: false, position: { x: 24 + offset, y: 44 + offset }, size: { width: 740, height: 500 }, z: ++nextLayer };
  state.windows.push(win);
  const element = $('terminalTemplate').content.firstElementChild.cloneNode(true);
  element.dataset.windowId = win.id; element.dataset.program = program;
  element.setAttribute('aria-label', `${PROGRAM_LABELS[program]} 终端 ${filePath || path}`);
  element.querySelector('.window-title').textContent = `${PROGRAM_LABELS[program]}${readOnly ? '（只读）' : ''} — ${basename(filePath || path)}`;
  element.querySelector('.terminal-location').textContent = filePath || path;
  element.querySelector('.terminal-location').title = filePath || path;
  renderToolIcons(element); windowElements.set(win.id, element); $('windows').append(element);
  element.addEventListener('pointerdown', () => { if (state.activeWindow !== win.id) focusWindow(win.id); });
  element.addEventListener('click', event => {
    const launch = event.target.closest('[data-terminal-program]')?.dataset.terminalProgram;
    if (launch) { openTerminal(path, launch); return; }
    const action = event.target.closest('[data-window-action]')?.dataset.windowAction;
    if (action) windowAction(action, win);
  });
  bindWindowDrag(win, element); bindWindowResize(win, element); positionWindow(win); focusWindow(win.id);
  if (typeof Terminal !== 'function' || typeof FitAddon === 'undefined' || typeof FitAddon.FitAddon !== 'function') {
    element.querySelector('.terminal-status').textContent = '终端组件未载入，请重新打开桌面'; return;
  }
  const terminal = new Terminal({ cursorBlink: true, fontFamily: 'Consolas, "DejaVu Sans Mono", monospace', fontSize: 13, scrollback: 5000, theme: { background: '#18221f', foreground: '#e8efea', cursor: '#a8ddbd', selectionBackground: '#557b68' } });
  const fit = new FitAddon.FitAddon(); terminal.loadAddon(fit);
  const record = { terminal, fit, opened: false, active: true };
  terminals.set(win.id, record);
  terminal.open(element.querySelector('.terminal-surface'));
  // Desktop file shortcuts must not consume terminal keys.
  element.querySelector('.terminal-surface').addEventListener('keydown', event => event.stopPropagation());
  terminal.onData(data => { if (record.active && record.opened) host.postMessage({ type: 'terminalInput', id: win.id, data }); });
  record.observer = new ResizeObserver(() => fitTerminal(win)); record.observer.observe(element.querySelector('.terminal-surface'));
  fitTerminal(win);
  host.postMessage({ type: 'openTerminal', id: win.id, path, program, ...(filePath ? { filePath } : {}), ...(readOnly ? { readOnly: true } : {}), cols: terminal.cols, rows: terminal.rows });
  terminal.focus(); save();
}
function disposeTerminal(id) {
  const record = terminals.get(id); if (!record) return;
  record.active = false; record.observer.disconnect(); record.terminal.dispose(); terminals.delete(id);
}
function handleTerminalMessage(message) {
  const win = getWindow(message.id), record = terminals.get(message.id), element = windowElements.get(message.id);
  if (!win || !record || !element) return;
  if (message.type === 'terminalClosed') { windowAction('close-confirmed', win); return; }
  if (message.type === 'terminalOpened') {
    record.opened = true; element.querySelector('.terminal-status').textContent = `${PROGRAM_LABELS[win.program]} · 运行中`;
    fitTerminal(win);
  } else if (message.type === 'terminalData' && typeof message.data === 'string') record.terminal.write(message.data);
  else if (message.type === 'terminalExit' || message.type === 'terminalError') {
    record.active = false;
    const text = message.type === 'terminalError' ? `终端启动失败：${message.error || '未知错误'}` : `进程已退出（${message.exitCode ?? '未知'}）`;
    record.terminal.write(`\r\n\x1b[90m[${text}]\x1b[0m\r\n`);
    element.querySelector('.terminal-status').textContent = text;
    if (message.type === 'terminalError') notify(text);
  }
}
function focusWindow(id) {
  const win = getWindow(id); if (!win) return;
  if (state.activeWindow !== id || win.minimized) { state.activeWindow = id; win.z = ++nextLayer; }
  win.minimized = false;
  for (const current of state.windows) {
    const element = windowElements.get(current.id);
    if (!element) continue;
    element.hidden = current.minimized;
    element.classList.toggle('active', current.id === id);
    element.style.zIndex = String(current.z || 1);
  }
  positionWindow(win);
  if (win.kind === 'terminal') { fitTerminal(win); terminals.get(win.id)?.terminal.focus(); }
  renderDock(); save();
}
function positionWindow(win) {
  scheduleBrowserLayout();
  const element = windowElements.get(win.id); if (!element) return;
  // Hidden webviews temporarily have zero layout bounds; preserve the user's position.
  if (document.hidden || !$('windows').clientWidth || !$('windows').clientHeight || win.minimized) return;
  element.classList.toggle('maximized', Boolean(win.maximized));
  const bounds = $('windows');
  const fallback = win.kind === 'terminal' ? { width: 740, height: 500 } : { width: 650, height: 430 };
  const preferred = win.size || fallback;
  const width = win.maximized ? Math.max(1, bounds.clientWidth - 8) : Math.min(Math.max(300, Number(preferred.width) || fallback.width), Math.max(1, bounds.clientWidth - 8));
  const height = win.maximized ? Math.max(1, bounds.clientHeight - 8) : Math.min(Math.max(220, Number(preferred.height) || fallback.height), Math.max(1, bounds.clientHeight - 8));
  element.style.width = `${width}px`; element.style.height = `${height}px`;
  const position = win.maximized ? { x: 4, y: 4 } : {
    x: clamp(win.position?.x ?? 24, $('windows').clientWidth - element.offsetWidth),
    y: clamp(win.position?.y ?? 48, $('windows').clientHeight - element.offsetHeight)
  };
  element.style.left = `${position.x}px`; element.style.top = `${position.y}px`;
  const maximize = element.querySelector('[data-window-action="maximize"]');
  maximize.replaceChildren(toolIcon(win.maximized ? 'Copy' : 'Square'));
  maximize.title = win.maximized ? '还原' : '最大化'; maximize.setAttribute('aria-label', maximize.title);
  if (win.kind === 'terminal') fitTerminal(win);
  if (win.kind === 'image') resizeImage(win);
}
function bindWindowDrag(win, element) {
  const bar = element.querySelector('.titlebar');
  bar.addEventListener('dblclick', event => { if (!event.target.closest('button')) { win.maximized = !win.maximized; positionWindow(win); save(); } });
  bar.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button') || win.maximized) return;
    const start = { x: event.clientX, y: event.clientY }, origin = { x: element.offsetLeft, y: element.offsetTop };
    bar.setPointerCapture(event.pointerId);
    function move(next) { win.position = { x: clamp(origin.x + next.clientX - start.x, $('windows').clientWidth - element.offsetWidth), y: clamp(origin.y + next.clientY - start.y, $('windows').clientHeight - element.offsetHeight) }; positionWindow(win); }
    function finish() {
      bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', finish); bar.removeEventListener('pointercancel', finish);
      if (bar.hasPointerCapture(event.pointerId)) bar.releasePointerCapture(event.pointerId); save();
    }
    bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', finish); bar.addEventListener('pointercancel', finish);
  });
}
function bindWindowResize(win, element) {
  for (const direction of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    const handle = document.createElement('div'); handle.className = 'resize-handle'; handle.dataset.resize = direction;
    handle.setAttribute('aria-hidden', 'true'); element.append(handle);
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || win.maximized || document.hidden) return;
      const surface = $('windows'); if (!surface.clientWidth || !surface.clientHeight) return;
      event.preventDefault(); event.stopPropagation(); focusWindow(win.id);
      const start = { x: event.clientX, y: event.clientY, left: element.offsetLeft, top: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight };
      const right = start.left + start.width, bottom = start.top + start.height;
      const minWidth = Math.min(300, surface.clientWidth), minHeight = Math.min(220, surface.clientHeight);
      handle.setPointerCapture(event.pointerId);
      function move(next) {
        if (!surface.clientWidth || !surface.clientHeight || document.hidden) return;
        const dx = next.clientX - start.x, dy = next.clientY - start.y;
        let left = start.left, top = start.top, width = start.width, height = start.height;
        if (direction.includes('e')) width = Math.max(minWidth, Math.min(start.width + dx, surface.clientWidth - left));
        if (direction.includes('s')) height = Math.max(minHeight, Math.min(start.height + dy, surface.clientHeight - top));
        if (direction.includes('w')) { left = clamp(start.left + dx, right - minWidth); width = right - left; }
        if (direction.includes('n')) { top = clamp(start.top + dy, bottom - minHeight); height = bottom - top; }
        win.position = { x: left, y: top }; win.size = { width, height }; positionWindow(win);
      }
      function finish() {
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', finish);
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        save();
      }
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
    });
  }
}
function createWindow(path, restored) {
  const offset = state.windows.length * 34;
  const win = { id: `window-${nextWindow++}`, folder: path, minimized: false, maximized: false, position: { x: 24 + offset, y: 44 + offset }, size: { width: 650, height: 430 }, viewMode: state.viewMode, history: [], forward: [], z: ++nextLayer, ...restored };
  if (state.windows.some(existing => existing.id === win.id)) win.id = `window-${nextWindow++}`;
  state.windows.push(win);
  const element = $('windowTemplate').content.firstElementChild.cloneNode(true);
  renderToolIcons(element);
  element.dataset.windowId = win.id;
  windowElements.set(win.id, element); $('windows').append(element);
  element.addEventListener('pointerdown', () => { if (state.activeWindow !== win.id) focusWindow(win.id); });
  element.addEventListener('click', event => {
    const action = event.target.closest('[data-window-action]')?.dataset.windowAction;
    if (action) windowAction(action, win);
  });
  const listing = element.querySelector('.listing');
  listing.addEventListener('contextmenu', event => {
    if (event.target.closest('.entry')) return;
    selection = { scope: win.id, keys: new Set() }; syncSelection(); showMenu(event, contextFor(win.id));
  });
  const address = element.querySelector('.window-path');
  address.addEventListener('pointerdown', event => { event.stopPropagation(); if (state.activeWindow !== win.id) focusWindow(win.id); });
  address.addEventListener('input', () => { address.dataset.dirty = 'true'; address.removeAttribute('aria-invalid'); address.title = address.value; });
  address.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      try { navigateWindow(win, resolveDirectoryAddress(address.value, win.folder)); }
      catch (error) { win.error = error.message; address.setAttribute('aria-invalid', 'true'); address.title = error.message; updateWindowStatus(win); notify(error.message); }
    } else if (event.key === 'Escape') {
      event.preventDefault(); win.pendingNavigation = null; win.error = null; delete address.dataset.dirty;
      address.value = win.folder; address.title = win.folder; address.removeAttribute('aria-invalid'); updateWindowStatus(win);
    }
  });
  const pickerPath = element.querySelector('.window-picker-path');
  pickerPath.addEventListener('input', () => {
    if (transferPicker?.windowId === win.id) { transferPicker.path = pickerPath.value; win.error = null; updateWindowStatus(win); }
  });
  pickerPath.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); void confirmServerPicker(); }
    else if (event.key === 'Escape') { event.preventDefault(); finishServerPicker(null); }
  });
  bindMarquee(listing, win.id); bindDropSurface(element); bindWindowDrag(win, element); bindWindowResize(win, element);
  positionWindow(win); renderWindow(win); renderDock();
  return win;
}
function openFolder(path, windowId) {
  if (!remoteMode) { notify('请先连接 SSH'); return; }
  let win = getWindow(windowId);
  const initial = !win;
  if (!win) win = createWindow(remoteMode ? rootPath : path);
  focusWindow(win.id); renderWindow(win); save();
  navigateWindow(win, path, initial ? 'initial' : 'navigate');
  return win;
}
function commitNavigation(win, path, mode) {
  if (path !== win.folder) {
    if (mode === 'back') { win.history.pop(); win.forward.push(win.folder); }
    else if (mode === 'forward') { win.forward.pop(); win.history.push(win.folder); }
    else if (mode !== 'initial') { win.history.push(win.folder); win.forward = []; }
    win.folder = path;
    if (selection.scope === win.id) selection.keys.clear();
  }
  win.pendingNavigation = null; win.error = null;
  if (transferPicker?.windowId === win.id) {
    setServerPickerPath(transferPicker.initialSelection || path);
    transferPicker.initialSelection = null;
  }
  const address = windowElements.get(win.id)?.querySelector('.window-path');
  if (address) { delete address.dataset.dirty; address.value = path; address.removeAttribute('aria-invalid'); }
  renderWindow(win); renderDock(); save();
}
function navigateWindow(win, path, mode = 'navigate') {
  win.error = null;
  const address = windowElements.get(win.id)?.querySelector('.window-path');
  if (address) { address.value = path; address.dataset.dirty = 'true'; address.removeAttribute('aria-invalid'); address.title = path; }
  if (!remoteMode) { notify('SSH 已断开，请重新连接。'); return; }
  const requestId = requestDirectory(path, { intent: 'navigate', windowId: win.id, mode });
  win.pendingNavigation = { requestId, path, mode };
  updateWindowStatus(win); notify(`正在读取 ${path}…`);
}
function makeEntry(item, win, pending = false) {
  const element = document.createElement('button'); element.type = 'button'; element.className = `entry${pending ? ' editing' : ''}`;
  const name = document.createElement('span'); name.className = 'entry-name';
  const label = document.createElement('span'); label.className = 'entry-label'; label.textContent = item.name;
  name.append(glyph(item), label);
  const type = document.createElement('span'); type.className = 'entry-type'; type.textContent = itemType(item);
  const size = document.createElement('span'); size.className = 'entry-size'; size.textContent = item.type === 'folder' ? '' : item.size || '';
  element.append(name, type, size);
  if (!pending) bindItem(element, item, win.id);
  return element;
}
function updateWindowStatus(win) {
  if (win.kind) return;
  const element = windowElements.get(win.id); if (!element) return;
  const count = directories[win.folder]?.filter(visibleEntry).length;
  const selected = selection.scope === win.id ? selection.keys.size : 0;
  const error = element.querySelector('.window-error'); error.hidden = !win.error; error.textContent = win.error || '';
  element.querySelector('.window-footer').textContent = win.error || (win.pendingNavigation ? `正在读取 ${win.pendingNavigation.path}…` : count === undefined ? '正在读取…' : `${count} 项${selected ? ` · 已选择 ${selected} 项` : ''}`);
}
function updateView(win) {
  const element = windowElements.get(win.id); if (!element) return;
  element.dataset.viewMode = win.viewMode;
  element.querySelector('.listing').classList.toggle('icon-view', win.viewMode === 'icons');
  element.querySelector('.column-headings').hidden = win.viewMode === 'icons';
  for (const mode of ['details', 'icons']) {
    const button = element.querySelector(`[data-window-action="${mode}"]`);
    button.classList.toggle('active', win.viewMode === mode); button.setAttribute('aria-pressed', String(win.viewMode === mode));
  }
}
function renderWindow(win) {
  if (win.kind) return;
  const element = windowElements.get(win.id); if (!element) return;
  element.querySelector('.window-title').textContent = `${transferPicker?.windowId === win.id ? transferPicker.title + ' · ' : ''}${basename(win.folder)}`;
  const address = element.querySelector('.window-path');
  if (address.dataset.dirty !== 'true') { address.value = win.folder; address.title = win.folder; }
  element.setAttribute('aria-label', `资源管理器 ${win.folder}`);
  element.querySelector('[data-window-action="back"]').disabled = !win.history.length;
  element.querySelector('[data-window-action="forward"]').disabled = !win.forward.length;
  element.querySelector('[data-window-action="up"]').disabled = win.folder === '/' || (!remoteMode && win.folder === rootPath);
  updateView(win);
  if (editor?.scope === win.id) { editor.needsRefresh = true; return; }
  const listing = element.querySelector('.listing'), scroll = listing.scrollTop;
  listing.replaceChildren();
  const entries = directories[win.folder]?.filter(visibleEntry);
  if (entries?.length) entries.forEach(item => listing.append(makeEntry(item, win)));
  else {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = win.error || (entries ? '此文件夹为空' : '正在读取…'); listing.append(empty);
  }
  listing.scrollTop = scroll; element.hidden = win.minimized; syncSelection();
}
async function windowAction(action, win) {
  if (win.kind === 'settings' && ['close', 'close-confirmed'].includes(action)) { closeSettings(); return; }
  if (win.kind === 'browser' && action === 'close') {
    try { await api.closeBrowser(win.browserId); } catch (error) { notify(error.message); return; }
    if (!getWindow(win.id)) return;
  }
  scheduleBrowserLayout();
  if (transferPicker?.windowId === win.id) {
    if (action === 'pick') { await confirmServerPicker(); return; }
    if (action === 'cancel-picker') { finishServerPicker(null); return; }
    if (action === 'close' || action === 'close-confirmed') finishServerPicker(null, true);
  }
  if (action === 'close' && win.kind === 'terminal') {
    if (win.closing) return;
    win.closing = true;
    const element = windowElements.get(win.id), button = element?.querySelector('[data-window-action="close"]');
    if (button) button.disabled = true;
    try {
      if (!await api.closeTerminal(win.id)) return;
      if (!getWindow(win.id)) return;
    } catch (error) { notify(error.message || '终端未关闭，请重试。'); return; }
    finally { win.closing = false; if (button) button.disabled = false; }
  }
  if (action === 'close' || action === 'close-confirmed') {
    if (win.kind === 'terminal') disposeTerminal(win.id);
    if (win.kind === 'image') { images.get(win.id)?.observer?.disconnect(); images.delete(win.id); }
    if (editor?.scope === win.id) editor.cancel();
    if (selection.scope === win.id) selection = { scope: 'desktop', keys: new Set() };
    windowElements.get(win.id)?.remove(); windowElements.delete(win.id);
    state.windows = state.windows.filter(current => current.id !== win.id);
    if (state.activeWindow === win.id) state.activeWindow = null;
    const visible = state.windows.filter(current => !current.minimized).sort((a, b) => b.z - a.z)[0];
    if (visible) focusWindow(visible.id); else renderDock(); save();
  } else if (action === 'minimize') {
    win.minimized = true; windowElements.get(win.id).hidden = true;
    const visible = state.windows.filter(current => !current.minimized).sort((a, b) => b.z - a.z)[0];
    state.activeWindow = null;
    if (visible) focusWindow(visible.id); else renderDock(); save();
  } else if (action === 'maximize') { win.maximized = !win.maximized; positionWindow(win); save(); }
  else if (action === 'back' || action === 'forward') {
    const path = (action === 'back' ? win.history : win.forward).at(-1);
    if (path) navigateWindow(win, path, action);
  }
  else if (action === 'up') openFolder(parentOf(win.folder), win.id);
  else if (action === 'pin' && win.kind === 'terminal') {
    const pinned = state.pinnedApps.find(app => app.program === win.program);
    host.postMessage(pinned ? { type: 'unpinApp', id: pinned.id } : { type: 'pinApp', app: { label: PROGRAM_LABELS[win.program], program: win.program } });
  }
  else if (action === 'refresh') refreshDirectory(win.folder);
  else if (action === 'icons' || action === 'details') { win.viewMode = action; state.viewMode = action; updateView(win); persistConfig({ viewMode: action }); showInterfaceAction(action === 'icons' ? '切换图标视图' : '切换详情视图'); }
  else performAction(action, contextFor(win.id));
}
function requestDirectory(path, options = {}) {
  if (!remoteMode) return;
  const requestId = `directory-${nextRequest++}`;
  directoryRequests.set(requestId, { path, ...options });
  latestDirectoryRequests.set(path, requestId);
  host.postMessage({ type: 'readDirectory', path, requestId, ...(options.intent ? { intent: options.intent } : {}), ...(options.windowId ? { windowId: options.windowId } : {}) });
  return requestId;
}
function refreshAll() {
  if (remoteMode) {
    const paths = [...new Set([rootPath, ...state.windows.filter(win => !win.kind).map(win => win.folder)])];
    if (desktopAvailable) host.postMessage({ type: 'refreshRemote', paths, intent: 'refresh' });
    notify('正在刷新…');
    paths.filter(path => !desktopAvailable || path !== rootPath).forEach(path => requestDirectory(path));
  } else { renderIcons(); state.windows.forEach(renderWindow); notify('已刷新本地示例'); showOperationCommand(`ls -la -- ${shellQuote(rootPath)} # 本地示例`); }
}
function refreshDirectory(path) {
  if (remoteMode) {
    if (desktopAvailable && path === rootPath) host.postMessage({ type: 'refreshRemote', paths: [rootPath], intent: 'refresh' });
    else requestDirectory(path, { intent: 'refresh' });
    notify(`正在刷新 ${path}…`);
  } else { renderIcons(); state.windows.forEach(renderWindow); notify('已刷新本地示例'); showOperationCommand(`ls -la -- ${shellQuote(path)} # 本地示例`); }
}
function showMenu(event, context) {
  if (!remoteMode) { event.preventDefault(); notify('请先连接 SSH'); return; }
  event.preventDefault(); event.stopPropagation();
  menuContext = context;
  $('appContext').hidden = true;
  if (context.scope !== 'desktop') focusWindow(context.scope);
  const selected = selectedItems(context.scope), files = selected.filter(item => item.kind !== 'command');
  const buttons = $('context');
  for (const action of ['open', 'copy', 'cut', 'delete']) buttons.querySelector(`[data-action="${action}"]`).disabled = !selected.length;
  buttons.querySelector('[data-action="rename"]').disabled = selected.length !== 1;
  buttons.querySelector('[data-action="shortcut"]').disabled = !files.length;
  buttons.querySelector('[data-action="download"]').disabled = !files.length;
  buttons.querySelector('[data-action="copy"]').disabled = !files.length;
  buttons.querySelector('[data-action="cut"]').disabled = !files.length;
  buttons.querySelector('[data-action="paste"]').disabled = !state.clipboard?.paths?.length;
  buttons.querySelector('[data-action="arrange"]').hidden = context.scope !== 'desktop';
  for (const action of ['workbench','vim']) buttons.querySelector(`[data-action="${action}"]`).disabled = files.length !== 1 || files[0].type === 'folder';
  buttons.hidden = false;
  buttons.style.left = `${clamp(event.clientX, window.innerWidth - buttons.offsetWidth - 6)}px`;
  buttons.style.top = `${clamp(event.clientY, window.innerHeight - buttons.offsetHeight - 6)}px`;
}
function nextName(parent, base, extension = '') {
  const names = new Set((directories[parent] || []).map(item => item.name));
  let candidate = `${base}${extension}`, number = 2;
  while (names.has(candidate)) candidate = `${base} (${number++})${extension}`;
  return candidate;
}
function nameError(value, parent, originalPath) {
  if (!value.trim() || value === '.' || value === '..') return '请输入有效名称';
  if (/[\/\\\x00-\x1f]/.test(value)) return '名称不能包含斜杠或控制字符';
  if ((directories[parent] || []).some(item => item.name === value && item.path !== originalPath)) return '已存在同名文件或文件夹';
  return null;
}
function beginNameEditor(operation, context) {
  if (editor) editor.cancel();
  const selected = selectedItems(context.scope);
  const original = operation === 'rename' ? selected[0] : null;
  if (operation === 'rename' && selected.length !== 1) return;
  const surface = getSurface(context.scope); if (!surface) return;
  const isNew = operation !== 'rename';
  const item = original || { name: operation === 'new-folder' ? nextName(context.parent, 'New Folder') : nextName(context.parent, 'New File', '.txt'), type: operation === 'new-folder' ? 'folder' : 'file' };
  let element;
  if (isNew) {
    surface.querySelector('.empty')?.remove();
    element = context.scope === 'desktop' ? makeDesktopIcon(item, true) : makeEntry(item, getWindow(context.scope), true);
    surface.append(element);
    if (context.scope === 'desktop') {
      const occupied = new Set([...surface.querySelectorAll('.icon')].filter(icon => icon !== element).map(icon => `${Math.round(icon.offsetLeft / GRID)},${Math.round(icon.offsetTop / GRID)}`));
      positionIcon(element, availablePosition(gridPosition(occupied.size), occupied));
    }
  } else element = [...surface.querySelectorAll('.icon, .entry')].find(candidate => candidate.dataset.key === keyOf(item));
  if (!element) return;
  const label = element.querySelector('.icon-label, .entry-label');
  const input = document.createElement('input'); input.className = 'name-editor'; input.value = item.name;
  input.setAttribute('aria-label', isNew ? '新建名称' : '重命名');
  label.hidden = true; label.after(input); element.classList.add('editing'); element.draggable = false;
  const session = { scope: context.scope, element, needsRefresh: false, cancel: () => finish(false) };
  editor = session;
  function finish(commit) {
    if (editor !== session) return;
    const name = input.value;
    const error = commit ? nameError(name, context.parent, original?.path) : null;
    if (error) {
      input.setAttribute('aria-invalid', 'true'); input.title = error; notify(error);
      setTimeout(() => { if (editor === session) input.focus(); }, 0); return;
    }
    editor = null; input.remove(); label.hidden = false; element.classList.remove('editing');
    if (isNew) element.remove(); else if (context.scope !== 'desktop') element.draggable = true;
    if (session.needsRefresh || isNew) { if (context.scope === 'desktop') renderIcons(); else { const win = getWindow(context.scope); if (win) renderWindow(win); } }
    if (!commit || (original && name === original.name)) return;
    if (original?.kind === 'command') {
      host.postMessage({ type: 'renameCommandShortcut', id: original.id, label: name }); return;
    }
    sendOperation({ operation, parent: context.parent, name, ...(original ? { paths: [original.path] } : {}) });
  }
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('pointerdown', event => event.stopPropagation());
  input.addEventListener('dblclick', event => event.stopPropagation());
  input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); input.title = ''; });
  input.addEventListener('blur', () => finish(true));
  element.scrollIntoView({ block: 'nearest', inline: 'nearest' }); input.focus();
  const dot = item.type === 'folder' ? -1 : input.value.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
}
function performAction(action, context) {
  const selected = selectedItems(context.scope), paths = selectedFilePaths(context.scope);
  if (action === 'open') selected.forEach(item => openItem(item, context.scope));
  else if (action === 'workbench' || action === 'vim') selected.forEach(item => openItem(item, context.scope, action));
  else if (action === 'new-file' || action === 'new-folder' || action === 'rename') beginNameEditor(action, context);
  else if (action === 'copy' || action === 'cut') {
    if (!paths.length) return;
    state.clipboard = { mode: action === 'copy' ? 'copy' : 'move', paths }; save(); notify(`已${action === 'copy' ? '复制' : '剪切'} ${paths.length} 项`);
    showInterfaceAction(action === 'copy' ? '复制到剪贴板，粘贴时执行文件复制' : '加入剪切列表，粘贴时执行文件移动');
  } else if (action === 'paste' && state.clipboard?.paths?.length) sendOperation({ operation: 'paste', parent: context.parent, clipboard: { ...state.clipboard } });
  else if (action === 'delete') {
    const commands = new Set(selected.filter(item => item.kind === 'command').map(item => item.id));
    for (const id of commands) host.postMessage({ type: 'deleteCommandShortcut', id });
    if (paths.length) sendOperation({ operation: 'delete', parent: context.parent, paths });
  } else if (action === 'shortcut' && paths.length) sendOperation({ operation: 'shortcut', parent: rootPath, paths });
  else if (action === 'download') paths.forEach(startDownload);
  else if (action === 'terminal') openTerminal(context.parent);
  else if (action === 'refresh') { if (context.scope === 'desktop') refreshAll(); else refreshDirectory(context.parent); }
  else if (action === 'arrange') arrange();
}
function sendOperation(operation) {
  if (!remoteMode) { notify('请先连接 SSH'); return; }
  const requestId = `operation-${nextRequest++}`;
  pendingOperations.set(requestId, operation);
  host.postMessage({ type: 'fileOperation', ...operation, requestId });
  notify('正在执行文件操作…');
}
function refreshAfterOperation(operation, affectedPaths) {
  const paths = new Set(Array.isArray(affectedPaths) ? affectedPaths.filter(path => typeof path === 'string') : []);
  if (operation) {
    if (operation.parent) paths.add(operation.parent);
    for (const path of operation.paths || operation.clipboard?.paths || []) paths.add(parentOf(path));
    if (operation.operation === 'rename' && operation.paths?.length === 1) {
      const oldPath = operation.paths[0], newPath = joinPath(operation.parent, operation.name);
      for (const win of state.windows) if (!win.kind && (win.folder === oldPath || win.folder.startsWith(`${oldPath}/`))) {
        win.folder = newPath + win.folder.slice(oldPath.length); paths.add(win.folder); renderWindow(win);
      }
      renderDock();
    }
  }
  if (!paths.size) paths.add(rootPath);
  paths.forEach(path => requestDirectory(path));
  save(); notify('文件操作已完成，正在更新目录…');
}
function restoreWindows() {
  if (previous.rootPath !== rootPath || !Array.isArray(previous.windows) || state.windows.length) return;
  for (const record of previous.windows) {
    if (!record || record.kind || typeof record.folder !== 'string' || !record.folder.startsWith('/')) continue;
    const win = createWindow(record.folder, { ...record, history: Array.isArray(record.history) ? record.history : [], forward: Array.isArray(record.forward) ? record.forward : [], viewMode: state.viewMode });
    if (remoteMode && win.folder !== rootPath) requestDirectory(win.folder);
  }
  const active = state.windows.find(win => win.id === previous.activeWindow && !win.minimized) || state.windows.find(win => !win.minimized);
  if (active) focusWindow(active.id);
}
function receiveHostMessage(message) { if (!message || typeof message.type !== 'string') return;
  if (message.type === 'fullscreenResult') {
    clearTimeout(fullscreenTimer); $('fullscreen').disabled = false;
    notify(message.message || (message.ok ? '已切换全屏视图；F11 或顶栏图标退出' : '全屏请求失败'));
    scheduleLayout(); return;
  }
  if (message.type === 'configSaved' && settingsRequest && settingsRequest.requestId === message.requestId) {
    clearTimeout(settingsTimer);
    const request = settingsRequest; settingsRequest = null; settingsBusy(false);
    if (message.ok) { applyDesktopSettings(request.config); closeSettings(); }
    else {
      pendingConfig = { ...request.pendingPatch, ...pendingConfig };
      $('settingsError').textContent = `${request.switched ? '桌面位置已更新；外观保存失败：' : ''}${message.error || '保存失败，请重试'}`;
    }
    return;
  }
  if (message.type === 'serverInfo') { receiveServerInfo(message); return; }
  if (message.type === 'operationCommand') {
    if (typeof message.command === 'string') showOperationCommand(message.command, message.status, typeof message.detail === 'string' ? message.detail : '');
    return;
  }
  if (['terminalOpened', 'terminalData', 'terminalExit', 'terminalError', 'terminalClosed'].includes(message.type)) { handleTerminalMessage(message); return; }
  if (message.type === 'fileAccessError') {
    const win = getWindow(message.id);
    if (!remoteMode || !win) return;
    windowAction('close-confirmed', win);
    showFileAccessDialog({ path: message.path || win.folder }, false, accessError(message.error)); return;
  }
  if (message.type === 'remoteState') {
    if (message.status === 'local') return;
    if (message.status === 'ready' && Array.isArray(message.entries)) {
      const path = message.rootPath || message.folder;
      if (typeof path !== 'string') return;
      const initial = !initialized || !remoteMode || path !== rootPath;
      if (initial) {
        clearTimeout(settingsTimer); settingsRequest = null; settingsBusy(false); closeSettings(true);
        if (editor) editor.cancel();
        clearWindowViews(true);
        directories = Object.create(null); directoryRequests.clear(); latestDirectoryRequests.clear();
        state.activeWindow = null; selection = { scope: 'desktop', keys: new Set() }; state.clipboard = null;
      }
      remoteMode = true; desktopAvailable = true; desktopAccessError = ''; initialized = true; rootPath = path;
      homePath = typeof message.homePath === 'string' && message.homePath.startsWith('/') ? message.homePath : null;
      updateBuiltinShortcuts();
      setDirectory(rootPath, message.entries); applyConfig(message.config, initial);
      connectionStatus = 'SSH · 已连接'; renderServerInfo(); $('desktopPath').textContent = rootPath;
      if (initial) restoreWindows();
      renderIcons(); state.windows.forEach(renderWindow); renderDock(); save(); notify(`已刷新 ${rootPath}`);
    } else if (['missing', 'error', 'disconnected'].includes(message.status)) {
      clearRemoteDesktop(message.status !== 'disconnected');
      if (message.status !== 'disconnected') {
        const remoteHome = message.homePath || message.home;
        homePath = typeof remoteHome === 'string' && remoteHome.startsWith('/') ? remoteHome : null;
        if (homePath) { remoteMode = true; initialized = true; rootPath = homePath; rebuildItems(); }
        updateBuiltinShortcuts(); settingsBusy(false);
      }
      if (message.status === 'missing') {
        $('missingDesktopText').textContent = '主目录：' + (homePath || '未知') + '。暂不创建时仍可通过任务栏 Home 浏览主目录。';
        if (!$('missingDesktopDialog').open) $('missingDesktopDialog').showModal();
      } else if (message.status === 'error' && remoteMode) {
        desktopAccessError = message.message || '远程桌面不可用，请选择其他有访问权限的目录。';
        $('desktopPath').textContent = '桌面不可用，请在设置中选择其他位置';
        if ($('settingsDialog').open) $('settingsError').textContent = desktopAccessError;
      }
      connectionStatus = message.status === 'missing' ? 'SSH · 尚未创建桌面' : message.status === 'disconnected' ? 'SSH · 已断开' : remoteMode ? 'SSH · 已连接，桌面不可用' : 'SSH · 读取失败'; renderServerInfo();
      notify(message.message || (message.status === 'missing' ? '远程桌面尚未创建' : 'SSH 连接不可用，请重新连接。'));
    }
  } else if (message.type === 'remoteDirectory' || message.type === 'remoteFolder') {
    if (!remoteMode) return;
    if (typeof message.path !== 'string') return;
    const request = message.requestId ? directoryRequests.get(message.requestId) : null;
    if (message.requestId && (!request || request.path !== message.path)) return;
    if (message.requestId) directoryRequests.delete(message.requestId);
    const navigatingWindow = request?.windowId ? getWindow(request.windowId) : null;
    if (request?.windowId && (!navigatingWindow || navigatingWindow.pendingNavigation?.requestId !== message.requestId)) return;
    const latest = !message.requestId || latestDirectoryRequests.get(message.path) === message.requestId;
    if ((latest || navigatingWindow) && typeof message.operationCommand?.command === 'string') {
      const command = message.operationCommand;
      showOperationCommand(command.command, command.status, typeof command.detail === 'string' ? command.detail : '');
    }
    if (Array.isArray(message.entries)) {
      const resolvedPath = typeof message.resolvedPath === 'string' && message.resolvedPath.startsWith('/') ? message.resolvedPath : message.path;
      if (latest || !Object.hasOwn(directories, resolvedPath)) setDirectory(resolvedPath, message.entries);
      if (message.path === rootPath && resolvedPath !== rootPath) setDirectory(rootPath, message.entries);
      if (navigatingWindow) commitNavigation(navigatingWindow, resolvedPath, request.mode);
      if (latest) {
        if (message.path === rootPath) renderIcons();
        for (const win of state.windows) if (!win.kind && win.folder === resolvedPath && !win.pendingNavigation) { win.error = null; renderWindow(win); }
      }
      if (latest || navigatingWindow) notify(`已${navigatingWindow ? '打开' : '刷新'} ${resolvedPath}`);
    } else if (message.error) {
      if (navigatingWindow) {
        navigatingWindow.pendingNavigation = null; navigatingWindow.error = `${message.accessDenied ? accessError(message.error) : message.error}\n请求目录：${message.path}`;
        const address = windowElements.get(navigatingWindow.id)?.querySelector('.window-path');
        address?.setAttribute('aria-invalid', 'true'); if (address) { address.value = navigatingWindow.folder; address.removeAttribute('data-dirty'); address.title = message.error; }
        updateWindowStatus(navigatingWindow);
      } else if (latest) for (const win of state.windows) if (!win.kind && win.folder === message.path && !win.pendingNavigation) { win.error = message.error; renderWindow(win); }
      if (latest || navigatingWindow) notify(message.accessDenied ? `无访问权限：${message.error}` : message.error);
    }
  } else if (message.type === 'operationResult') {
    const operation = pendingOperations.get(message.requestId); pendingOperations.delete(message.requestId);
    if (message.success === true || message.ok === true) {
      if (operation?.clipboard?.mode === 'move') state.clipboard = null;
      selection.keys.clear(); syncSelection(); refreshAfterOperation(operation, message.affectedPaths || message.refreshPaths);
    } else notify(message.cancelled ? '已取消文件操作' : message.error || '文件操作未完成');
  } else if (message.type === 'configUpdated') {
    applyConfig(message.config); renderIcons(); state.windows.forEach(renderWindow); notify('桌面配置已更新');
  } else if (message.type === 'commandShortcutCreated' && isCommandShortcut(message.shortcut)) {
    const shortcut = { ...message.shortcut, kind: 'command', id: message.shortcut.id || `command-${Date.now()}` };
    state.shortcuts = [...state.shortcuts.filter(existing => existing.id !== shortcut.id), shortcut];
    rebuildItems(); renderIcons(); persistConfig({ shortcuts: state.shortcuts });
  } else if ((message.type === 'configSaved' || message.type === 'desktopError') && message.error) notify(message.error);
}
api.onMessage(receiveHostMessage);
$('context').addEventListener('click', event => {
  const button = event.target.closest('button[data-action]'); if (!button || button.disabled) return;
  $('context').hidden = true; performAction(button.dataset.action, menuContext);
});
$('icons').addEventListener('contextmenu', event => {
  if (event.target.closest('.icon')) return;
  selection = { scope: 'desktop', keys: new Set() }; syncSelection(); showMenu(event, contextFor('desktop'));
});
$('unpinApp').addEventListener('click', () => { if (appContextId) host.postMessage({ type: 'unpinApp', id: appContextId }); $('appContext').hidden = true; });
$('togglePinApp').addEventListener('click', () => { const win = getWindow(appContextWindowId); if (win?.kind === 'terminal') windowAction('pin', win); $('appContext').hidden = true; });
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('#context')) $('context').hidden = true;
  if (!event.target.closest('#appContext')) $('appContext').hidden = true;
});
// Capture before xterm, reserving
// Ubuntu's terminal shortcut without sending Ctrl+Alt+T bytes to a TUI.
document.addEventListener('keydown', event => {
  if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey || event.getModifierState('AltGraph') || (event.code !== 'KeyT' && event.key.toLowerCase() !== 't')) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.repeat || event.isComposing || !initialized || document.querySelector('dialog:modal')) return;
  const focusedWindow = getWindow(event.target.closest('.window[data-window-id]')?.dataset.windowId);
  if (focusedWindow?.kind === 'settings') return;
  const selectedWindow = getWindow(selection.scope);
  openTerminal(focusedWindow?.folder || selectedWindow?.folder || rootPath);
}, true);
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog:modal')) return;
  if (event.target.closest('input, textarea, .terminal-window, .browser-window, .settings-dialog, [contenteditable="true"]')) return;
  const context = contextFor(selection.scope), selected = selectedItems();
  let action;
  if (event.key === 'Escape') { $('context').hidden = true; $('appContext').hidden = true; return; }
  if (event.key === 'F5') { event.preventDefault(); refreshAll(); return; }
  if (event.key === 'F2') action = 'rename';
  else if (event.key === 'Delete') action = 'delete';
  else if (event.key === 'Enter' && selected.length) action = 'open';
  else if (event.ctrlKey || event.metaKey) {
    const key = event.key.toLowerCase();
    if (key === 'a') {
      const surface = getSurface(selection.scope); if (!surface) return;
      event.preventDefault(); selection.keys = new Set([...surface.querySelectorAll('.icon, .entry')].map(element => element.dataset.key)); syncSelection(); return;
    }
    action = { c: 'copy', x: 'cut', v: 'paste' }[key];
  }
  if (action) { event.preventDefault(); performAction(action, context); }
});
$('desktopSettings').addEventListener('click', openSettings);
$('homeShortcut').replaceChildren(toolIcon('House'));
$('homeShortcut').addEventListener('click', openHome);
$('activityButton').replaceChildren(toolIcon('Activity'));
$('activityButton').addEventListener('click', () => openActivityWindow());
$('openActivityToast').addEventListener('click', () => openActivityWindow(activity.toastSession));
$('closeActivityToast').addEventListener('click', () => { $('activityToast').hidden = true; scheduleBrowserLayout(); });
for (const button of $('settingsDialog').querySelectorAll('[data-settings-tab]')) {
  button.addEventListener('click', () => setSettingsTab(button.dataset.settingsTab));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? $('desktopSettingsTab') : event.key === 'End' ? $('systemSettingsTab') : button.id === 'desktopSettingsTab' ? $('systemSettingsTab') : $('desktopSettingsTab');
    setSettingsTab(next.dataset.settingsTab); next.focus();
  });
}
$('refreshSystemInfo').addEventListener('click', loadSystemInfo);
$('settingsConnection').addEventListener('click', () => { closeSettings(); if (!$('settingsDialog').open && !$('connectionDialog').open) $('connectionDialog').showModal(); });
$('settingsForm').addEventListener('submit', submitSettings);
$('browseDesktopPath').addEventListener('click', openDirectoryPicker);
$('desktopPickerForm').addEventListener('submit', event => {
  event.preventDefault(); if (!directoryPicker) return;
  try { loadPickerDirectory(resolveDirectoryAddress($('desktopPickerPath').value, directoryPicker.path || '/')); }
  catch (error) { $('desktopPickerError').textContent = error.message; }
});
$('desktopPickerUp').addEventListener('click', () => { if (directoryPicker?.path) loadPickerDirectory(parentOf(directoryPicker.path)); });
$('desktopPickerCancel').addEventListener('click', closeDirectoryPicker);
$('desktopPickerDialog').addEventListener('cancel', event => { event.preventDefault(); closeDirectoryPicker(); });
$('desktopPickerSelect').addEventListener('click', () => {
  if (!directoryPicker?.path) return;
  $('settingsDesktopPath').value = directoryPicker.path; closeDirectoryPicker();
});
$('fileAccessCancel').addEventListener('click', () => { fileAccessChoice = null; $('fileAccessDialog').close(); });
$('fileAccessDialog').addEventListener('cancel', () => { fileAccessChoice = null; });
$('fileAccessReadOnly').addEventListener('click', () => {
  const choice = fileAccessChoice; fileAccessChoice = null; $('fileAccessDialog').close();
  if (choice && remoteMode && choice.generation === connectionGeneration) void openDocument(choice.item, choice.mode, true);
});
$('extensionSettingsForm').addEventListener('submit', submitExtensionSettings);
$('reloadExtensionSettings').addEventListener('click', loadExtensionSettings);
$('cancelSettings').addEventListener('click', closeSettings);
$('settingsDialog').addEventListener('cancel', event => { event.preventDefault(); closeSettings(); });
$('fullscreen').addEventListener('click', requestFullscreen);
for (const [id, name] of Object.entries({ desktopSettings: 'Settings', fullscreen: 'Maximize' })) {
  const button = $(id), label = button.querySelector('span:first-child');
  if (label) label.replaceChildren(toolIcon(name)); else button.replaceChildren(toolIcon(name));
}
bindMarquee($('icons'), 'desktop'); bindDropSurface($('icons')); bindDropSurface($('windowTabs'));
let layoutFrame;
function scheduleLayout() {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => {
    if (document.hidden || !$('desktop').clientWidth || !$('desktop').clientHeight) return;
    renderIcons(); state.windows.forEach(positionWindow);
  });
}
new ResizeObserver(scheduleLayout).observe($('desktop'));
window.addEventListener('resize', scheduleLayout);
document.addEventListener('visibilitychange', () => { scheduleBrowserLayout(); if (!document.hidden) scheduleLayout(); });
new MutationObserver(scheduleBrowserLayout).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open', 'hidden'] });
setInterval(updateClock, 1000);
setInterval(() => host.postMessage({ type: 'getServerInfo' }), 30000);

const images = new Map();
const downloadTasks = new Map();
let connecting = false;
function clearWindowViews(preserveTerminals = false) {
  finishServerPicker(null);
  if (!preserveTerminals) for (const id of [...terminals.keys()]) disposeTerminal(id);
  for (const record of images.values()) record.observer?.disconnect(); images.clear();
  for (const win of state.windows) {
    if (win.kind === 'settings' || win.kind === 'activity') continue;
    if (preserveTerminals && win.kind === 'terminal') continue;
    if (win.kind === 'browser') void api.closeBrowser?.(win.browserId).catch(error => notify(error.message));
    windowElements.get(win.id)?.remove(); windowElements.delete(win.id);
  }
  state.windows = state.windows.filter(win => win.kind === 'settings' || win.kind === 'activity' || (preserveTerminals && win.kind === 'terminal'));
}
function clearRemoteDesktop(preserveTerminals = false) {
  connectionGeneration++; fileAccessRequests.clear(); fileAccessChoice = null;
  closeDirectoryPicker(); $('fileAccessDialog').close();
  finishServerPicker(null);
  clearTimeout(saveTimer); clearTimeout(settingsTimer); pendingConfig = {}; settingsRequest = null;
  if (editor) editor.cancel();
  clearWindowViews(preserveTerminals);
  directories = Object.create(null); directoryRequests.clear(); latestDirectoryRequests.clear(); pendingOperations.clear();
  state.shortcuts = []; state.pinnedApps = []; state.positions = {}; state.activeWindow = null; state.clipboard = null;
  selection = { scope: 'desktop', keys: new Set() };
  remoteMode = false; desktopAvailable = false; desktopAccessError = ''; initialized = false; rootPath = '/'; homePath = null; serverInfo = null; serverClockAnchor = null;
  resetSystemInfo(); updateBuiltinShortcuts(); settingsBusy(false);
  connectionStatus = 'SSH · 未连接'; $('desktopPath').textContent = '连接 SSH 后打开远程桌面';
  rebuildItems(); renderIcons(); renderDock(); renderPinnedApps(); renderServerInfo();
  $('context').hidden = true; $('appContext').hidden = true;
}
async function initializeConnection() {
  $('connectButton').replaceChildren(toolIcon('Plug'));
  $('downloadsButton').replaceChildren(toolIcon('Download'));
  $('browserButton').replaceChildren(toolIcon('Globe'));
  $('browserButton').addEventListener('click', openServerBrowser);
  $('connectButton').addEventListener('click', () => { if (!$('connectionDialog').open) $('connectionDialog').showModal(); });
  $('closeConnection').addEventListener('click', () => $('connectionDialog').close());
  $('connectionForm').addEventListener('submit', async event => {
    event.preventDefault(); if (connecting) return;
    connecting = true; $('connectSubmit').disabled = true; $('connectSubmit').textContent = '正在连接…'; $('connectionError').textContent = '';
    const input = { host: $('sshHost').value.trim(), port: Number($('sshPort').value), username: $('sshUsername').value.trim() };
    if ($('sshPassword').value) input.password = $('sshPassword').value;
    if ($('sshPrivateKey').value) input.privateKeyPath = $('sshPrivateKey').value;
    if ($('sshPassphrase').value) input.passphrase = $('sshPassphrase').value;
    try { const result = await api.connect(input); if (result?.cancelled) { $('connectionError').textContent = '已取消切换连接，当前终端已保留。'; return; } $('connectionDialog').close(); $('connectionHint').textContent = '已连接 ' + (result.username || input.username) + '@' + (result.host || input.host); }
    catch(error) { $('connectionError').textContent = error.message || String(error); notify('连接失败：' + (error.message || error)); }
    finally { $('sshPassword').value = ''; $('sshPassphrase').value = ''; connecting = false; $('connectSubmit').disabled = false; $('connectSubmit').textContent = '连接'; }
  });
  $('chooseKey').addEventListener('click', async () => { try { const value = await api.choosePrivateKey(); if (value) $('sshPrivateKey').value = value; } catch(error) { $('connectionError').textContent = error.message; } });
  $('clearKey').addEventListener('click', () => { $('sshPrivateKey').value = ''; $('sshPassphrase').value = ''; });
  $('disconnectButton').addEventListener('click', async () => {
    try { if (await api.disconnect() === false) { $('connectionError').textContent = '已取消断开，当前终端已保留。'; return; } clearRemoteDesktop(); notify('已断开 SSH'); }
    catch(error) { $('connectionError').textContent = error.message; }
  });
  $('skipDesktop').addEventListener('click', () => $('missingDesktopDialog').close());
  $('createDesktop').addEventListener('click', () => { $('missingDesktopDialog').close(); host.postMessage({ type: 'createDesktop' }); });
  $('downloadsButton').addEventListener('click', () => { $('downloadsPanel').hidden = !$('downloadsPanel').hidden; if (!$('transferRemotePath').value) $('transferRemotePath').value = contextFor(selection.scope).parent; api.listTransfers?.().then(tasks => tasks.forEach(updateDownload)).catch(error => notify(error.message)); });
  $('closeDownloads').addEventListener('click', () => { $('downloadsPanel').hidden = true; });
  api.onDownloadProgress(updateDownload);
  document.addEventListener('keydown', event => {
    if (event.key === 'F11' || (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'f')) { event.preventDefault(); requestFullscreen(); }
  }, true);
  clearRemoteDesktop(); $('connectionDialog').showModal();
  try { const saved = await api.getSettings(); extensionSettings = { ...extensionSettings, ...saved }; $('sshHost').value = saved.host || ''; $('sshUsername').value = saved.username || ''; $('sshPort').value = saved.port || 22; $('sshPrivateKey').value = saved.privateKeyPath || ''; }
  catch(error) { $('connectionError').textContent = '应用设置读取失败：' + error.message; }
}
function updateDownload(value) {
  if (!value || typeof value.id !== 'string') return;
  if (!downloadTasks.has(value.id)) createTransferRow(value.id, value.source || value.name || value.path || value.id, value.direction || 'download');
  const task = downloadTasks.get(value.id);
  Object.assign(task, value);
  const row = task.element;
  row.querySelector('.download-status').textContent = task.status === 'complete' ? '已完成 · ' + (task.path || '') : task.status === 'cancelled' ? '已取消' : task.status === 'error' ? task.error || '下载失败' : (task.method ? task.method.toUpperCase() + ' · ' : '') + (task.total > 0 ? Math.min(100, Math.round(task.done / task.total * 100)) + '%' : '准备中…');
  const progress = row.querySelector('progress');
  if (task.total > 0) { progress.max = task.total; progress.value = Math.max(0, task.done || 0); } else progress.removeAttribute('value');
  row.querySelector('button').disabled = ['complete','cancelled','error'].includes(task.status);
}
function createTransferRow(id, remotePath, direction = 'download') {
  if (downloadTasks.has(id)) return;
  const row = document.createElement('section'); row.className = 'download-item'; row.dataset.downloadId = id;
  const title = document.createElement('strong'); title.textContent = `${direction === 'upload' ? '↑ 上传' : '↓ 下载'} · ${basename(direction === 'upload' ? remotePath.replace(/\\/g, '/') : remotePath)}`; title.title = remotePath;
  const status = document.createElement('p'); status.className = 'download-status'; status.textContent = '准备中…'; status.setAttribute('role','status');
  const progress = document.createElement('progress'); progress.setAttribute('aria-label', basename(remotePath) + ' 下载进度');
  const cancel = document.createElement('button'); cancel.textContent = '取消'; cancel.addEventListener('click', async () => { cancel.disabled = true; status.textContent = '正在取消…'; try { await api.cancelDownload(id); } catch(error) { status.textContent = error.message; cancel.disabled = false; } });
  row.append(title, status, progress, cancel); $('downloadItems').append(row); $('downloadsPanel').hidden = false; $('downloadsEmpty').hidden = true;
  downloadTasks.set(id, { id, remotePath, direction, status:'running', element:row });
}
async function startDownload(remotePath) {
  if (!remoteMode) { notify('请先连接 SSH'); return; }
  const id = 'download-' + Date.now() + '-' + nextRequest++;
  createTransferRow(id, remotePath);
  try { const result = await api.download(remotePath, id, transferDestination); updateDownload({ ...result, id, status: 'complete' }); notify('下载完成：' + (result.path || basename(remotePath))); }
  catch(error) { const cancelled = error.code === 'ABORT_ERR' || /取消|cancel|abort/i.test(error.message || ''); updateDownload({ id, status: cancelled ? 'cancelled' : 'error', error: error.message }); }
}
async function startUpload(kind) {
  if (!remoteMode) { $('transferError').textContent = '请先连接 SSH'; return; }
  try {
    const target = resolveDirectoryAddress($('transferRemotePath').value, rootPath);
    const files = await api.chooseUpload(kind);
    for (const localPath of files) {
      const id = 'upload-' + Date.now() + '-' + nextRequest++;
      createTransferRow(id, localPath, 'upload');
      void api.upload(localPath, target, id).then(result => { updateDownload({ ...result, id, status:'complete' }); refreshDirectory(target); }, error => updateDownload({ id, status:/取消|cancel|abort/i.test(error.message) ? 'cancelled' : 'error', error:error.message }));
    }
  } catch(error) { $('transferError').textContent = error.message; }
}
function setServerPickerPath(value) {
  if (!transferPicker) return;
  transferPicker.path = value;
  const input = windowElements.get(transferPicker.windowId)?.querySelector('.window-picker-path');
  if (input) input.value = value;
}
function finishServerPicker(value, closingWindow = false) {
  const picker = transferPicker; if (!picker) return;
  transferPicker = null;
  const win = getWindow(picker.windowId), element = windowElements.get(picker.windowId);
  if (element) {
    element.classList.remove('server-picker-window');
    element.querySelector('.window-picker-bar').hidden = true;
  }
  if (win && !closingWindow) {
    if (picker.owned) void windowAction('close-confirmed', win);
    else renderWindow(win);
  }
  picker.resolve(value);
}
function chooseServerPath({ initialPath = rootPath, title = '选择服务器项目', directoryOnly = false } = {}) {
  if (!remoteMode) { notify('请先连接 SSH'); return Promise.resolve(null); }
  if (transferPicker) { focusWindow(transferPicker.windowId); return transferPicker.promise; }
  let target;
  try { target = resolveDirectoryAddress(initialPath || rootPath, rootPath); }
  catch (error) { notify(error.message); target = rootPath; }
  const known = items.get(target);
  const directory = known && known.type !== 'folder' ? parentOf(target) : target;
  const existing = state.windows.find(win => !win.kind && win.folder === directory);
  const win = existing || createWindow(rootPath);
  let resolve; const promise = new Promise(done => { resolve = done; });
  transferPicker = { windowId: win.id, title, directoryOnly, path: target, initialSelection: !existing && target !== directory ? target : null, owned: !existing, generation: connectionGeneration, request: 0, resolve, promise };
  const element = windowElements.get(win.id);
  element.classList.add('server-picker-window');
  element.querySelector('.window-picker-bar').hidden = false;
  element.querySelector('.window-picker-select').textContent = directoryOnly ? '选择目录' : '选择项目';
  element.querySelector('.window-picker-select').disabled = false;
  element.querySelector('.window-picker-path').value = target;
  $('downloadsPanel').hidden = true;
  $('context').hidden = true;
  focusWindow(win.id); renderWindow(win);
  if (!existing) navigateWindow(win, directory, 'initial');
  return promise;
}
async function confirmServerPicker() {
  const picker = transferPicker; if (!picker || picker.busy) return;
  const win = getWindow(picker.windowId), element = windowElements.get(picker.windowId);
  if (!win || !element) return;
  picker.busy = true;
  const request = ++picker.request;
  element.querySelector('.window-picker-select').disabled = true;
  const entered = element.querySelector('.window-picker-path').value;
  try {
    const target = resolveDirectoryAddress(entered, win.folder);
    let directoryError;
    try { await withTimeout(api.list(target), '目录读取超时，请重试。'); }
    catch (error) {
      directoryError = error;
      if (picker.directoryOnly) throw error;
      try {
        const access = await withTimeout(api.checkFileAccess(target), '文件权限检查超时，请重试。');
        if (!access?.readable) throw new Error(access?.error || '无访问权限：当前账号不能读取此文件。');
      } catch (fileError) { throw /不是普通文件|not a regular file/i.test(fileError.message) ? directoryError : fileError; }
    }
    if (transferPicker !== picker || picker.request !== request || picker.generation !== connectionGeneration || !remoteMode || element.querySelector('.window-picker-path').value !== entered) return;
    finishServerPicker(target);
  } catch (error) {
    if (transferPicker !== picker || picker.request !== request || picker.generation !== connectionGeneration) return;
    win.error = accessError(error); updateWindowStatus(win); notify(win.error);
  } finally {
    if (transferPicker === picker) { picker.busy = false; element.querySelector('.window-picker-select').disabled = false; }
  }
}
$('transferBrowse').addEventListener('click', async () => {
  const selected = await chooseServerPath({ initialPath: $('transferRemotePath').value });
  if (selected) { $('transferRemotePath').value = selected; $('transferError').textContent = ''; }
  if (remoteMode) $('downloadsPanel').hidden = false;
});
$('transferUploadFiles').addEventListener('click', () => startUpload('files'));
$('transferUploadFolder').addEventListener('click', () => startUpload('directory'));
$('transferDownload').addEventListener('click', () => { try { void startDownload(resolveDirectoryAddress($('transferRemotePath').value, rootPath)); } catch(error) { $('transferError').textContent = error.message; } });
$('transferChooseDestination').addEventListener('click', async () => { try { const value = await api.chooseDownloadDirectory(); if(value) { transferDestination = value; $('transferDestination').textContent = value; } } catch(error) { $('transferError').textContent = error.message; } });
function imageTransform(win) {
  const record = images.get(win.id); if (!record) return;
  record.image.style.transform = 'translate(' + record.x + 'px,' + record.y + 'px) scale(' + record.scale + ')';
  record.element.querySelector('.image-scale').textContent = Math.round(record.scale * 100) + '%';
  record.element.dataset.imageScale = String(record.scale); record.element.dataset.imageX = String(record.x); record.element.dataset.imageY = String(record.y);
}
function fitImage(win) {
  const r = images.get(win.id); if (!r?.image.naturalWidth || !r.viewport.clientWidth || !r.viewport.clientHeight) return;
  r.scale = Math.min(1, r.viewport.clientWidth / r.image.naturalWidth, r.viewport.clientHeight / r.image.naturalHeight);
  r.x = (r.viewport.clientWidth - r.image.naturalWidth * r.scale) / 2; r.y = (r.viewport.clientHeight - r.image.naturalHeight * r.scale) / 2; r.fit = true; imageTransform(win);
}
function resizeImage(win) { const r = images.get(win.id); if (r?.fit) fitImage(win); }
function zoomImage(win, scale, x, y) {
  const r = images.get(win.id); if (!r?.image.naturalWidth) return;
  const next = Math.min(32, Math.max(0.02, scale));
  const anchorX = (x - r.x) / r.scale, anchorY = (y - r.y) / r.scale;
  r.x = x - anchorX * next; r.y = y - anchorY * next; r.scale = next; r.fit = false; imageTransform(win);
}
async function openImage(item) {
  const offset = state.windows.length * 28;
  const win = { id:'image-' + nextWindow++, kind:'image', folder:parentOf(item.path), imageName:item.name, path:item.path, minimized:false, maximized:false, position:{x:30+offset,y:40+offset}, size:{width:780,height:560},z:++nextLayer };
  const element = $('imageTemplate').content.firstElementChild.cloneNode(true); element.dataset.windowId = win.id;
  element.querySelector('.window-title').textContent = item.name; element.setAttribute('aria-label','图片查看器 ' + item.name);
  state.windows.push(win); windowElements.set(win.id,element); $('windows').append(element);
  const viewport=element.querySelector('.image-viewport'), image=element.querySelector('img'); image.alt=item.name;
  const record={element,viewport,image,scale:1,x:0,y:0,fit:true}; images.set(win.id,record);
  element.addEventListener('pointerdown',()=>{if(state.activeWindow!==win.id)focusWindow(win.id);});
  element.addEventListener('click',event=>{
    const action=event.target.closest('[data-window-action]')?.dataset.windowAction;if(action){windowAction(action,win);return;}
    const actionImage=event.target.closest('[data-image-action]')?.dataset.imageAction;
    if(actionImage==='fit')fitImage(win);else if(actionImage)zoomImage(win,actionImage==='actual'?1:record.scale*(actionImage==='in'?1.25:0.8),viewport.clientWidth/2,viewport.clientHeight/2);
  });
  viewport.addEventListener('wheel',event=>{event.preventDefault();const box=viewport.getBoundingClientRect();zoomImage(win,record.scale*Math.exp(-event.deltaY*0.002),event.clientX-box.left,event.clientY-box.top);},{passive:false});
  viewport.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;event.preventDefault();viewport.setPointerCapture(event.pointerId);record.fit=false;
    const start={x:event.clientX,y:event.clientY,left:record.x,top:record.y};
    const move=next=>{record.x=start.left+next.clientX-start.x;record.y=start.top+next.clientY-start.y;imageTransform(win);};
    const end=()=>{viewport.removeEventListener('pointermove',move);viewport.removeEventListener('pointerup',end);viewport.removeEventListener('pointercancel',end);if(viewport.hasPointerCapture(event.pointerId))viewport.releasePointerCapture(event.pointerId);};
    viewport.addEventListener('pointermove',move);viewport.addEventListener('pointerup',end);viewport.addEventListener('pointercancel',end);
  });
  renderToolIcons(element);bindWindowDrag(win,element);bindWindowResize(win,element);positionWindow(win);focusWindow(win.id);
  record.observer=new ResizeObserver(()=>resizeImage(win));record.observer.observe(viewport);
  image.addEventListener('load',()=>{if(!images.has(win.id))return;fitImage(win);element.querySelector('.image-status').textContent=image.naturalWidth+' × '+image.naturalHeight+' · '+item.path;});
  image.addEventListener('error',()=>{element.querySelector('.image-status').textContent='图片无法解码，可右键下载原文件。';});
  try {const value=await api.image(item.path);if(!images.has(win.id))return;if(!/^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(value.mime)||typeof value.data!=='string')throw new Error('图片格式无效');image.src='data:'+value.mime+';base64,'+value.data;}
  catch(error){if(images.has(win.id))element.querySelector('.image-status').textContent='图片打开失败：'+error.message;}
}

initializeConnection();
host.postMessage({ type: 'ready' });
