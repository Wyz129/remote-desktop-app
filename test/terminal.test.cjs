'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTerminalManager, ptyCandidates, loadRuntimePty } = require('../remote-terminal.js');

function fixture(overrides = {}) {
  const root = path.resolve('test-runtime');
  const cwd = path.join(root, 'Desktop');
  const bin = path.join(root, 'bin');
  const shell = path.join(bin, process.platform === 'win32' ? 'cmd.exe' : 'bash');
  const executablePaths = new Set([shell, path.join(bin, 'vim'), path.join(bin, 'htop')]);
  const messages = [];
  const spawned = [];
  const panel = {};
  let trusted = true;
  let native = true;
  const fileSystem = {
    statSync(value) {
      if (value !== cwd && !executablePaths.has(value)) throw new Error('ENOENT');
      return { isDirectory: () => value === cwd, isFile: () => executablePaths.has(value) };
    },
    accessSync(value) { if (!executablePaths.has(value)) throw new Error('EACCES'); }
  };
  const options = {
    send: async (target, message) => { messages.push({ target, ...message }); },
    resolveCwd: () => cwd,
    isTrusted: () => trusted,
    isNativeHost: () => native,
    runtime: { platform: process.platform, env: { PATH: bin, SHELL: shell, ComSpec: shell, ELECTRON_RUN_AS_NODE: '1' } },
    fs: fileSystem,
    loadPty: () => ({ spawn(file, args, settings) {
      const listeners = { data: null, exit: null };
      const pty = {
        pid: 42, file, args, settings, writes: [], sizes: [], killed: 0, paused: 0, resumed: 0,
        write(data) { this.writes.push(data); }, resize(cols, rows) { this.sizes.push([cols, rows]); }, kill() { this.killed += 1; },
        pause() { this.paused += 1; }, resume() { this.resumed += 1; },
        onData(listener) { listeners.data = listener; return { dispose: () => { listeners.data = null; } }; },
        onExit(listener) { listeners.exit = listener; return { dispose: () => { listeners.exit = null; } }; },
        data(value) { listeners.data?.(value); }, exit(value) { listeners.exit?.(value); },
        get listenerCount() { return Number(Boolean(listeners.data)) + Number(Boolean(listeners.exit)); }
      };
      spawned.push(pty);
      return pty;
    } }),
    ...overrides
  };
  const manager = createTerminalManager(options);
  return {
    manager, panel, cwd, bin, shell, messages, spawned, options, executablePaths,
    setTrusted(value) { trusted = value; }, setNative(value) { native = value; },
    send: (message, target = panel) => manager.handleMessage({ id: 'terminal-1', ...message }, target)
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('spawns real PTY interface, serializes ANSI output, accepts input and resize, then reports exit', async () => {
  const f = fixture();
  await f.send({ type: 'openTerminal', program: 'vim', cols: 100, rows: 35 });
  const pty = f.spawned[0];
  assert.equal(pty.file, path.join(f.bin, 'vim'));
  assert.deepEqual(pty.args, []);
  assert.equal(pty.settings.cwd, f.cwd);
  assert.equal(pty.settings.name, 'xterm-256color');
  assert.equal(pty.settings.env.TERM, 'xterm-256color');
  assert.equal(pty.settings.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.deepEqual([pty.settings.cols, pty.settings.rows], [100, 35]);
  pty.data('\x1b[2Jvim');
  await f.send({ type: 'terminalInput', data: 'ihello\x1b' });
  await f.send({ type: 'terminalResize', cols: 110, rows: 40 });
  pty.exit({ exitCode: 0, signal: 0 });
  await settle();
  assert.deepEqual(pty.writes, ['ihello\x1b']);
  assert.deepEqual(pty.sizes, [[110, 40]]);
  assert.deepEqual(f.messages.map((m) => m.type), ['terminalOpened', 'terminalData', 'terminalExit']);
  assert.equal(f.messages[1].data, '\x1b[2Jvim');
  assert.equal(f.messages[2].exitCode, 0);
  assert.equal(pty.listenerCount, 0);
  assert.equal(pty.killed, 0);
});

test('requires workspace trust and the actual workspace extension host before loading PTY', async () => {
  const f = fixture();
  f.setTrusted(false);
  await f.send({ type: 'openTerminal' });
  assert.match(f.messages.at(-1).error, /信任/);
  f.setTrusted(true); f.setNative(false);
  await f.send({ type: 'openTerminal' });
  assert.match(f.messages.at(-1).error, /SSH.*扩展主机/);
  assert.equal(f.spawned.length, 0);
});

test('program selection uses executable argv and rejects arbitrary commands or absent programs', async () => {
  const f = fixture();
  await f.send({ type: 'openTerminal', program: 'vim; rm -rf /' });
  assert.match(f.messages.at(-1).error, /不支持/);
  f.executablePaths.delete(path.join(f.bin, 'htop'));
  await f.send({ type: 'openTerminal', program: 'htop' });
  assert.match(f.messages.at(-1).error, /未安装 htop/);
  await f.send({ type: 'openTerminal', program: 'shell' });
  assert.equal(f.spawned[0].file, f.shell);
  assert.deepEqual(f.spawned[0].args, process.platform === 'win32' ? [] : ['-i']);
  f.manager.dispose();
});

test('sessions are isolated by panel; explicit close kills only its PTY and permits id reuse', async () => {
  const f = fixture();
  const other = {};
  await f.send({ type: 'openTerminal' });
  await f.send({ type: 'terminalInput', data: 'unauthorized' }, other);
  assert.match(f.messages.at(-1).error, /会话已结束/);
  assert.deepEqual(f.spawned[0].writes, []);
  await f.send({ type: 'openTerminal' }, other);
  await f.send({ type: 'terminalClose' });
  assert.equal(f.spawned[0].killed, 1);
  assert.equal(f.spawned[1].killed, 0);
  await f.send({ type: 'openTerminal' });
  f.manager.disposePanel(other);
  assert.equal(f.spawned[1].killed, 1);
  f.manager.dispose();
  assert.equal(f.spawned[2].killed, 1);
  assert.ok(f.spawned.every((pty) => pty.listenerCount === 0));
});

test('duplicate ids, terminal count and input limits prevent leaking or flooding PTYs', async () => {
  const f = fixture();
  await f.send({ type: 'openTerminal' });
  await f.send({ type: 'openTerminal' });
  assert.equal(f.spawned.length, 1);
  assert.match(f.messages.at(-1).error, /已经存在/);
  await f.send({ type: 'terminalInput', data: '文'.repeat(22000) });
  assert.match(f.messages.at(-1).error, /64 KB/);
  assert.deepEqual(f.spawned[0].writes, []);
  for (let i = 2; i <= 9; i += 1) await f.send({ type: 'openTerminal', id: `terminal-${i}` });
  assert.equal(f.spawned.length, 8);
  assert.match(f.messages.at(-1).error, /数量已达上限/);
  await f.send({ type: 'terminalResize', cols: 9000, rows: -10 });
  assert.deepEqual(f.spawned[0].sizes, [[500, 1]]);
  f.manager.dispose();
});

test('closing a panel while cwd resolves cannot start an orphan PTY', async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const f = fixture({ resolveCwd: () => pending });
  const open = f.send({ type: 'openTerminal' });
  f.manager.disposePanel(f.panel);
  resolve(f.cwd);
  await open;
  assert.equal(f.spawned.length, 0);
  assert.equal(f.messages.length, 0);
});

test('closing a pending terminal cancels spawn and its id cannot revive the cancelled request', async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const f = fixture({ resolveCwd: () => pending });
  const open = f.send({ type: 'openTerminal' });
  await f.send({ type: 'terminalClose' });
  resolve(f.cwd);
  await open;
  assert.equal(f.spawned.length, 0);
  assert.equal(f.messages.length, 0);
  await f.send({ type: 'openTerminal' });
  assert.equal(f.spawned.length, 0);
  assert.match(f.messages.at(-1).error, /启动已取消/);
  await f.send({ type: 'openTerminal', id: 'terminal-2' });
  assert.equal(f.spawned.length, 1);
  assert.equal(f.messages.at(-1).id, 'terminal-2');
  f.manager.dispose();
});

test('cancelled pending launches ignore late cwd failures and pending launches reserve slots', async () => {
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  const f = fixture({ resolveCwd: () => pending });
  const opens = [];
  for (let i = 1; i <= 8; i += 1) opens.push(f.send({ type: 'openTerminal', id: `terminal-${i}` }));
  await f.send({ type: 'openTerminal' });
  assert.match(f.messages.at(-1).error, /已经存在/);
  await f.send({ type: 'openTerminal', id: 'terminal-9' });
  assert.match(f.messages.at(-1).error, /数量已达上限/);
  const messageCount = f.messages.length;
  for (let i = 1; i <= 8; i += 1) await f.send({ type: 'terminalClose', id: `terminal-${i}` });
  reject(new Error('late ENOENT'));
  await Promise.all(opens);
  assert.equal(f.spawned.length, 0);
  assert.equal(f.messages.length, messageCount);
  f.manager.dispose();
});

test('missing native PTY produces an explicit error instead of a fake terminal', async () => {
  const f = fixture({ loadPty: () => { throw new Error('PTY native module ABI mismatch'); } });
  await f.send({ type: 'openTerminal' });
  assert.equal(f.messages.at(-1).type, 'terminalError');
  assert.match(f.messages.at(-1).error, /PTY native module ABI mismatch/);
  assert.equal(f.spawned.length, 0);
});

test('loads PTY only from VS Code runtime roots, including Electron asar layout', () => {
  const appRoot = path.resolve('vscode-runtime', 'resources', 'app');
  const runtime = { execPath: path.resolve('vscode-runtime', 'node'), argv: [] };
  const expected = path.join(appRoot, 'node_modules.asar', 'node-pty');
  const candidates = ptyCandidates({ appRoot, runtime, fs: { existsSync: () => false } });
  assert.ok(candidates.includes(expected));
  assert.ok(candidates.every((candidate) => path.isAbsolute(candidate)));
  const calls = [];
  const pty = { spawn() {} };
  const result = loadRuntimePty({ appRoot, runtime, requireModule: (candidate) => {
    calls.push(candidate);
    if (candidate === expected) return pty;
    throw new Error('MODULE_NOT_FOUND');
  } });
  assert.equal(result, pty);
  assert.ok(calls.every((candidate) => candidates.includes(candidate)));
  assert.throws(() => loadRuntimePty({ appRoot, runtime, requireModule: () => { throw new Error('missing'); } }), /无法加载.*PTY/);
});
