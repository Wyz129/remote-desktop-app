'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_SESSIONS = 12;
const MAX_PANEL_SESSIONS = 8;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const PROGRAMS = new Set(['shell', 'vim', 'htop']);

function errorText(error) { return error instanceof Error ? error.message : String(error); }

// Load only from this VS Code runtime, never from the workspace or NODE_PATH.
function ptyCandidates(options = {}) {
  const runtime = options.runtime || process;
  const fileSystem = options.fs || fs;
  const roots = new Set();
  const add = (value) => { if (typeof value === 'string' && path.isAbsolute(value)) roots.add(path.normalize(value)); };
  add(options.appRoot);
  add(path.dirname(runtime.execPath));
  const entryPoints = [options.mainFilename || require.main?.filename, runtime.argv?.[1]];
  for (const entry of entryPoints) {
    if (!entry || !path.isAbsolute(entry)) continue;
    let directory = path.dirname(entry);
    for (let depth = 0; depth < 7; depth += 1) {
      if (fileSystem.existsSync(path.join(directory, 'product.json'))) { add(directory); break; }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return [...roots].flatMap((root) => ['node_modules', 'node_modules.asar', 'node_modules.asar.unpacked']
    .flatMap((modules) => ['node-pty', '@vscode/node-pty'].map((name) => path.join(root, modules, name))));
}

function loadRuntimePty(options = {}) {
  const load = options.requireModule || require;
  const failures = [];
  for (const candidate of ptyCandidates(options)) {
    try {
      const loaded = load(candidate);
      if (typeof loaded?.spawn === 'function') return loaded;
      failures.push(`${candidate}: missing spawn`);
    } catch (error) { failures.push(`${candidate}: ${errorText(error)}`); }
  }
  options.log?.(`Desktop PTY resolution failed:\n${failures.join('\n')}`);
  throw new Error('无法加载当前 VS Code 扩展主机的 PTY 模块。请确认插件安装在 SSH 服务器端，并更新 VS Code / VS Code Server 后重试；详细原因见 Remote Desktop 输出。');
}

function dimensions(message) {
  return {
    cols: Math.max(2, Math.min(500, Number.isFinite(message.cols) ? Math.floor(message.cols) : 80)),
    rows: Math.max(1, Math.min(200, Number.isFinite(message.rows) ? Math.floor(message.rows) : 24))
  };
}

function resolveProgram(program, runtime, fileSystem) {
  const env = runtime.env || {};
  const windows = runtime.platform === 'win32';
  const delimiter = windows ? ';' : ':';
  const executable = (candidate) => {
    try {
      if (!fileSystem.statSync(candidate).isFile()) return false;
      fileSystem.accessSync(candidate, windows ? fs.constants.F_OK : fs.constants.X_OK);
      return true;
    } catch { return false; }
  };
  if (program === 'shell') {
    const candidates = windows ? [env.ComSpec, 'C:\\Windows\\System32\\cmd.exe'] : [env.SHELL, '/bin/bash', '/bin/sh'];
    const shell = candidates.find((candidate) => candidate && path.isAbsolute(candidate) && executable(candidate));
    if (!shell) throw new Error('服务器上没有找到可用的交互式 shell。');
    return { file: shell, args: windows ? [] : ['-i'] };
  }
  const suffixes = windows ? ['', '.exe'] : [''];
  // Ignore relative PATH entries: a workspace file must not impersonate Vim/htop.
  const directories = (env.PATH || env.Path || '').split(delimiter).filter((directory) => path.isAbsolute(directory));
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const file = path.join(directory, `${program}${suffix}`);
      if (executable(file)) return { file, args: [] };
    }
  }
  throw new Error(`服务器未安装 ${program}，或该程序不在扩展主机的 PATH 中。请安装后重试。`);
}

function createTerminalManager(options) {
  const runtime = options.runtime || process;
  const fileSystem = options.fs || fs;
  const panels = new Map();
  const pendingOpens = new Map();
  const cancelledIds = new WeakMap();
  const closedPanels = new WeakSet();
  let ptyModule;
  let sessionCount = 0;
  let pendingCount = 0;
  let disposed = false;

  function log(error) { options.log?.(`Desktop terminal: ${errorText(error)}`); }
  async function send(panel, message) {
    if (disposed || closedPanels.has(panel)) return;
    try { await options.send(panel, message); } catch (error) { log(error); }
  }
  function remove(session, kill) {
    if (session.closed) return;
    session.closed = true;
    const entries = panels.get(session.panel);
    entries?.delete(session.id);
    if (!entries?.size) panels.delete(session.panel);
    sessionCount -= 1;
    for (const listener of session.listeners) listener?.dispose?.();
    if (kill) { try { session.pty.kill(); } catch (error) { log(error); } }
  }
  function enqueue(session, message) {
    const bytes = message.type === 'terminalData' ? Buffer.byteLength(message.data) : 0;
    session.queuedBytes += bytes;
    if (session.queuedBytes > 512 * 1024 && !session.paused && session.pty.pause) {
      session.pty.pause();
      session.paused = true;
    }
    if (session.queuedBytes > MAX_QUEUED_BYTES) {
      remove(session, true);
      void send(session.panel, { type: 'terminalError', id: session.id, error: '终端输出超过缓冲区限制，会话已关闭。' });
      return;
    }
    session.delivery = session.delivery.then(async () => {
      await send(session.panel, message);
      session.queuedBytes -= bytes;
      if (session.paused && session.queuedBytes < 128 * 1024 && !session.closed) {
        session.pty.resume?.();
        session.paused = false;
      }
    }).catch(log);
  }

  function assertAllowed() {
    if (disposed) throw new Error('桌面终端管理器已关闭。');
    if (!options.isTrusted()) throw new Error('请先信任当前工作区，再打开桌面终端。');
    if (!options.isNativeHost()) throw new Error('桌面终端必须运行在当前 SSH 服务器的扩展主机中，不能使用本机终端代替远程终端。');
  }

  function clearPending(panel, id, token) {
    const entries = pendingOpens.get(panel);
    if (!token || entries?.get(id) !== token) return;
    entries.delete(id);
    pendingCount -= 1;
    if (!entries.size) pendingOpens.delete(panel);
  }

  async function handleMessage(message, panel) {
    const id = message.id ?? message.terminalId;
    let opening;
    try {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('终端会话标识无效。');
      if (message.type === 'terminalClose') {
        const pending = pendingOpens.get(panel)?.get(id);
        if (pending) {
          pending.cancelled = true;
          if (!cancelledIds.has(panel)) cancelledIds.set(panel, new Set());
          cancelledIds.get(panel).add(id);
          clearPending(panel, id, pending);
        }
        const session = panels.get(panel)?.get(id);
        if (session) remove(session, true);
        return;
      }
      assertAllowed();
      if (closedPanels.has(panel)) throw new Error('桌面窗口已关闭。');
      if (message.type === 'openTerminal') {
        if (!PROGRAMS.has(message.program || 'shell')) throw new Error('不支持的终端程序。');
        if (message.filePath !== undefined && (message.program !== 'vim' || typeof message.filePath !== 'string' || !message.filePath || /[\x00-\x1f\x7f]/.test(message.filePath))) throw new Error('文件路径只支持通过 Vim 打开，且必须是有效路径。');
        if (cancelledIds.get(panel)?.has(id)) throw new Error('该终端启动已取消，请使用新的会话标识。');
        if (panels.get(panel)?.has(id) || pendingOpens.get(panel)?.has(id)) throw new Error('该终端会话已经存在。');
        if (sessionCount + pendingCount >= MAX_SESSIONS || (panels.get(panel)?.size || 0) + (pendingOpens.get(panel)?.size || 0) >= MAX_PANEL_SESSIONS) throw new Error('桌面终端数量已达上限，请关闭部分窗口后重试。');
        opening = { cancelled: false };
        if (!pendingOpens.has(panel)) pendingOpens.set(panel, new Map());
        pendingOpens.get(panel).set(id, opening);
        pendingCount += 1;
        const cwd = await options.resolveCwd(message.path);
        if (opening.cancelled || closedPanels.has(panel)) return;
        const filePath = message.filePath === undefined ? undefined : await options.resolveFile(message.filePath);
        // Closing the terminal or its entire panel while resolving must cancel spawn.
        if (opening.cancelled) return;
        clearPending(panel, id, opening);
        assertAllowed();
        if (closedPanels.has(panel)) throw new Error('桌面窗口已关闭。');
        if (panels.get(panel)?.has(id)) throw new Error('该终端会话已经存在。');
        if (sessionCount >= MAX_SESSIONS || (panels.get(panel)?.size || 0) >= MAX_PANEL_SESSIONS) throw new Error('桌面终端数量已达上限，请关闭部分窗口后重试。');
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fileSystem.statSync(cwd).isDirectory()) throw new Error('终端工作目录不存在或不是文件夹。');
        const program = message.program || 'shell';
        const executable = resolveProgram(program, runtime, fileSystem);
        if (filePath !== undefined) {
          if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || /[\x00-\x1f\x7f]/.test(filePath) || !fileSystem.statSync(filePath).isFile()) throw new Error('Vim 目标不存在或不是普通文件。');
          // Pass the validated filename as one argv item, never as shell text.
          executable.args = ['--', filePath];
        }
        if (!ptyModule) ptyModule = options.loadPty ? options.loadPty() : loadRuntimePty({ appRoot: options.appRoot, runtime, log: options.log });
        const env = { ...runtime.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
        delete env.ELECTRON_RUN_AS_NODE;
        const pty = ptyModule.spawn(executable.file, executable.args, { ...dimensions(message), name: 'xterm-256color', cwd, env });
        const session = { id, panel, pty, program, listeners: [], closed: false, delivery: Promise.resolve(), queuedBytes: 0, paused: false };
        if (!panels.has(panel)) panels.set(panel, new Map());
        panels.get(panel).set(id, session);
        sessionCount += 1;
        enqueue(session, { type: 'terminalOpened', id, program, cwd, ...(filePath !== undefined ? { filePath } : {}), pid: pty.pid });
        session.listeners.push(pty.onData((data) => {
          if (!session.closed) enqueue(session, { type: 'terminalData', id, data });
        }));
        session.listeners.push(pty.onExit(({ exitCode, signal }) => {
          if (session.closed) return;
          enqueue(session, { type: 'terminalExit', id, exitCode, signal });
          remove(session, false);
        }));
        await session.delivery;
        return;
      }
      const session = panels.get(panel)?.get(id);
      if (!session || session.closed) throw new Error('终端会话已结束，请重新打开。');
      if (message.type === 'terminalInput') {
        if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > MAX_INPUT_BYTES) throw new Error('单次终端输入不能超过 64 KB。');
        session.pty.write(message.data);
      } else if (message.type === 'terminalResize') {
        const { cols, rows } = dimensions(message);
        session.pty.resize(cols, rows);
      }
    } catch (error) {
      if (opening?.cancelled) return;
      log(error);
      await send(panel, { type: 'terminalError', id: typeof id === 'string' ? id : '', error: errorText(error) });
    } finally {
      clearPending(panel, id, opening);
    }
  }

  function disposePanel(panel) {
    closedPanels.add(panel);
    for (const [id, pending] of [...(pendingOpens.get(panel)?.entries() || [])]) {
      pending.cancelled = true;
      clearPending(panel, id, pending);
    }
    for (const session of [...(panels.get(panel)?.values() || [])]) remove(session, true);
  }
  function dispose() {
    if (disposed) return;
    for (const panel of new Set([...panels.keys(), ...pendingOpens.keys()])) disposePanel(panel);
    disposed = true;
  }
  return { handleMessage, disposePanel, dispose };
}

module.exports = { createTerminalManager, loadRuntimePty, ptyCandidates, resolveProgram };
