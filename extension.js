'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const CONFIG_LIMIT = 64 * 1024;
const EXTENSION_SETTINGS_DEFAULTS = { openOnStartup: false, remoteRoot: '/home/demo', remoteHome: '', scriptEditor: 'vscode' };
const errorText = (error) => error instanceof Error ? error.message : String(error);
const isMissing = (error) => ['FileNotFound', 'EntryNotFound', 'ENOENT'].includes(error?.code) || error?.name === 'EntryNotFound (FileSystemError)';
// Display only: these strings never enter a shell or a VS Code command argument.
const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const displayComment = (value) => `# ${String(value).replace(/[\r\n\x00-\x1f\x7f]/g, ' ')}`;

function normalizePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\\\0]/.test(value)) return undefined;
  return path.posix.normalize(value).replace(/\/$/, '') || '/';
}

function containsPath(root, target) {
  return target === root || target.startsWith(root === '/' ? '/' : `${root}/`);
}

function validateName(value) {
  if (typeof value !== 'string' || !value.trim() || value === '.' || value === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(value) || Buffer.byteLength(value) > 255) {
    throw new Error('名称不能为空，不能包含路径分隔符或特殊字符，也不能超过 255 字节。');
  }
  return value;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Remote Desktop');
  let panel;
  let ready = false;
  let readyCount = 0;
  let openRequests = [];
  let remoteState = { status: 'unknown' };
  let remoteHomeRoot;
  let remoteDesktopRoot;
  let desktopConfig = {};
  let configUri;
  let configError;
  let configQueue = Promise.resolve();
  let fullscreenQueue = Promise.resolve();
  let initialization;
  let terminalManager;
  let settingsQueue = Promise.resolve();
  let sessionSettings;
  const settingsPanels = new Set();
  const pendingTerminalCommands = new WeakMap();

  function isRemoteWorkspace() {
    return Boolean(vscode.env.remoteName || vscode.workspace.workspaceFolders?.some(({ uri }) => uri.scheme === 'vscode-remote'));
  }

  function nativeRemoteHost() {
    // Remote extension hosts translate their own URIs to file:. A UI host sees
    // remote workspace URIs as vscode-remote:. context.extension.extensionKind
    // reports the actual host, so an SSH connection also works without folders.
    const folders = vscode.workspace.workspaceFolders || [];
    return Boolean(vscode.env.remoteName
      && context.extensionUri.scheme === 'file'
      && context.extension?.extensionKind === vscode.ExtensionKind?.Workspace
      && folders.every(({ uri }) => uri.scheme === 'file'));
  }

  function remoteHomeUri() {
    if (!isRemoteWorkspace()) return undefined;
    const folder = vscode.workspace.workspaceFolders?.[0];
    const template = folder?.uri || context.extensionUri;
    const configured = (sessionSettings || extensionSettings()).remoteHome;
    if (configured) {
      const normalized = normalizePath(configured);
      if (!normalized) throw new Error('remoteDesktopDemo.remoteHome 必须是远程主目录的绝对路径。');
      return template.with({ path: normalized, query: '', fragment: '' });
    }
    if (nativeRemoteHost()) {
      const home = normalizePath(os.homedir().replace(/\\/g, '/'));
      if (home) return template.with({ path: home, query: '', fragment: '' });
    }
    const match = folder?.uri.path.match(/^\/(home\/[^/]+|root)(?:\/|$)/);
    return match ? template.with({ path: `/${match[1]}`, query: '', fragment: '' }) : undefined;
  }

  function uriForRemotePath(value) {
    const normalized = normalizePath(value);
    if (!normalized || !remoteHomeRoot) return undefined;
    const roots = [remoteHomeRoot, ...(vscode.workspace.workspaceFolders || []).map((folder) => folder.uri)];
    const root = roots.find((uri) => uri.scheme === remoteHomeRoot.scheme && uri.authority === remoteHomeRoot.authority && containsPath(normalizePath(uri.path), normalized));
    return root?.with({ path: normalized, query: '', fragment: '' });
  }

  function workspaceUriFor(value) {
    if (isRemoteWorkspace()) return uriForRemotePath(value);
    const folder = vscode.workspace.workspaceFolders?.[0];
    const normalized = normalizePath(value);
    const root = normalizePath(String((sessionSettings || extensionSettings()).remoteRoot));
    if (!folder || !normalized || !root || !containsPath(root, normalized)) return undefined;
    const relative = normalized.slice(root.length).replace(/^\/+/, '');
    return relative ? vscode.Uri.joinPath(folder.uri, ...relative.split('/')) : folder.uri;
  }

  function requireUri(value) {
    const uri = workspaceUriFor(value);
    if (!uri) throw new Error(`路径不在当前远程主目录或工作区内：${String(value)}`);
    return uri;
  }

  function requireMutable(uri) {
    const protectedRoots = [remoteHomeRoot, remoteDesktopRoot, ...(vscode.workspace.workspaceFolders || []).map((folder) => folder.uri)].filter(Boolean);
    if (uri.path === '/' || protectedRoots.some((root) => root.scheme === uri.scheme && root.authority === uri.authority && normalizePath(root.path) === normalizePath(uri.path))) {
      throw new Error('不能移动、重命名或删除主目录、桌面目录和工作区根目录。');
    }
    return uri;
  }

  function parentUri(uri) {
    return uri.with({ path: path.posix.dirname(uri.path) });
  }

  async function send(targetPanel, message) {
    try { await targetPanel?.webview.postMessage(message); }
    catch (error) { output.appendLine(`Webview notification failed: ${errorText(error)}`); }
  }

  function extensionSettings() {
    const config = vscode.workspace.getConfiguration('remoteDesktopDemo');
    return Object.fromEntries(Object.entries(EXTENSION_SETTINGS_DEFAULTS).map(([key, fallback]) => [key, config.get(key, fallback)]));
  }

  function settingsSnapshot(target, requestId) {
    const hasWorkspace = Boolean(vscode.workspace.workspaceFolders?.length);
    const settings = extensionSettings();
    const reopenRequired = Boolean(sessionSettings && ['remoteRoot', 'remoteHome'].some((key) => sessionSettings[key] !== settings[key]));
    return { settings, hasWorkspace, target: target || (hasWorkspace ? 'workspace' : 'user'), reopenRequired, ...(requestId !== undefined ? { requestId } : {}) };
  }

  async function sendExtensionSettings(targetPanel, requestId) {
    if (targetPanel) settingsPanels.add(targetPanel);
    // Never expose one field from an unfinished multi-setting write or rollback.
    await settingsQueue;
    await send(targetPanel, { type: 'extensionSettings', ...settingsSnapshot(undefined, requestId) });
  }

  function validateExtensionSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('扩展设置必须是有效的设置对象。');
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(EXTENSION_SETTINGS_DEFAULTS, key)) throw new Error(`不支持修改此设置：${key}`);
      if (key === 'openOnStartup' && typeof value !== 'boolean') throw new Error('启动时打开桌面必须是布尔值。');
      if (key === 'scriptEditor' && !['vscode', 'vim'].includes(value)) throw new Error('脚本文件默认开启软件必须为 vscode 或 vim。');
      if (['remoteRoot', 'remoteHome'].includes(key) && !(key === 'remoteHome' && value === '')
        && (typeof value !== 'string' || !normalizePath(value) || /[\x00-\x1f\x7f]/.test(value))) {
        throw new Error(`${key} 必须是绝对 POSIX 路径${key === 'remoteHome' ? '或留空' : ''}。`);
      }
    }
    return patch;
  }

  async function saveExtensionSettings(message, targetPanel) {
    const targetName = message.target || settingsSnapshot().target;
    const work = settingsQueue.catch(() => {}).then(async () => {
      try {
        if (!['workspace', 'user'].includes(targetName)) throw new Error('设置保存范围必须为 workspace 或 user。');
        if (targetName === 'workspace' && !vscode.workspace.workspaceFolders?.length) throw new Error('请先打开工作区文件夹，或改为保存到用户设置。');
        const patch = validateExtensionSettings(message.settings);
        const target = targetName === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        const config = vscode.workspace.getConfiguration('remoteDesktopDemo');
        const valueKey = targetName === 'workspace' ? 'workspaceValue' : 'globalValue';
        const originals = new Map(Object.keys(patch).map((key) => [key, config.inspect(key)?.[valueKey]]));
        const changed = [];
        try {
          for (const [key, value] of Object.entries(patch)) {
            if (Object.is(originals.get(key), value)) continue;
            await config.update(key, value, target);
            changed.push(key);
          }
        } catch (error) {
          const rollbackErrors = [];
          for (const key of changed.reverse()) {
            try { await config.update(key, originals.get(key), target); }
            catch (rollbackError) { rollbackErrors.push(`${key}: ${errorText(rollbackError)}`); }
          }
          throw new Error(`${errorText(error)}${rollbackErrors.length ? `；部分设置回滚失败：${rollbackErrors.join('；')}` : ''}`);
        }
        const snapshot = settingsSnapshot(targetName, message.requestId);
        await send(targetPanel, { type: 'extensionSettingsSaved', ok: true, ...snapshot });
      } catch (error) {
        const snapshot = settingsSnapshot(['workspace', 'user'].includes(targetName) ? targetName : undefined, message.requestId);
        await send(targetPanel, { type: 'extensionSettingsSaved', ok: false, ...snapshot, error: errorText(error) });
        output.appendLine(`Extension settings save failed: ${errorText(error)}`);
      }
    });
    settingsQueue = work.catch(() => {});
    await work;
  }

  function linuxCommandsAvailable() {
    return process.platform === 'linux' && (!isRemoteWorkspace() || nativeRemoteHost());
  }

  async function sendOperationCommand(targetPanel, command, status = 'success', detail) {
    await send(targetPanel, { type: 'operationCommand', command, status, ...(detail ? { detail } : {}) });
  }

  function fileCommand(command, description) {
    return linuxCommandsAvailable() ? command : displayComment(`VS Code 文件系统：${description}`);
  }

  function directoryCommand(directoryPath, navigation = false) {
    const value = normalizePath(directoryPath) || directoryPath;
    const command = navigation ? `cd -- ${shellQuote(value)} && ls -la` : `ls -la -- ${shellQuote(value)}`;
    return fileCommand(command, `${navigation ? '打开目录' : '刷新目录'} ${value}`);
  }

  async function sendTerminalMessage(targetPanel, message) {
    await send(targetPanel, message);
    if (!['terminalOpened', 'terminalError'].includes(message.type)) return;
    const requested = pendingTerminalCommands.get(targetPanel)?.get(message.id);
    if (!requested) return;
    if (message.type === 'terminalOpened') {
      const filePath = message.filePath || requested.filePath;
      const program = message.program === 'shell' ? '"${SHELL:-/bin/sh}" -i' : message.program === 'vim' && filePath ? `vim -- ${shellQuote(filePath)}` : message.program;
      const command = linuxCommandsAvailable() ? `cd -- ${shellQuote(message.cwd)} && ${program}` : displayComment(`VS Code PTY：在 ${message.cwd} 启动 ${message.program}`);
      await sendOperationCommand(targetPanel, command, 'success', linuxCommandsAvailable() ? '终端启动的 Linux 等效命令；终端输入不记录在此处。' : '通过 VS Code 扩展主机 PTY 启动；终端输入不记录在此处。');
    } else {
      await sendOperationCommand(targetPanel, displayComment(`启动 ${requested.program || 'shell'}：${requested.path || remoteDesktopRoot?.path || ''}`), 'error', message.error);
    }
    pendingTerminalCommands.get(targetPanel)?.delete(message.id);
  }

  async function sendServerInfo(targetPanel) {
    const remote = isRemoteWorkspace();
    if (remote && !nativeRemoteHost()) {
      await send(targetPanel, { type: 'serverInfo', username: null, hostname: null, epochMs: null, timeZone: null, platform: null, remote, error: '请将插件安装到 SSH 扩展主机，以读取服务器账号和时间。' });
      return;
    }
    await send(targetPanel, { type: 'serverInfo', username: os.userInfo().username, hostname: os.hostname(), epochMs: Date.now(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, platform: process.platform, remote });
  }

  function getTerminalManager() {
    if (!terminalManager) {
      const { createTerminalManager } = require('./remote-terminal.js');
      terminalManager = createTerminalManager({
        appRoot: vscode.env.appRoot,
        send: sendTerminalMessage,
        resolveCwd: (value) => {
          const uri = value ? requireUri(value) : (remoteDesktopRoot || vscode.workspace.workspaceFolders?.[0]?.uri);
          if (!uri || uri.scheme !== 'file' || (isRemoteWorkspace() && !nativeRemoteHost())) throw new Error('桌面终端需要插件运行在当前工作区的扩展主机中。');
          return uri.fsPath;
        },
        resolveFile: async (value) => {
          const uri = requireUri(value);
          if (uri.scheme !== 'file' || (isRemoteWorkspace() && !nativeRemoteHost())) throw new Error('Vim 文件编辑需要插件运行在当前工作区的扩展主机中。');
          const resolved = await fs.promises.realpath(uri.fsPath);
          const roots = [remoteHomeRoot, ...(vscode.workspace.workspaceFolders || []).map((folder) => folder.uri)].filter((root) => root?.scheme === 'file');
          let allowed = false;
          for (const root of roots) {
            const rootPath = await fs.promises.realpath(root.fsPath);
            const relative = path.relative(rootPath, resolved);
            if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) { allowed = true; break; }
          }
          if (!allowed) throw new Error('文件链接目标不在当前远程主目录或工作区内。');
          const stat = await fs.promises.stat(resolved);
          if (!stat.isFile()) throw new Error('Vim 只能打开普通文件。');
          return uri.fsPath;
        },
        isNativeHost: () => !isRemoteWorkspace() || nativeRemoteHost(),
        isTrusted: () => vscode.workspace.isTrusted,
        log: (line) => output.appendLine(line)
      });
    }
    return terminalManager;
  }

  async function statOptional(uri) {
    try { return await vscode.workspace.fs.stat(uri); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
  }

  async function assertAbsent(uri) {
    if (await statOptional(uri)) throw new Error(`目标已存在，未覆盖：${path.posix.basename(uri.path)}`);
    // stat() can follow a dangling symlink. A directory listing still exposes it.
    const entries = await vscode.workspace.fs.readDirectory(parentUri(uri));
    if (entries.some(([name]) => name === path.posix.basename(uri.path))) throw new Error(`目标已存在，未覆盖：${path.posix.basename(uri.path)}`);
  }

  async function readRemoteDirectory(uri) {
    const children = await vscode.workspace.fs.readDirectory(uri);
    const entries = await Promise.all(children.map(async ([name, type]) => {
      const child = vscode.Uri.joinPath(uri, name);
      const isSymbolicLink = Boolean(type & vscode.FileType.SymbolicLink);
      let stat;
      let linkTarget;
      let broken = false;
      let targetType = type & vscode.FileType.Directory ? 'folder' : 'file';
      try {
        stat = await vscode.workspace.fs.stat(child);
        targetType = stat.type & vscode.FileType.Directory ? 'folder' : 'file';
      } catch (error) {
        if (isSymbolicLink && isMissing(error)) broken = true;
        else if (!isMissing(error)) output.appendLine(`Metadata unavailable for ${child.path}: ${errorText(error)}`);
      }
      if (isSymbolicLink && nativeRemoteHost() && child.scheme === 'file') {
        try {
          const target = await fs.promises.readlink(child.fsPath);
          linkTarget = path.resolve(path.dirname(child.fsPath), target).replace(/\\/g, '/');
          const resolved = await fs.promises.stat(child.fsPath);
          targetType = resolved.isDirectory() ? 'folder' : 'file';
          broken = false;
        } catch (error) { if (isMissing(error)) broken = true; }
      }
      return {
        name, type: targetType, path: child.path, uri: child.toString(),
        size: targetType === 'folder' ? '' : formatSize(stat?.size),
        sizeBytes: stat?.size, mtime: stat?.mtime,
        isSymbolicLink, ...(isSymbolicLink ? { linkTarget, targetType, broken } : {})
      };
    }));
    return entries.sort((a, b) => (a.type === 'folder' ? 0 : 1) - (b.type === 'folder' ? 0 : 1) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  }

  function validateConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('桌面配置必须是 JSON 对象。');
    if (value.viewMode !== undefined && !['icons', 'details'].includes(value.viewMode)) throw new Error('配置 viewMode 只能为 icons 或 details。');
    if (value.wallpaper !== undefined && !['teal', 'purple', 'slate'].includes(value.wallpaper)) throw new Error('配置 wallpaper 只能为 teal、purple 或 slate。');
    if (value.showHiddenFiles !== undefined && typeof value.showHiddenFiles !== 'boolean') throw new Error('配置 showHiddenFiles 必须是布尔值。');
    if (value.positions !== undefined && (!value.positions || typeof value.positions !== 'object' || Array.isArray(value.positions))) throw new Error('配置 positions 必须是对象。');
    if (value.shortcuts !== undefined && !Array.isArray(value.shortcuts)) throw new Error('配置 shortcuts 必须是数组。');
    if (value.pinnedApps !== undefined) {
      if (!Array.isArray(value.pinnedApps) || value.pinnedApps.length > 32) throw new Error('配置 pinnedApps 必须是最多包含 32 项的数组。');
      value.pinnedApps.forEach(validatePinnedApp);
      if (new Set(value.pinnedApps.map((app) => app.id)).size !== value.pinnedApps.length) throw new Error('固定程序的 id 不能重复。');
    }
    return value;
  }

  function validatePinnedApp(app) {
    if (!app || typeof app !== 'object' || Array.isArray(app)
      || !['vim', 'htop', 'shell'].includes(app.program)
      || typeof app.id !== 'string' || !app.id.trim() || app.id.length > 120 || /[\x00-\x1f]/.test(app.id)
      || typeof app.label !== 'string' || !app.label.trim() || app.label.length > 120 || /[\x00-\x1f]/.test(app.label)) {
      throw new Error('固定程序需要有效的 id、名称，以及 vim、htop 或 shell 程序。');
    }
    return app;
  }

  async function readConfigFile(uri) {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.length > CONFIG_LIMIT) throw new Error('桌面配置超过 64 KB，无法载入。');
    return validateConfig(JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '')));
  }

  async function loadDesktopConfig() {
    configError = undefined;
    const candidates = [
      vscode.Uri.joinPath(remoteDesktopRoot, '.remote-desktop.json'),
      vscode.Uri.joinPath(remoteDesktopRoot, 'config.json'),
      vscode.Uri.joinPath(remoteHomeRoot, '.config', 'remote-desktop', 'config.json'),
      vscode.Uri.joinPath(remoteHomeRoot, '.remote-desktop.json')
    ];
    configUri = candidates[0];
    desktopConfig = {};
    for (const candidate of candidates) {
      try {
        const loaded = await readConfigFile(candidate);
        configUri = candidate;
        desktopConfig = loaded;
        break;
      } catch (error) {
        if (isMissing(error)) continue;
        configUri = candidate;
        configError = `无法载入桌面配置 ${candidate.path}：${errorText(error)}`;
        output.appendLine(configError);
        await vscode.window.showWarningMessage(configError);
        break;
      }
    }
    return desktopConfig;
  }

  function queueConfigOperation(operation) {
    const work = configQueue.then(operation);
    configQueue = work.catch(() => {});
    return work;
  }

  function queueConfigWrite(mutator) {
    return queueConfigOperation(async () => {
      if (!remoteDesktopRoot || !configUri) throw new Error('远程桌面尚未就绪，无法保存配置。');
      let current;
      try { current = await readConfigFile(configUri); }
      catch (error) {
        if (!isMissing(error)) {
          configError = `桌面配置无效或不可读，未覆盖原文件：${errorText(error)}`;
          throw new Error(configError);
        }
        current = {};
      }
      const next = validateConfig(mutator(current));
      const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
      if (bytes.length > CONFIG_LIMIT) throw new Error('桌面配置超过 64 KB，未保存。');
      const temp = vscode.Uri.joinPath(parentUri(configUri), `.remote-desktop-${crypto.randomUUID()}.tmp`);
      try {
        await vscode.workspace.fs.writeFile(temp, bytes);
        await vscode.workspace.fs.rename(temp, configUri, { overwrite: true });
      } finally {
        try { await vscode.workspace.fs.delete(temp, { recursive: false, useTrash: false }); }
        catch (error) { if (!isMissing(error)) output.appendLine(`Config temporary file cleanup failed: ${errorText(error)}`); }
      }
      desktopConfig = next;
      configError = undefined;
      return next;
    });
  }

  async function inspectRemoteDesktop() {
    if (!isRemoteWorkspace()) return { status: 'local', rootPath: normalizePath((sessionSettings || extensionSettings()).remoteRoot) || '/home/demo' };
    const home = remoteHomeUri();
    if (!home) return { status: 'error', message: '无法定位远程主目录，请设置 remoteDesktopDemo.remoteHome，并将插件安装到 SSH 扩展主机。' };
    remoteHomeRoot = home;
    const homeEntries = await vscode.workspace.fs.readDirectory(home);
    let desktopName = homeEntries.find(([name, type]) => (type & vscode.FileType.Directory) && /^(desktop|桌面)$/i.test(name))?.[0];
    if (!desktopName) {
      const choice = await vscode.window.showInformationMessage('未找到远程主目录下的 Desktop 文件夹，是否现在创建？', '创建 Desktop 文件夹', '暂不创建');
      if (choice !== '创建 Desktop 文件夹') return { status: 'missing', home: home.path, homePath: home.path, folder: vscode.Uri.joinPath(home, 'Desktop').path, entries: [] };
      desktopName = 'Desktop';
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(home, desktopName));
    }
    remoteDesktopRoot = vscode.Uri.joinPath(home, desktopName);
    const entries = await readRemoteDirectory(remoteDesktopRoot);
    await loadDesktopConfig();
    return { status: 'ready', mode: 'remote', homePath: home.path, folder: remoteDesktopRoot.path, rootPath: remoteDesktopRoot.path, entries, config: desktopConfig, configError };
  }

  async function inspectRemoteDirectory(targetPanel, directoryPath, requestId, interaction) {
    const normalized = normalizePath(directoryPath);
    try {
      const uri = requireUri(directoryPath);
      const entries = await readRemoteDirectory(uri);
      const operationCommand = interaction ? { command: directoryCommand(uri.path, interaction !== 'refresh'), status: 'success' } : undefined;
      await send(targetPanel, { type: 'remoteDirectory', path: normalized, requestId, entries, ...(operationCommand ? { operationCommand } : {}) });
      return entries;
    } catch (error) {
      const operationCommand = interaction ? { command: directoryCommand(directoryPath, interaction !== 'refresh'), status: 'error', detail: errorText(error) } : undefined;
      await send(targetPanel, { type: 'remoteDirectory', path: normalized || directoryPath, requestId, error: errorText(error), ...(operationCommand ? { operationCommand } : {}) });
      output.appendLine(`Directory refresh failed for ${directoryPath}: ${errorText(error)}`);
      return undefined;
    }
  }

  async function refreshRemote(message = {}, targetPanel = panel) {
    if (initialization) await initialization;
    let refreshError;
    try {
      // Reserve the queue for reading and publishing the snapshot too. Merely
      // waiting for existing writes lets a later write overtake a slow read.
      await queueConfigOperation(async () => {
        if (!remoteDesktopRoot) remoteState = await inspectRemoteDesktop();
        else {
          const entries = await readRemoteDirectory(remoteDesktopRoot);
          if (message.reloadConfig !== false) await loadDesktopConfig();
          remoteState = { ...remoteState, status: 'ready', homePath: remoteHomeRoot.path, folder: remoteDesktopRoot.path, rootPath: remoteDesktopRoot.path, entries, config: desktopConfig, configError, message: undefined };
        }
        await send(targetPanel, { type: 'remoteState', ...remoteState, refresh: true });
      });
    } catch (error) {
      refreshError = errorText(error);
      await send(targetPanel, { type: 'remoteState', status: 'error', refresh: true, message: `刷新远程桌面失败：${errorText(error)}` });
    }
    const paths = new Set([remoteDesktopRoot?.path, ...(Array.isArray(message.paths) ? message.paths : [])].filter(Boolean));
    for (const directoryPath of paths) {
      if (await inspectRemoteDirectory(targetPanel, directoryPath) === undefined) refreshError ||= `目录读取失败：${directoryPath}`;
    }
    if (message.intent === 'refresh') {
      const command = [...paths].map((directoryPath) => directoryCommand(directoryPath)).join(linuxCommandsAvailable() ? ' && ' : '；') || displayComment('刷新远程桌面');
      const unavailable = refreshError || (remoteState.status !== 'ready' ? remoteState.message || '远程桌面尚未就绪。' : undefined);
      await sendOperationCommand(targetPanel, command, unavailable ? 'error' : 'success', unavailable);
    }
  }

  async function openResource(message, targetPanel = panel) {
    const requestedPath = typeof message.path === 'string' ? message.path : '';
    const kind = message.kind === 'folder' ? 'folder' : 'file';
    const target = workspaceUriFor(requestedPath);
    const request = { path: requestedPath, kind, delegated: Boolean(target), command: null };
    openRequests = [...openRequests.slice(-19), request];
    if (!target) {
      output.appendLine(`Unmapped resource requested: ${requestedPath}`);
      await vscode.window.showInformationMessage(`无法打开未映射到工作区的路径：${requestedPath}`);
      await sendOperationCommand(targetPanel, displayComment(`VS Code 打开 ${requestedPath}`), 'error', '路径未映射到当前工作区。');
      return;
    }
    try {
      request.command = kind === 'folder' ? 'revealInExplorer' : 'vscode.open';
      await vscode.commands.executeCommand(request.command, target);
      output.appendLine(`Delegated ${kind} access to ${request.command}: ${target.toString()}`);
      await sendOperationCommand(targetPanel, displayComment(`VS Code ${request.command}：${target.path}`));
    } catch (error) {
      output.appendLine(`VS Code access failed for ${requestedPath}: ${errorText(error)}`);
      await vscode.window.showWarningMessage(`VS Code 无法打开 ${requestedPath}：${errorText(error)}`);
      await sendOperationCommand(targetPanel, displayComment(`VS Code ${request.command}：${target.path}`), 'error', errorText(error));
    }
  }

  function distinctSources(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.some((value) => typeof value !== 'string')) throw new Error('请选择需要操作的文件。');
    const sources = [...new Map(paths.map((value) => { const uri = requireUri(value); return [uri.toString(), uri]; })).values()];
    return sources.filter((uri, index) => !sources.some((other, otherIndex) => index !== otherIndex && other.path !== uri.path && containsPath(other.path, uri.path)));
  }

  async function deleteEntry(uri) {
    if (nativeRemoteHost() && uri.scheme === 'file') {
      const stat = await fs.promises.lstat(uri.fsPath);
      if (stat.isSymbolicLink()) { await fs.promises.unlink(uri.fsPath); return; }
    }
    const entries = await vscode.workspace.fs.readDirectory(parentUri(uri));
    const type = entries.find(([name]) => name === path.posix.basename(uri.path))?.[1];
    await vscode.workspace.fs.delete(uri, { recursive: !(type & vscode.FileType.SymbolicLink), useTrash: !isRemoteWorkspace() });
  }

  async function createEmptyFile(uri) {
    if (nativeRemoteHost() && uri.scheme === 'file') {
      await fs.promises.writeFile(uri.fsPath, '', { flag: 'wx' });
      return;
    }
    const temp = vscode.Uri.joinPath(parentUri(uri), `.remote-desktop-${crypto.randomUUID()}.tmp`);
    try {
      await vscode.workspace.fs.writeFile(temp, Buffer.from(''));
      await vscode.workspace.fs.rename(temp, uri, { overwrite: false });
    } finally {
      try { await vscode.workspace.fs.delete(temp, { recursive: false, useTrash: false }); }
      catch (error) { if (!isMissing(error)) output.appendLine(`New file temporary cleanup failed: ${errorText(error)}`); }
    }
  }

  async function createSymbolicShortcut(source, onTarget) {
    if (!nativeRemoteHost() || source.scheme !== 'file' || remoteDesktopRoot?.scheme !== 'file') {
      throw new Error('创建符号链接需要插件运行在 SSH 服务器扩展主机中，请在“SSH: 当前服务器”中安装此插件。');
    }
    const sourceStat = await fs.promises.lstat(source.fsPath);
    const base = `${path.posix.basename(source.path)} - 快捷方式`;
    let index = 1;
    while (index < 10000) {
      const target = vscode.Uri.joinPath(remoteDesktopRoot, index === 1 ? base : `${base} (${index})`);
      try {
        onTarget?.(target);
        await fs.promises.symlink(source.fsPath, target.fsPath, sourceStat.isDirectory() ? 'dir' : 'file');
        return target;
      } catch (error) { if (error?.code !== 'EEXIST') throw error; index += 1; }
    }
    throw new Error('桌面中的同名快捷方式过多，请先重命名部分项目。');
  }

  async function fileOperation(message, targetPanel = panel) {
    const operation = typeof message.operation === 'string' ? message.operation : '';
    const affected = new Set(remoteDesktopRoot ? [remoteDesktopRoot.path] : []);
    const created = [];
    const operationCommands = [];
    const addCommand = (command, description) => operationCommands.push(fileCommand(command, description));
    const commandText = () => operationCommands.join(linuxCommandsAvailable() ? ' && ' : '；') || displayComment(`文件操作 ${operation}`);
    let result;
    try {
      if (initialization) await initialization;
      if (remoteDesktopRoot) affected.add(remoteDesktopRoot.path);
      if (operation === 'new-file' || operation === 'new-folder') {
        const parent = requireUri(message.parent);
        const target = vscode.Uri.joinPath(parent, validateName(message.name));
        addCommand(`${operation === 'new-folder' ? 'mkdir' : 'touch'} -- ${shellQuote(target.path)}`, `${operation === 'new-folder' ? '新建文件夹' : '新建文件'} ${target.path}`);
        await assertAbsent(target);
        if (operation === 'new-folder') await vscode.workspace.fs.createDirectory(target);
        else await createEmptyFile(target);
        affected.add(parent.path);
        created.push(target.path);
      } else if (operation === 'delete') {
        const sources = distinctSources(message.paths).map(requireMutable);
        for (const uri of sources) {
          if (isRemoteWorkspace()) addCommand(`rm -r -- ${shellQuote(uri.path)}`, `永久删除 ${uri.path}`);
          else operationCommands.push(displayComment(`VS Code：将 ${uri.path} 移入回收站`));
        }
        if (isRemoteWorkspace()) {
          const choice = await vscode.window.showWarningMessage(`永久删除所选的 ${sources.length} 个项目？远程文件不会进入回收站；符号链接只删除链接本身。`, { modal: true }, '永久删除');
          if (choice !== '永久删除') {
            result = { type: 'operationResult', requestId: message.requestId, success: false, ok: false, cancelled: true, operation, paths: [], affectedPaths: [] };
            await send(targetPanel, result);
            await sendOperationCommand(targetPanel, commandText(), 'cancelled', '用户取消了永久删除，文件未更改。');
            return result;
          }
        }
        for (const uri of sources) affected.add(parentUri(uri).path);
        for (const uri of sources) {
          await deleteEntry(uri);
        }
      } else if (operation === 'rename') {
        const sources = distinctSources(message.paths);
        if (sources.length !== 1) throw new Error('重命名需要选择一个文件或文件夹。');
        const source = requireMutable(sources[0]);
        const target = vscode.Uri.joinPath(parentUri(source), validateName(message.name));
        if (target.path !== source.path) addCommand(`mv --no-clobber -- ${shellQuote(source.path)} ${shellQuote(target.path)}`, `重命名 ${source.path} → ${target.path}`);
        else operationCommands.push(displayComment(`名称未改变：${source.path}`));
        if (target.path !== source.path) {
          await assertAbsent(target);
          await vscode.workspace.fs.rename(source, target, { overwrite: false });
        }
        affected.add(parentUri(source).path);
        created.push(target.path);
      } else if (operation === 'paste') {
        const parent = requireUri(message.parent);
        const sources = distinctSources(message.clipboard?.paths);
        affected.add(parent.path);
        for (const source of sources) affected.add(parentUri(source).path);
        const move = message.clipboard?.mode === 'move' || message.clipboard?.mode === 'cut';
        const reserved = new Set((await vscode.workspace.fs.readDirectory(parent)).map(([name]) => name));
        const targets = [];
        for (const source of sources) {
          if (move) requireMutable(source);
          const sourceEntries = await vscode.workspace.fs.readDirectory(parentUri(source));
          const sourceType = sourceEntries.find(([name]) => name === path.posix.basename(source.path))?.[1];
          if (sourceType === undefined) throw new Error(`源文件不存在：${path.posix.basename(source.path)}`);
          const isDirectory = Boolean(sourceType & vscode.FileType.Directory);
          if (isDirectory && containsPath(source.path, parent.path)) throw new Error('不能将文件夹复制或移动到自身及其子目录。');
          const originalName = path.posix.basename(source.path);
          let name = originalName;
          if (!move) {
            const extension = isDirectory ? '' : path.posix.extname(originalName);
            const stem = extension ? originalName.slice(0, -extension.length) : originalName;
            let suffix = 1;
            while (reserved.has(name)) name = `${stem}(${suffix++})${extension}`;
          }
          const target = vscode.Uri.joinPath(parent, name);
          if (move && source.path === target.path) throw new Error('不能将文件移动到自身。');
          targets.push(target);
          addCommand(`${move ? 'mv --no-clobber' : 'cp -R --no-clobber'} -- ${shellQuote(source.path)} ${shellQuote(target.path)}`, `${move ? '移动' : '复制'} ${source.path} → ${target.path}`);
          reserved.add(name);
        }
        if (new Set(targets.map((target) => target.path)).size !== targets.length) throw new Error('所选文件中包含同名项目，请分别粘贴到目标目录。');
        for (const target of targets) await assertAbsent(target);
        for (let index = 0; index < sources.length; index += 1) {
          if (move) await vscode.workspace.fs.rename(sources[index], targets[index], { overwrite: false });
          else await vscode.workspace.fs.copy(sources[index], targets[index], { overwrite: false });
          affected.add(parentUri(sources[index]).path);
          created.push(targets[index].path);
        }
        affected.add(parent.path);
      } else if (operation === 'shortcut') {
        for (const source of distinctSources(message.paths)) {
          const commandIndex = operationCommands.length;
          operationCommands.push(displayComment(`创建符号链接：${source.path}`));
          const target = await createSymbolicShortcut(source, (candidate) => {
            operationCommands[commandIndex] = fileCommand(`ln -s -- ${shellQuote(source.path)} ${shellQuote(candidate.path)}`, `创建符号链接 ${source.path} → ${candidate.path}`);
          });
          created.push(target.path);
        }
      } else throw new Error(`不支持的文件操作：${operation}`);
      result = { type: 'operationResult', requestId: message.requestId, success: true, ok: true, operation, paths: created, affectedPaths: [...affected] };
    } catch (error) {
      result = { type: 'operationResult', requestId: message.requestId, success: false, ok: false, operation, error: errorText(error), affectedPaths: [...affected] };
      output.appendLine(`File operation ${operation} failed: ${result.error}`);
      await vscode.window.showWarningMessage(`文件操作失败：${result.error}`);
    }
    // Mutation success is acknowledged before refreshing. A failed refresh must
    // not report a completed file operation as failed or encourage repeating it.
    await send(targetPanel, result);
    await sendOperationCommand(targetPanel, commandText(), result.success ? 'success' : 'error', result.error ? `${result.error}${created.length ? `（已有 ${created.length} 项完成。）` : ''}` : linuxCommandsAvailable() ? 'Linux 等效命令，仅供参考；文件操作通过 VS Code / Node.js 文件系统接口完成。' : '通过 VS Code / Node.js 文件系统接口完成。');
    for (const directoryPath of affected) await inspectRemoteDirectory(targetPanel, directoryPath);
    return result;
  }

  async function createCommandShortcut(targetPanel) {
    const commands = (await vscode.commands.getCommands(true)).filter((command) => typeof command === 'string' && !command.startsWith('_')).sort();
    const picked = await vscode.window.showQuickPick(commands, { title: '创建 VS Code 命令快捷方式', placeHolder: '搜索要放到桌面的 VS Code 命令' });
    const command = typeof picked === 'string' ? picked : picked?.label;
    if (!command) { await sendOperationCommand(targetPanel, displayComment('创建 VS Code 命令快捷方式'), 'cancelled'); return; }
    const label = await vscode.window.showInputBox({ title: '命令快捷方式名称', value: command, validateInput: (value) => value.trim() ? undefined : '请输入名称。' });
    if (!label?.trim()) { await sendOperationCommand(targetPanel, displayComment('创建 VS Code 命令快捷方式'), 'cancelled'); return; }
    const shortcut = { id: `command-${crypto.randomUUID()}`, kind: 'command', command, label: label.trim() };
    const config = await queueConfigWrite((current) => ({ ...current, shortcuts: [...(current.shortcuts || []), shortcut] }));
    await send(targetPanel, { type: 'configUpdated', config });
    await sendOperationCommand(targetPanel, displayComment(`创建 VS Code 命令快捷方式：${label.trim()} → ${command}`));
  }

  async function handleMessage(message, targetPanel = panel) {
    if (!message || typeof message !== 'object') return;
    try {
      if (message.type === 'ready') {
        ready = true;
        readyCount += 1;
        await settingsQueue;
        sessionSettings = extensionSettings();
        output.appendLine(`Webview ready: ${isRemoteWorkspace() ? 'remote workspace' : 'local demo'}.`);
        await sendExtensionSettings(targetPanel);
        await sendServerInfo(targetPanel);
        initialization = inspectRemoteDesktop().catch((error) => ({ status: 'error', message: `读取远程桌面失败：${errorText(error)}` }));
        remoteState = await initialization;
        initialization = undefined;
        await send(targetPanel, { type: 'remoteState', ...remoteState });
      } else if (message.type === 'getServerInfo') {
        await sendServerInfo(targetPanel);
      } else if (message.type === 'getExtensionSettings') {
        await sendExtensionSettings(targetPanel, message.requestId);
      } else if (message.type === 'saveExtensionSettings') {
        await saveExtensionSettings(message, targetPanel);
      } else if (message.type === 'refreshRemote') {
        await refreshRemote(message, targetPanel);
      } else if (message.type === 'openResource') {
        await openResource(message, targetPanel);
      } else if (message.type === 'fileOperation') {
        await fileOperation(message, targetPanel);
      } else if (message.type === 'listRemoteFolder' || message.type === 'readDirectory') {
        if (initialization) await initialization;
        const interaction = ['navigate', 'refresh'].includes(message.intent) ? message.intent : undefined;
        await inspectRemoteDirectory(targetPanel, message.path, message.requestId, interaction);
      } else if (message.type === 'saveDesktopConfig') {
        const patch = message.config || {};
        const config = await queueConfigWrite((current) => {
          const next = { ...current };
          if (patch.positions !== undefined) next.positions = patch.positions;
          if (patch.viewMode !== undefined) next.viewMode = patch.viewMode;
          if (patch.wallpaper !== undefined) next.wallpaper = patch.wallpaper;
          if (patch.showHiddenFiles !== undefined) next.showHiddenFiles = patch.showHiddenFiles;
          return next;
        });
        await send(targetPanel, { type: 'configSaved', ok: true, requestId: message.requestId, config });
      } else if (message.type === 'createCommandShortcut') {
        await createCommandShortcut(targetPanel);
      } else if (message.type === 'renameCommandShortcut' && typeof message.id === 'string') {
        const label = validateName(message.label);
        const config = await queueConfigWrite((current) => ({ ...current, shortcuts: (current.shortcuts || []).map((shortcut) => shortcut.id === message.id ? { ...shortcut, label } : shortcut) }));
        await send(targetPanel, { type: 'configUpdated', config });
        await sendOperationCommand(targetPanel, displayComment(`重命名 VS Code 命令快捷方式：${label}`));
      } else if (message.type === 'deleteCommandShortcut' && typeof message.id === 'string') {
        const config = await queueConfigWrite((current) => ({ ...current, shortcuts: (current.shortcuts || []).filter((shortcut) => shortcut.id !== message.id) }));
        await send(targetPanel, { type: 'configUpdated', config });
        await sendOperationCommand(targetPanel, displayComment('删除 VS Code 命令快捷方式'));
      } else if (message.type === 'pinApp') {
        const requested = message.app || message;
        const app = validatePinnedApp({ id: requested.id || `pinned-${requested.program}`, label: requested.label || { vim: 'Vim', htop: 'htop', shell: '终端' }[requested.program], program: requested.program });
        const config = await queueConfigWrite((current) => ({ ...current, pinnedApps: [...(current.pinnedApps || []).filter((item) => item.id !== app.id && item.program !== app.program), app] }));
        await send(targetPanel, { type: 'configUpdated', config });
        await sendOperationCommand(targetPanel, displayComment(`固定到任务栏：${app.label}`));
      } else if (message.type === 'unpinApp') {
        if (typeof message.id !== 'string' || !message.id) throw new Error('请选择需要取消固定的程序。');
        const config = await queueConfigWrite((current) => ({ ...current, pinnedApps: (current.pinnedApps || []).filter((app) => app.id !== message.id) }));
        await send(targetPanel, { type: 'configUpdated', config });
        await sendOperationCommand(targetPanel, displayComment('取消任务栏固定'));
      } else if (message.type === 'toggleFullscreen') {
        const request = fullscreenQueue.catch(() => {}).then(toggleFullscreen);
        fullscreenQueue = request;
        await request;
        const detail = '已切换全屏视图，禅模式使用不居中布局；再次点击全屏图标或按两次 Escape 退出。系统全屏遵循 zenMode.fullScreen 设置。';
        await send(targetPanel, { type: 'fullscreenResult', ok: true, message: detail });
        await sendOperationCommand(targetPanel, displayComment('VS Code：切换禅模式 / 全屏视图'), 'success', detail);
      } else if (message.type === 'showInfo' && typeof message.text === 'string') {
        await vscode.window.showInformationMessage(message.text.slice(0, 1000));
      } else if (['openTerminal', 'terminalInput', 'terminalResize', 'terminalClose'].includes(message.type)) {
        if (initialization) await initialization;
        if (message.type === 'openTerminal') {
          if (!pendingTerminalCommands.has(targetPanel)) pendingTerminalCommands.set(targetPanel, new Map());
          pendingTerminalCommands.get(targetPanel).set(message.id ?? message.terminalId, message);
        }
        try { await getTerminalManager().handleMessage(message, targetPanel); }
        finally {
          if (message.type === 'openTerminal') pendingTerminalCommands.get(targetPanel)?.delete(message.id ?? message.terminalId);
        }
      } else if (message.type === 'executeCommand' && typeof message.command === 'string') {
        if (!vscode.workspace.isTrusted) throw new Error('请先信任当前工作区，再运行命令快捷方式。');
        if (!desktopConfig.shortcuts?.some((shortcut) => shortcut.kind === 'command' && shortcut.command === message.command)) throw new Error('此命令不是已保存的桌面快捷方式。');
        await vscode.commands.executeCommand(message.command);
        await sendOperationCommand(targetPanel, displayComment(`VS Code 命令：${message.command}`));
      }
    } catch (error) {
      const text = errorText(error);
      output.appendLine(`Message ${message.type} failed: ${text}`);
      if (message.type === 'saveDesktopConfig') await send(targetPanel, { type: 'configSaved', ok: false, requestId: message.requestId, error: text });
      else await send(targetPanel, { type: 'desktopError', error: text, requestId: message.requestId });
      if (['createCommandShortcut', 'renameCommandShortcut', 'deleteCommandShortcut', 'pinApp', 'unpinApp', 'executeCommand', 'toggleFullscreen', 'openTerminal'].includes(message.type)) {
        await sendOperationCommand(targetPanel, displayComment(`VS Code 操作：${message.type}`), 'error', text);
      }
      if (message.type === 'toggleFullscreen') await send(targetPanel, { type: 'fullscreenResult', ok: false, message: text });
      await vscode.window.showWarningMessage(text);
    }
  }

  async function toggleFullscreen() {
    const config = vscode.workspace.getConfiguration('zenMode');
    const centered = config.get('centerLayout', true);
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const inspected = config.inspect('centerLayout');
    const original = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
    let changed = false;
    try {
      // A true -> false configuration event after toggling also clears a
      // manually centered editor on entry. Keep false for future Zen sessions,
      // as chosen by the user. Only toggle Zen once: exit + enter races the
      // asynchronous native fullscreen transition.
      if (!centered) { await config.update('centerLayout', true, target); changed = true; }
      await vscode.commands.executeCommand('workbench.action.toggleZenMode');
      await config.update('centerLayout', false, target);
    } catch (error) {
      if (changed) {
        try { await config.update('centerLayout', original, target); }
        catch (restoreError) { output.appendLine(`Could not restore zenMode.centerLayout: ${errorText(restoreError)}`); }
      }
      throw error;
    }
  }

  function closeDemo() { panel?.dispose(); }

  function openDemo() {
    if (panel) { panel.reveal(vscode.ViewColumn.One); return; }
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    panel = vscode.window.createWebviewPanel('remoteDesktop', 'Remote Desktop', vscode.ViewColumn.One, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot]
    });
    const currentPanel = panel;
    ready = false;
    const receiver = currentPanel.webview.onDidReceiveMessage((message) => handleMessage(message, currentPanel));
    currentPanel.onDidDispose(() => {
      receiver.dispose();
      settingsPanels.delete(currentPanel);
      terminalManager?.disposePanel(currentPanel);
      if (panel === currentPanel) { panel = undefined; ready = false; sessionSettings = undefined; }
    });
    try {
      const template = fs.readFileSync(vscode.Uri.joinPath(mediaRoot, 'desktop.html').fsPath, 'utf8');
      const replacements = {
        cspSource: currentPanel.webview.cspSource,
        nonce: crypto.randomBytes(24).toString('hex'),
        styleUri: currentPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'desktop.css')).toString(),
        iconsUri: currentPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'lucide.js')).toString(),
        terminalStyleUri: currentPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'xterm.css')).toString(),
        terminalScriptUri: currentPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'xterm.js')).toString(),
        terminalFitUri: currentPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'xterm-addon-fit.js')).toString(),
        scriptUri: currentPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'desktop.js')).toString()
      };
      currentPanel.webview.html = template.replace(/\{\{(cspSource|nonce|styleUri|scriptUri|iconsUri|terminalStyleUri|terminalScriptUri|terminalFitUri)\}\}/g, (_, key) => replacements[key]);
    } catch (error) { closeDemo(); output.appendLine(errorText(error)); throw error; }
  }

  const settingsListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('remoteDesktopDemo')) {
      // Publish after the current transaction, including rollback, has settled.
      void settingsQueue.then(() => Promise.all([...settingsPanels].map((target) => sendExtensionSettings(target)))).catch((error) => output.appendLine(`Extension settings notification failed: ${errorText(error)}`));
    }
  });
  context.subscriptions.push(output, vscode.commands.registerCommand('remoteDesktop.open', openDemo), vscode.commands.registerCommand('remoteDesktop.openDemo', openDemo), settingsListener, { dispose: () => { closeDemo(); settingsPanels.clear(); terminalManager?.dispose(); } });
  if (vscode.workspace.getConfiguration('remoteDesktopDemo').get('openOnStartup', false)) openDemo();
  return {
    getDiagnostics: () => ({ openPanels: panel ? 1 : 0, ready, readyCount, openRequests: [...openRequests], remoteState: { ...remoteState }, nativeRemoteHost: nativeRemoteHost(), configPath: configUri?.path, configError }),
    closeDemo, openResource, handleMessage, fileOperation, refreshRemote, readRemoteDirectory
  };
}

function deactivate() {}

module.exports = { activate, deactivate };
