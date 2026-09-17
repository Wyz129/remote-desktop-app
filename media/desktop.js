'use strict';
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const GRID = 112;
const DEMO_ROOT = '/home/demo';
const demoDirectories = {
  '/home/demo': [
    { name: 'projects', type: 'folder' }, { name: 'results', type: 'folder' }, { name: 'datasets', type: 'folder' },
    { name: 'README.md', type: 'file', size: '2 KB' }, { name: 'run.sh', type: 'file', size: '1 KB' },
    { name: 'job-042.odb', type: 'large', size: '2.4 GB' }
  ],
  '/home/demo/projects': [{ name: 'remote-file-manager', type: 'folder' }, { name: 'train.py', type: 'file', size: '18 KB' }],
  '/home/demo/projects/remote-file-manager': [{ name: 'plan.md', type: 'file', size: '3 KB' }],
  '/home/demo/results': [{ name: 'stress-strain.csv', type: 'file', size: '420 KB' }, { name: 'preview.png', type: 'file', size: '88 KB' }],
  '/home/demo/datasets': [{ name: 'training-set.zip', type: 'large', size: '8.1 GB' }]
};
const previous = vscode.getState() || {};
const state = {
  rootPath: previous.rootPath || DEMO_ROOT,
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
let rootPath = DEMO_ROOT;
let homePath = DEMO_ROOT;
let remoteMode = false;
let initialized = false;
let directories = Object.create(null);
const items = new Map();
const windowElements = new Map();
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
let fullscreenTimer;
let dragPayload = null;

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
  vscode.setState({ ...state, windows: state.windows.filter(win => win.kind !== 'terminal').map(({ pendingNavigation, error, ...win }) => win) });
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
  $('accountName').textContent = serverInfo?.username || (initialized ? '账号不可用' : '正在读取账号…');
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
  $('connection').textContent = remote && stale && connectionStatus.includes('已连接') ? 'Remote-SSH · 等待服务器响应' : connectionStatus;
  if (!serverClockAnchor || performance.now() - serverClockAnchor.receivedAt > 90000) {
    clock.textContent = `${remote ? '服务器' : '本地'}时间 —`;
    clock.removeAttribute('datetime');
    return;
  }
  const current = new Date(serverClockAnchor.epochMs + performance.now() - serverClockAnchor.receivedAt);
  clock.textContent = `${remote ? '' : '本地 '}${serverClockAnchor.formatter.format(current)}`;
  clock.dateTime = current.toISOString();
  clock.title = `${remote ? '服务器' : '本地'}时间 · ${serverInfo.timeZone}`;
  clock.setAttribute('aria-label', `${remote ? '服务器' : '本地'}时间 ${clock.textContent}`);
}
function receiveServerInfo(message) {
  serverInfo = message;
  lastServerResponseAt = performance.now();
  serverClockAnchor = null;
  if (message.available !== false && Number.isFinite(message.epochMs) && typeof message.timeZone === 'string') {
    try {
      serverClockAnchor = { epochMs: message.epochMs, receivedAt: performance.now(), formatter: new Intl.DateTimeFormat('zh-CN', { timeZone: message.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }) };
    } catch { /* An invalid server timezone must not fall back to the local timezone. */ }
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
  directories[path] = entries.map(entry => ({ ...entry, path: entry.path || joinPath(path, entry.name), remoteUri: entry.uri || entry.remoteUri }));
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
  if (!remoteMode) return;
  Object.assign(pendingConfig, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const config = pendingConfig;
    pendingConfig = {};
    vscode.postMessage({ type: 'saveDesktopConfig', config });
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
    for (const win of state.windows) if (win.kind !== 'terminal') win.viewMode = state.viewMode;
  }
  if (!Object.hasOwn(pendingConfig, 'positions')) {
    if (config.positions && typeof config.positions === 'object' && !Array.isArray(config.positions)) state.positions = { ...config.positions };
    else if (initial) state.positions = {};
  }
  if (!Object.hasOwn(pendingConfig, 'shortcuts')) {
    if (Array.isArray(config.shortcuts)) state.shortcuts = config.shortcuts.filter(isCommandShortcut).map((shortcut, index) => ({ ...shortcut, kind: 'command', id: shortcut.id || `command-${index}` }));
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
  for (const control of $('settingsForm').querySelectorAll('button, select, input')) control.disabled = busy;
  $('applySettings').textContent = busy ? '正在保存…' : '应用';
}
function closeSettings() {
  if (settingsRequest) return;
  $('settingsDialog').close(); $('desktopSettings').focus();
}
function openSettings() {
  if (!initialized) { notify('请等待桌面完成读取'); return; }
  $('context').hidden = true; $('appContext').hidden = true;
  $('settingsViewMode').value = state.viewMode;
  $('settingsWallpaper').value = state.wallpaper;
  $('settingsHidden').checked = state.showHiddenFiles;
  $('settingsError').textContent = '';
  $('settingsLocation').textContent = remoteMode ? '应用后保存到服务器桌面配置，并更新已打开的资源管理器。' : '应用后保存在当前 VS Code 桌面视图中。';
  settingsBusy(false); $('settingsDialog').showModal();
}
function applyDesktopSettings(config) {
  // Only this request's preference fields are applied. A config reply may also
  // contain older positions or shortcuts changed while the write was pending.
  state.viewMode = config.viewMode; state.wallpaper = config.wallpaper; state.showHiddenFiles = config.showHiddenFiles;
  $('desktop').dataset.wallpaper = state.wallpaper;
  for (const win of state.windows) if (win.kind !== 'terminal') win.viewMode = state.viewMode;
  selection.keys.clear(); renderIcons(); state.windows.forEach(renderWindow); save();
  showInterfaceAction('更新桌面设置'); notify(remoteMode ? '桌面设置已保存到服务器' : '桌面设置已保存');
}
function submitSettings(event) {
  event.preventDefault(); if (settingsRequest) return;
  const config = { viewMode: $('settingsViewMode').value, wallpaper: $('settingsWallpaper').value, showHiddenFiles: $('settingsHidden').checked };
  if (!remoteMode) { applyDesktopSettings(config); closeSettings(); return; }
  clearTimeout(saveTimer);
  const requestId = `settings-${nextRequest++}`;
  settingsRequest = { requestId, config, pendingPatch: pendingConfig };
  settingsBusy(true); $('settingsError').textContent = '';
  const patch = { ...pendingConfig, ...config }; pendingConfig = {};
  vscode.postMessage({ type: 'saveDesktopConfig', config: patch, requestId });
  settingsTimer = setTimeout(() => {
    if (settingsRequest?.requestId !== requestId) return;
    pendingConfig = { ...settingsRequest.pendingPatch, ...pendingConfig };
    settingsRequest = null; settingsBusy(false);
    $('settingsError').textContent = '未收到服务器确认，配置可能已保存。请刷新桌面后核对或重试。';
  }, 15000);
}
function requestFullscreen() {
  $('fullscreen').disabled = true;
  vscode.postMessage({ type: 'toggleFullscreen' });
  clearTimeout(fullscreenTimer);
  fullscreenTimer = setTimeout(() => { $('fullscreen').disabled = false; notify('未收到全屏请求确认，请检查 VS Code 通知'); }, 15000);
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
function openItem(item, scope = 'desktop') {
  if (!item) return;
  if (item.broken) { notify(`快捷方式目标不存在：${item.path}`); return; }
  if (item.kind === 'command') { vscode.postMessage({ type: 'executeCommand', command: item.command, ...(item.args !== undefined ? { args: item.args } : {}) }); return; }
  if (item.type === 'folder') { openFolder(item.path, scope === 'desktop' ? undefined : scope); return; }
  vscode.postMessage({ type: 'openResource', path: item.path, kind: 'file', ...(item.remoteUri ? { uri: item.remoteUri } : {}) });
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
  const entries = [...(directories[rootPath] || []), ...state.shortcuts.map(commandItem)].filter(visibleEntry);
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
function renderDock() {
  $('windowTabs').replaceChildren();
  for (const win of state.windows) {
    const tab = document.createElement('button');
    tab.className = `window-tab${win.id === state.activeWindow && !win.minimized ? ' active' : ''}${win.minimized ? ' minimized' : ''}`;
    const title = win.kind === 'terminal' ? `${PROGRAM_LABELS[win.program]} · ${win.folder}` : win.folder;
    tab.dataset.windowId = win.id; tab.title = `${title}${win.minimized ? '（已最小化）' : ''}`;
    tab.setAttribute('aria-label', `${win.minimized ? '恢复' : '切换到'} ${title}`);
    const label = document.createElement('span'); label.className = 'tab-label'; label.textContent = win.kind === 'terminal' ? PROGRAM_LABELS[win.program] : basename(win.folder);
    tab.append(win.kind === 'terminal' ? toolIcon('Terminal') : glyph({ type: 'folder', name: '' }), label);
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
    vscode.postMessage({ type: 'terminalResize', id: win.id, cols: record.cols, rows: record.rows });
  }
}
function openTerminal(path, program = 'shell') {
  if (!Object.hasOwn(PROGRAM_LABELS, program)) return;
  const offset = state.windows.length * 34;
  const win = { id: `terminal-${nextWindow++}`, kind: 'terminal', program, folder: path, minimized: false, maximized: false, position: { x: 24 + offset, y: 44 + offset }, size: { width: 740, height: 500 }, z: ++nextLayer };
  state.windows.push(win);
  const element = $('terminalTemplate').content.firstElementChild.cloneNode(true);
  element.dataset.windowId = win.id; element.dataset.program = program;
  element.setAttribute('aria-label', `${PROGRAM_LABELS[program]} 终端 ${path}`);
  element.querySelector('.window-title').textContent = `${PROGRAM_LABELS[program]} — ${basename(path)}`;
  element.querySelector('.terminal-location').textContent = path;
  element.querySelector('.terminal-location').title = path;
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
  // VS Code's command dispatch and desktop file shortcuts must not consume TUI keys.
  element.querySelector('.terminal-surface').addEventListener('keydown', event => event.stopPropagation());
  terminal.onData(data => { if (record.active && record.opened) vscode.postMessage({ type: 'terminalInput', id: win.id, data }); });
  record.observer = new ResizeObserver(() => fitTerminal(win)); record.observer.observe(element.querySelector('.terminal-surface'));
  fitTerminal(win);
  vscode.postMessage({ type: 'openTerminal', id: win.id, path, program, cols: terminal.cols, rows: terminal.rows });
  terminal.focus(); save();
}
function disposeTerminal(id, tellHost = true) {
  const record = terminals.get(id); if (!record) return;
  record.active = false; record.observer.disconnect(); record.terminal.dispose(); terminals.delete(id);
  if (tellHost) vscode.postMessage({ type: 'terminalClose', id });
}
function handleTerminalMessage(message) {
  const win = getWindow(message.id), record = terminals.get(message.id), element = windowElements.get(message.id);
  if (!win || !record || !element) return;
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
  bindMarquee(listing, win.id); bindDropSurface(element); bindWindowDrag(win, element); bindWindowResize(win, element);
  positionWindow(win); renderWindow(win); renderDock();
  return win;
}
function openFolder(path, windowId) {
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
  const address = windowElements.get(win.id)?.querySelector('.window-path');
  if (address) { delete address.dataset.dirty; address.value = path; address.removeAttribute('aria-invalid'); }
  renderWindow(win); renderDock(); save();
}
function navigateWindow(win, path, mode = 'navigate') {
  win.error = null;
  const address = windowElements.get(win.id)?.querySelector('.window-path');
  if (address) { address.value = path; address.dataset.dirty = 'true'; address.removeAttribute('aria-invalid'); address.title = path; }
  if (!remoteMode) {
    if (Object.hasOwn(directories, path)) { commitNavigation(win, path, mode); showOperationCommand(`cd -- ${shellQuote(path)} # 本地示例`); }
    else { win.error = `目录不存在：${path}`; address?.setAttribute('aria-invalid', 'true'); updateWindowStatus(win); notify(win.error); showOperationCommand(`cd -- ${shellQuote(path)} # 本地示例`, 'error', win.error); }
    return;
  }
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
  if (win.kind === 'terminal') return;
  const element = windowElements.get(win.id); if (!element) return;
  const count = directories[win.folder]?.filter(visibleEntry).length;
  const selected = selection.scope === win.id ? selection.keys.size : 0;
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
  if (win.kind === 'terminal') return;
  const element = windowElements.get(win.id); if (!element) return;
  element.querySelector('.window-title').textContent = basename(win.folder);
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
function windowAction(action, win) {
  if (action === 'close') {
    if (win.kind === 'terminal') disposeTerminal(win.id);
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
    vscode.postMessage(pinned ? { type: 'unpinApp', id: pinned.id } : { type: 'pinApp', app: { label: PROGRAM_LABELS[win.program], program: win.program } });
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
  vscode.postMessage({ type: 'readDirectory', path, requestId, ...(options.intent ? { intent: options.intent } : {}), ...(options.windowId ? { windowId: options.windowId } : {}) });
  return requestId;
}
function refreshAll() {
  if (remoteMode) {
    const paths = [...new Set([rootPath, ...state.windows.filter(win => win.kind !== 'terminal').map(win => win.folder)])];
    vscode.postMessage({ type: 'refreshRemote', paths, intent: 'refresh' }); notify('正在刷新…');
    paths.filter(path => path !== rootPath).forEach(path => requestDirectory(path));
  } else { renderIcons(); state.windows.forEach(renderWindow); notify('已刷新本地示例'); showOperationCommand(`ls -la -- ${shellQuote(rootPath)} # 本地示例`); }
}
function refreshDirectory(path) {
  if (remoteMode) {
    if (path === rootPath) vscode.postMessage({ type: 'refreshRemote', paths: [rootPath], intent: 'refresh' });
    else requestDirectory(path, { intent: 'refresh' });
    notify(`正在刷新 ${path}…`);
  } else { renderIcons(); state.windows.forEach(renderWindow); notify('已刷新本地示例'); showOperationCommand(`ls -la -- ${shellQuote(path)} # 本地示例`); }
}
function showMenu(event, context) {
  event.preventDefault(); event.stopPropagation();
  menuContext = context;
  $('appContext').hidden = true;
  if (context.scope !== 'desktop') focusWindow(context.scope);
  const selected = selectedItems(context.scope), files = selected.filter(item => item.kind !== 'command');
  const buttons = $('context');
  for (const action of ['open', 'copy', 'cut', 'delete']) buttons.querySelector(`[data-action="${action}"]`).disabled = !selected.length;
  buttons.querySelector('[data-action="rename"]').disabled = selected.length !== 1;
  buttons.querySelector('[data-action="shortcut"]').disabled = !files.length;
  buttons.querySelector('[data-action="copy"]').disabled = !files.length;
  buttons.querySelector('[data-action="cut"]').disabled = !files.length;
  buttons.querySelector('[data-action="paste"]').disabled = !state.clipboard?.paths?.length;
  buttons.querySelector('[data-action="arrange"]').hidden = context.scope !== 'desktop';
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
  const item = original || { name: operation === 'new-folder' ? nextName(context.parent, '新建文件夹') : nextName(context.parent, '新建文件', '.txt'), type: operation === 'new-folder' ? 'folder' : 'file' };
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
      vscode.postMessage({ type: 'renameCommandShortcut', id: original.id, label: name }); return;
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
  else if (action === 'new-file' || action === 'new-folder' || action === 'rename') beginNameEditor(action, context);
  else if (action === 'copy' || action === 'cut') {
    if (!paths.length) return;
    state.clipboard = { mode: action === 'copy' ? 'copy' : 'move', paths }; save(); notify(`已${action === 'copy' ? '复制' : '剪切'} ${paths.length} 项`);
    showInterfaceAction(action === 'copy' ? '复制到剪贴板，粘贴时执行文件复制' : '加入剪切列表，粘贴时执行文件移动');
  } else if (action === 'paste' && state.clipboard?.paths?.length) sendOperation({ operation: 'paste', parent: context.parent, clipboard: { ...state.clipboard } });
  else if (action === 'delete') {
    const commands = new Set(selected.filter(item => item.kind === 'command').map(item => item.id));
    for (const id of commands) vscode.postMessage({ type: 'deleteCommandShortcut', id });
    if (paths.length) sendOperation({ operation: 'delete', parent: context.parent, paths });
  } else if (action === 'shortcut' && paths.length) sendOperation({ operation: 'shortcut', parent: rootPath, paths });
  else if (action === 'command-shortcut') vscode.postMessage({ type: 'createCommandShortcut' });
  else if (action === 'terminal') openTerminal(context.parent);
  else if (action === 'refresh') { if (context.scope === 'desktop') refreshAll(); else refreshDirectory(context.parent); }
  else if (action === 'arrange') arrange();
}
function sendOperation(operation) {
  if (!remoteMode) { applyDemoOperation(operation); return; }
  const requestId = `operation-${nextRequest++}`;
  pendingOperations.set(requestId, operation);
  vscode.postMessage({ type: 'fileOperation', ...operation, requestId });
  notify('正在执行文件操作…');
}
function refreshAfterOperation(operation, affectedPaths) {
  const paths = new Set(Array.isArray(affectedPaths) ? affectedPaths.filter(path => typeof path === 'string') : []);
  if (operation) {
    if (operation.parent) paths.add(operation.parent);
    for (const path of operation.paths || operation.clipboard?.paths || []) paths.add(parentOf(path));
    if (operation.operation === 'rename' && operation.paths?.length === 1) {
      const oldPath = operation.paths[0], newPath = joinPath(operation.parent, operation.name);
      for (const win of state.windows) if (win.kind !== 'terminal' && (win.folder === oldPath || win.folder.startsWith(`${oldPath}/`))) {
        win.folder = newPath + win.folder.slice(oldPath.length); paths.add(win.folder); renderWindow(win);
      }
      renderDock();
    }
  }
  if (!paths.size) paths.add(rootPath);
  paths.forEach(path => requestDirectory(path));
  save(); notify('文件操作已完成，正在更新目录…');
}
function applyDemoOperation(operation) {
  const { parent, name } = operation;
  if (!directories[parent]) directories[parent] = [];
  if (operation.operation === 'new-file' || operation.operation === 'new-folder') {
    const path = joinPath(parent, name), folder = operation.operation === 'new-folder';
    directories[parent].push({ name, path, type: folder ? 'folder' : 'file', size: folder ? '' : '0 B' });
    if (folder) directories[path] = [];
  } else if (operation.operation === 'rename') {
    const item = items.get(operation.paths[0]); if (!item) return;
    const oldPath = item.path, newPath = joinPath(parent, name);
    item.name = name; item.path = newPath;
    for (const path of Object.keys(directories)) if (path === oldPath || path.startsWith(`${oldPath}/`)) {
      directories[newPath + path.slice(oldPath.length)] = directories[path].map(child => ({ ...child, path: newPath + child.path.slice(oldPath.length) })); delete directories[path];
    }
  } else if (operation.operation === 'delete') {
    for (const path of operation.paths) {
      directories[parentOf(path)] = (directories[parentOf(path)] || []).filter(item => item.path !== path);
      for (const folder of Object.keys(directories)) if (folder === path || folder.startsWith(`${path}/`)) delete directories[folder];
    }
  } else if (operation.operation === 'paste' || operation.operation === 'shortcut') {
    const paths = operation.paths || operation.clipboard.paths;
    for (const path of paths) {
      const item = items.get(path); if (!item) continue;
      const shortcut = operation.operation === 'shortcut';
      if (!shortcut && parentOf(path) === parent && operation.clipboard.mode === 'move') continue;
      const targetName = nextName(parent, item.name), targetPath = joinPath(parent, targetName);
      directories[parent].push({ ...item, name: targetName, path: targetPath, ...(shortcut ? { isSymbolicLink: true } : {}) });
      for (const folder of Object.keys(directories)) if (folder === path || folder.startsWith(`${path}/`)) {
        directories[targetPath + folder.slice(path.length)] = directories[folder].map(child => ({ ...child, path: targetPath + child.path.slice(path.length) }));
      }
      if (!shortcut && operation.clipboard.mode === 'move') directories[parentOf(path)] = directories[parentOf(path)].filter(source => source.path !== path);
    }
  }
  rebuildItems(); renderIcons(); state.windows.forEach(renderWindow); save(); notify('已更新本地示例');
  const verbs = { 'new-file': '新建文件', 'new-folder': '新建文件夹', rename: '重命名', delete: '删除', paste: '粘贴', shortcut: '创建快捷方式' };
  showOperationCommand(`# 本地示例：${verbs[operation.operation] || operation.operation}（仅模拟数据，无 Linux 指令）`);
}
function initializeLocal() {
  remoteMode = false; initialized = true; rootPath = DEMO_ROOT; homePath = DEMO_ROOT;
  directories = Object.create(null);
  for (const [path, entries] of Object.entries(demoDirectories)) setDirectory(path, entries);
  if (previous.rootPath !== rootPath) { state.positions = {}; state.shortcuts = []; }
  rebuildItems(); connectionStatus = '本地示例 · 未连接 SSH'; renderServerInfo(); $('desktopPath').textContent = rootPath;
  restoreWindows(); renderIcons(); notify('本地示例');
  $('desktop').dataset.wallpaper = state.wallpaper;
}
function restoreWindows() {
  if (previous.rootPath !== rootPath || !Array.isArray(previous.windows) || state.windows.length) return;
  for (const record of previous.windows) {
    if (!record || record.kind === 'terminal' || typeof record.folder !== 'string' || !record.folder.startsWith('/')) continue;
    const win = createWindow(record.folder, { ...record, history: Array.isArray(record.history) ? record.history : [], forward: Array.isArray(record.forward) ? record.forward : [], viewMode: state.viewMode });
    if (remoteMode && win.folder !== rootPath) requestDirectory(win.folder);
  }
  const active = state.windows.find(win => win.id === previous.activeWindow && !win.minimized) || state.windows.find(win => !win.minimized);
  if (active) focusWindow(active.id);
}
window.addEventListener('message', event => {
  const message = event.data; if (!message || typeof message.type !== 'string') return;
  if (message.type === 'fullscreenResult') {
    clearTimeout(fullscreenTimer); $('fullscreen').disabled = false;
    notify(message.message || (message.ok ? '已切换全屏视图；再次点击图标或按两次 Esc 退出' : '全屏请求失败'));
    scheduleLayout(); return;
  }
  if (message.type === 'configSaved' && settingsRequest && settingsRequest.requestId === message.requestId) {
    clearTimeout(settingsTimer);
    const request = settingsRequest; settingsRequest = null; settingsBusy(false);
    if (message.ok) { applyDesktopSettings(request.config); closeSettings(); }
    else {
      pendingConfig = { ...request.pendingPatch, ...pendingConfig };
      $('settingsError').textContent = message.error || '保存失败，请重试';
    }
    return;
  }
  if (message.type === 'serverInfo') { receiveServerInfo(message); return; }
  if (message.type === 'operationCommand') {
    if (typeof message.command === 'string') showOperationCommand(message.command, message.status, typeof message.detail === 'string' ? message.detail : '');
    return;
  }
  if (['terminalOpened', 'terminalData', 'terminalExit', 'terminalError'].includes(message.type)) { handleTerminalMessage(message); return; }
  if (message.type === 'remoteState') {
    if (message.status === 'local') { if (!initialized) initializeLocal(); return; }
    if (message.status === 'ready' && Array.isArray(message.entries)) {
      const path = message.rootPath || message.folder;
      if (typeof path !== 'string') return;
      const initial = !initialized || !remoteMode || path !== rootPath;
      if (initial) {
        clearTimeout(settingsTimer); settingsRequest = null; settingsBusy(false); $('settingsDialog').close();
        if (editor) editor.cancel();
        for (const id of [...terminals.keys()]) disposeTerminal(id);
        directories = Object.create(null); directoryRequests.clear(); latestDirectoryRequests.clear(); state.windows = []; windowElements.clear(); $('windows').replaceChildren();
        state.activeWindow = null; selection = { scope: 'desktop', keys: new Set() }; state.clipboard = null;
      }
      remoteMode = true; initialized = true; rootPath = path;
      homePath = typeof message.homePath === 'string' && message.homePath.startsWith('/') ? message.homePath : null;
      setDirectory(rootPath, message.entries); applyConfig(message.config, initial);
      connectionStatus = 'Remote-SSH · 已连接'; renderServerInfo(); $('desktopPath').textContent = rootPath;
      if (initial) restoreWindows();
      renderIcons(); state.windows.forEach(renderWindow); renderDock(); save(); notify(`已刷新 ${rootPath}`);
    } else if (message.status === 'missing' || message.status === 'error') {
      initialized = true; remoteMode = true;
      if (editor) editor.cancel();
      directories = Object.create(null); state.shortcuts = []; rebuildItems(); renderIcons();
      connectionStatus = message.status === 'missing' ? 'Remote-SSH · 尚未创建桌面' : 'Remote-SSH · 读取失败'; renderServerInfo();
      notify(message.message || '远程桌面尚未创建');
    }
  } else if (message.type === 'remoteDirectory' || message.type === 'remoteFolder') {
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
      if (latest || !Object.hasOwn(directories, message.path)) setDirectory(message.path, message.entries);
      if (navigatingWindow) commitNavigation(navigatingWindow, message.path, request.mode);
      if (latest) {
        if (message.path === rootPath) renderIcons();
        for (const win of state.windows) if (win.kind !== 'terminal' && win.folder === message.path && !win.pendingNavigation) { win.error = null; renderWindow(win); }
      }
      if (latest || navigatingWindow) notify(`已${navigatingWindow ? '打开' : '刷新'} ${message.path}`);
    } else if (message.error) {
      if (navigatingWindow) {
        navigatingWindow.pendingNavigation = null; navigatingWindow.error = message.error;
        const address = windowElements.get(navigatingWindow.id)?.querySelector('.window-path');
        address?.setAttribute('aria-invalid', 'true'); if (address) address.title = message.error;
        updateWindowStatus(navigatingWindow);
      } else if (latest) for (const win of state.windows) if (win.kind !== 'terminal' && win.folder === message.path && !win.pendingNavigation) { win.error = message.error; renderWindow(win); }
      if (latest || navigatingWindow) notify(message.error);
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
});
$('context').addEventListener('click', event => {
  const button = event.target.closest('button[data-action]'); if (!button || button.disabled) return;
  $('context').hidden = true; performAction(button.dataset.action, menuContext);
});
$('icons').addEventListener('contextmenu', event => {
  if (event.target.closest('.icon')) return;
  selection = { scope: 'desktop', keys: new Set() }; syncSelection(); showMenu(event, contextFor('desktop'));
});
$('unpinApp').addEventListener('click', () => { if (appContextId) vscode.postMessage({ type: 'unpinApp', id: appContextId }); $('appContext').hidden = true; });
$('togglePinApp').addEventListener('click', () => { const win = getWindow(appContextWindowId); if (win?.kind === 'terminal') windowAction('pin', win); $('appContext').hidden = true; });
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('#context')) $('context').hidden = true;
  if (!event.target.closest('#appContext')) $('appContext').hidden = true;
});
document.addEventListener('keydown', event => {
  if ($('settingsDialog').open) return;
  if (event.target.closest('input, textarea, .terminal-window, [contenteditable="true"]')) return;
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
$('newWindow').addEventListener('click', () => openFolder(rootPath));
$('desktopSettings').addEventListener('click', openSettings);
$('settingsForm').addEventListener('submit', submitSettings);
$('cancelSettings').addEventListener('click', closeSettings);
$('closeSettings').addEventListener('click', closeSettings);
$('settingsDialog').addEventListener('cancel', event => { if (settingsRequest) event.preventDefault(); });
$('fullscreen').addEventListener('click', requestFullscreen);
for (const [id, name] of Object.entries({ newWindow: 'Plus', desktopSettings: 'Settings', fullscreen: 'Maximize' })) {
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleLayout(); });
setInterval(updateClock, 1000);
setInterval(() => vscode.postMessage({ type: 'getServerInfo' }), 30000);
vscode.postMessage({ type: 'ready' });
