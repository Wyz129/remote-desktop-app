'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class TestUri {
  constructor(value) {
    const url = new URL(value);
    this.scheme = url.protocol.slice(0, -1);
    this.authority = url.host;
    this.path = decodeURIComponent(url.pathname);
    this.fsPath = this.path;
  }
  static parse(value) { return new TestUri(value); }
  static file(value) { return new TestUri(`file://${value}`); }
  static joinPath(uri, ...parts) { return uri.with({ path: path.posix.join(uri.path, ...parts) }); }
  with(changes) {
    const result = new TestUri(this.toString());
    Object.assign(result, changes);
    result.fsPath = result.path;
    return result;
  }
  toString() { return `${this.scheme}://${this.authority}${this.path.split('/').map(encodeURIComponent).join('/')}`; }
}

function fixture(options = {}) {
  const home = '/srv/test-user';
  const desktop = `${home}/Desktop`;
  const nodes = new Map();
  const calls = [];
  const messages = [];
  const warnings = [];
  const inputs = [];
  const infoChoices = [];
  const deleteChoices = [];
  let failRead;
  const key = uri => typeof uri === 'string' ? uri : uri.path;
  const notFound = value => Object.assign(new Error(`Missing: ${key(value)}`), { code: 'FileNotFound' });
  function directory(value) { nodes.set(value, { type: 2 }); }
  function file(value, content) { nodes.set(value, { type: 1, bytes: Buffer.from(content) }); }
  directory(home); directory(desktop); directory(`${desktop}/folder`);
  file(`${desktop}/a.txt`, 'alpha');
  file(`${desktop}/b.txt`, 'beta');
  file(`${desktop}/.remote-desktop.json`, JSON.stringify({ version: 1, viewMode: 'icons', positions: {}, shortcuts: [], custom: 'preserved' }));
  function get(value) { const item = nodes.get(key(value)); if (!item) throw notFound(value); return item; }
  const provider = {
    async stat(uri) {
      let item = get(uri);
      if (item.type === 64) { const target = nodes.get(item.target); if (!target) throw notFound(item.target); item = { ...item, type: 64 | target.type, bytes: target.bytes }; }
      return { type: item.type, size: item.bytes?.length || 0, mtime: 1, ctime: 1 };
    },
    async readDirectory(uri) {
      calls.push(['readDirectory', key(uri)]);
      if (key(uri) === failRead) throw Object.assign(new Error('Permission denied'), { code: 'NoPermissions' });
      get(uri);
      return [...nodes].filter(([value]) => path.posix.dirname(value) === key(uri)).map(([value, item]) => [path.posix.basename(value), item.type]);
    },
    async readFile(uri) { calls.push(['readFile', key(uri)]); return get(uri).bytes; },
    async writeFile(uri, bytes) { calls.push(['writeFile', key(uri)]); file(key(uri), bytes); },
    async createDirectory(uri) { calls.push(['mkdir', key(uri)]); directory(key(uri)); },
    async copy(source, destination, config) {
      calls.push(['copy', key(source), key(destination)]);
      if (nodes.has(key(destination)) && !config?.overwrite) throw new Error('File exists');
      const item = get(source);
      nodes.set(key(destination), { ...item });
      if (item.type === 2) {
        for (const [name, child] of [...nodes]) if (name.startsWith(`${key(source)}/`)) nodes.set(`${key(destination)}${name.slice(key(source).length)}`, { ...child });
      }
    },
    async rename(source, destination, config) {
      calls.push(['rename', key(source), key(destination)]);
      if (nodes.has(key(destination)) && !config?.overwrite) throw new Error('File exists');
      nodes.set(key(destination), get(source)); nodes.delete(key(source));
    },
    async delete(uri, config) {
      calls.push(['delete', key(uri), config]); get(uri); nodes.delete(key(uri));
      if (config?.recursive) for (const name of [...nodes.keys()]) if (name.startsWith(`${key(uri)}/`)) nodes.delete(name);
    }
  };
  const native = {
    ...fs,
    promises: {
      ...fs.promises,
      async lstat(value) {
        const item = get(value);
        return { isSymbolicLink: () => item.type === 64, isDirectory: () => item.type === 2, isFile: () => item.type === 1 };
      },
      async stat(value) {
        const item = get(value); const resolved = item.target ? get(item.target) : item;
        return { isDirectory: () => resolved.type === 2, isFile: () => resolved.type === 1, size: resolved.bytes?.length || 0 };
      },
      async readlink(value) { return get(value).target; },
      async symlink(target, value) {
        calls.push(['symlink', target, value]);
        if (nodes.has(value)) throw Object.assign(new Error('File exists'), { code: 'EEXIST' });
        nodes.set(value, { type: 64, target });
      },
      async writeFile(value, bytes, config) {
        if (config?.flag === 'wx' && nodes.has(value)) throw Object.assign(new Error('File exists'), { code: 'EEXIST' });
        calls.push(['writeFile', value]); file(value, bytes);
      },
      async unlink(value) { calls.push(['unlink', value]); nodes.delete(value); },
      async realpath(value) { const item = nodes.get(value); return item?.target || value; }
    }
  };
  const disposable = () => ({ dispose() {} });
  const channel = { appendLine: line => calls.push(['log', line]), show() {}, dispose() {} };
  const vscode = {
    env: { remoteName: options.local ? undefined : 'ssh-remote' },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    ExtensionKind: { UI: 1, Workspace: 2 },
    Uri: TestUri,
    FileSystemError: { FileNotFound: notFound, FileExists: () => new Error('File exists') },
    ViewColumn: { One: 1 },
    workspace: {
      isTrusted: true,
      workspaceFolders: options.noFolders ? [] : [{ uri: TestUri.parse(`${options.native || options.local ? 'file://' : 'vscode-remote://ssh-remote+test'}${home}${options.local ? '' : '/project'}`) }],
      fs: provider,
      getConfiguration: () => ({ get: (name, fallback) => name === 'remoteHome' && !options.autoHome ? home : name === 'remoteRoot' && options.local ? home : fallback }),
      onDidChangeConfiguration: disposable,
      onDidChangeWorkspaceFolders: disposable,
      createFileSystemWatcher: () => ({ onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable, dispose() {} })
    },
    window: {
      createOutputChannel: () => channel,
      showInformationMessage: async text => { calls.push(['information', text]); return infoChoices.shift(); },
      showWarningMessage: async (text, settings, ...actions) => {
        warnings.push(text); calls.push(['warning', text, settings, actions]);
        if (settings?.modal) return deleteChoices.length ? deleteChoices.shift() : '永久删除';
      },
      showErrorMessage: async text => { warnings.push(text); },
      showInputBox: async () => inputs.shift(),
      showQuickPick: async choices => options.pick || choices.find(item => (typeof item === 'string' ? item : item.label) === 'workbench.action.showCommands'),
      createTerminal: () => ({ show() {}, dispose() {} })
    },
    commands: {
      registerCommand: disposable,
      getCommands: async () => ['workbench.action.showCommands'],
      executeCommand: async (command, ...args) => { calls.push(['command', command, ...args]); if (command === 'workbench.action.files.refreshFilesExplorer' || command === options.failCommand) throw new Error('command not found'); }
    }
  };
  const module = { exports: {} };
  const context = { extensionUri: TestUri.parse(`${options.native ? 'file://' : 'vscode-remote://ssh-remote+test'}${home}/.vscode-server/extensions/remote-desktop`), extension: { extensionKind: 2 }, subscriptions: [], globalState: { get: (_, fallback) => fallback, update: async () => {} } };
  const sandbox = {
    module, exports: module.exports, Buffer, console, setTimeout, clearTimeout,
    process: { ...process, platform: options.platform || 'linux', env: { HOME: home, VSCODE_IPC_HOOK_CLI: '/tmp/test-cli' } },
    require: name => name === 'vscode' ? vscode : name === 'node:fs' ? native : name === 'node:fs/promises' ? native.promises : name === 'node:os' ? { homedir: () => home, userInfo: () => ({ username: 'test-user' }), hostname: () => 'ssh-test-host' } : name === './remote-terminal.js' ? {
      createTerminalManager: (config) => {
        calls.push(['terminalManager', config]);
        return { handleMessage: async (message, target) => {
          calls.push(['terminalMessage', message, target]);
          if (message.type === 'openTerminal' && options.terminalReply) {
            const reply = options.terminalReply === 'error'
              ? { type: 'terminalError', id: message.id, error: 'Program missing' }
              : { type: 'terminalOpened', id: message.id, program: message.program || 'shell', cwd: config.resolveCwd(message.path), pid: 123 };
            await config.send(target, reply);
          }
        }, disposePanel: (target) => calls.push(['terminalDisposePanel', target]), dispose: () => calls.push(['terminalDispose']) };
      }
    } : require(name)
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8'), sandbox, { filename: 'extension.js' });
  const api = module.exports.activate(context);
  const panel = { webview: { postMessage: async message => { messages.push(JSON.parse(JSON.stringify(message))); return true; } } };
  const send = message => api.handleMessage(message, panel);
  return { api, home, desktop, nodes, calls, messages, warnings, inputs, infoChoices, deleteChoices, file, directory, send, panel, context, setFailRead: value => { failRead = value; } };
}

test('remote refresh rereads directory and edited config, without native Explorer refresh command', async () => {
  const f = fixture();
  await f.send({ type: 'ready' });
  assert.equal(f.messages.findLast(item => item.type === 'remoteState').config.viewMode, 'icons');
  f.file(`${f.desktop}/external.txt`, 'new');
  f.file(`${f.desktop}/.remote-desktop.json`, JSON.stringify({ viewMode: 'details', shortcuts: [] }));
  await f.send({ type: 'refreshRemote' });
  const refreshed = f.messages.findLast(item => item.type === 'remoteState');
  assert.ok(refreshed.entries.some(item => item.name === 'external.txt'));
  assert.equal(refreshed.config.viewMode, 'details');
  assert.equal(f.calls.some(call => call[0] === 'command' && call[1].includes('refreshFilesExplorer')), false);
});

test('create uses supplied name, rejects overwrite, and copy/move preserve correct source state', async () => {
  const f = fixture();
  await f.send({ type: 'ready' });
  await f.send({ type: 'fileOperation', operation: 'new-folder', parent: f.desktop, name: 'chosen-name', requestId: 'create' });
  assert.ok(f.nodes.has(`${f.desktop}/chosen-name`));
  assert.equal(f.nodes.has(`${f.desktop}/新建文件夹`), false);
  await f.send({ type: 'fileOperation', operation: 'new-file', parent: f.desktop, name: 'a.txt', requestId: 'collision' });
  assert.equal(f.nodes.get(`${f.desktop}/a.txt`).bytes.toString(), 'alpha');
  assert.equal(f.messages.findLast(item => item.requestId === 'collision').success, false);
  await f.send({ type: 'fileOperation', operation: 'paste', parent: `${f.desktop}/folder`, clipboard: { mode: 'copy', paths: [`${f.desktop}/a.txt`] }, requestId: 'copy' });
  assert.equal(f.nodes.get(`${f.desktop}/folder/a.txt`).bytes.toString(), 'alpha');
  assert.ok(f.nodes.has(`${f.desktop}/a.txt`));
  await f.send({ type: 'fileOperation', operation: 'paste', parent: `${f.desktop}/folder`, clipboard: { mode: 'move', paths: [`${f.desktop}/b.txt`] }, requestId: 'move' });
  assert.ok(f.nodes.has(`${f.desktop}/folder/b.txt`));
  assert.equal(f.nodes.has(`${f.desktop}/b.txt`), false);
  assert.equal(f.messages.findLast(item => item.requestId === 'move').success, true);
});

test('read failure reports an error without replacing directory by a fake empty list', async () => {
  const f = fixture();
  await f.send({ type: 'ready' });
  f.setFailRead(`${f.desktop}/folder`);
  await f.send({ type: 'readDirectory', path: `${f.desktop}/folder`, requestId: 'denied' });
  const failed = f.messages.findLast(item => item.type === 'remoteDirectory');
  assert.ok(failed.error);
  assert.equal(failed.entries, undefined);
});

test('desktop configuration persists layout while preserving unrelated settings', async () => {
  const f = fixture();
  await f.send({ type: 'ready' });
  await f.send({ type: 'saveDesktopConfig', config: { viewMode: 'details', positions: { [`${f.desktop}/a.txt`]: { x: 112, y: 224 } } } });
  const saved = JSON.parse(f.nodes.get(`${f.desktop}/.remote-desktop.json`).bytes.toString());
  assert.equal(saved.viewMode, 'details');
  assert.equal(saved.custom, 'preserved');
  assert.deepEqual(saved.positions[`${f.desktop}/a.txt`], { x: 112, y: 224 });
  await f.send({ type: 'refreshRemote' });
  assert.deepEqual(f.messages.findLast(item => item.type === 'remoteState').config.positions, saved.positions);
});

test('send to desktop creates a symbolic link and later listings recognize it', async () => {
  const f = fixture({ native: true });
  await f.send({ type: 'ready' });
  f.file(`${f.desktop}/folder/original.txt`, 'original');
  await f.send({ type: 'fileOperation', operation: 'shortcut', paths: [`${f.desktop}/folder/original.txt`], requestId: 'link' });
  assert.equal(f.messages.findLast(item => item.requestId === 'link').success, true);
  const created = f.calls.find(call => call[0] === 'symlink');
  assert.ok(created, 'native symlink must be called, not copy');
  assert.equal(created[1], `${f.desktop}/folder/original.txt`);
  await f.send({ type: 'refreshRemote' });
  assert.ok(f.messages.findLast(item => item.type === 'remoteState').entries.some(item => item.isSymbolicLink));
  await f.send({ type: 'fileOperation', operation: 'delete', paths: [created[2]], requestId: 'unlink' });
  assert.equal(f.messages.findLast(item => item.type === 'operationResult' && item.requestId === 'unlink').success, true);
  assert.equal(f.nodes.has(created[2]), false);
  assert.equal(f.nodes.get(`${f.desktop}/folder/original.txt`).bytes.toString(), 'original');
});

test('rename and delete operate without an unrelated parent field', async () => {
  const f = fixture();
  await f.send({ type: 'ready' });
  await f.send({ type: 'fileOperation', operation: 'rename', paths: [`${f.desktop}/a.txt`], name: 'renamed.txt', requestId: 'rename' });
  assert.equal(f.messages.findLast(item => item.requestId === 'rename').success, true);
  assert.ok(f.nodes.has(`${f.desktop}/renamed.txt`));
  await f.send({ type: 'fileOperation', operation: 'delete', paths: [`${f.desktop}/renamed.txt`], requestId: 'delete' });
  assert.equal(f.messages.findLast(item => item.requestId === 'delete').success, true);
  assert.equal(f.nodes.has(`${f.desktop}/renamed.txt`), false);
});

test('invalid names and path traversal cannot write outside the remote home', async () => {
  const f = fixture();
  await f.send({ type: 'ready' });
  const writeCount = () => f.calls.filter(call => ['mkdir', 'writeFile', 'rename', 'copy', 'delete'].includes(call[0])).length;
  const initial = writeCount();
  for (const name of ['..', '../escape', 'nested/name']) {
    await f.send({ type: 'fileOperation', operation: 'new-file', parent: f.desktop, name, requestId: name });
    assert.equal(f.messages.findLast(item => item.requestId === name).success, false);
  }
  await f.send({ type: 'fileOperation', operation: 'new-file', parent: `${f.home}/../../etc`, name: 'bad', requestId: 'escape' });
  assert.equal(f.messages.findLast(item => item.requestId === 'escape').success, false);
  assert.equal(writeCount(), initial);
});

test('command shortcut is created through VS Code input and survives config reload', async () => {
  const f = fixture();
  await f.send({ type: 'ready' });
  f.inputs.push('Commands');
  await f.send({ type: 'createCommandShortcut' });
  const saved = JSON.parse(f.nodes.get(`${f.desktop}/.remote-desktop.json`).bytes.toString());
  assert.ok(saved.shortcuts.some(item => item.command === 'workbench.action.showCommands'));
  assert.equal(f.calls.some(call => call[0] === 'command' && call[1] === 'workbench.action.showCommands'), false);
  await f.send({ type: 'refreshRemote' });
  assert.ok(f.messages.findLast(item => item.type === 'remoteState').config.shortcuts.some(item => item.command === 'workbench.action.showCommands'));
  await f.send({ type: 'executeCommand', command: 'workbench.action.showCommands' });
  assert.equal(f.calls.filter(call => call[0] === 'command' && call[1] === 'workbench.action.showCommands').length, 1);
});

test('missing desktop is created only after the user chooses to create it', async () => {
  const f = fixture({ native: true, autoHome: true });
  for (const value of [...f.nodes.keys()]) if (value === f.desktop || value.startsWith(`${f.desktop}/`)) f.nodes.delete(value);
  await f.send({ type: 'ready' });
  assert.equal(f.messages.findLast(item => item.type === 'remoteState').status, 'missing');
  assert.equal(f.nodes.has(f.desktop), false);
  f.infoChoices.push('创建 Desktop 文件夹');
  await f.send({ type: 'refreshRemote' });
  assert.equal(f.messages.findLast(item => item.type === 'remoteState').status, 'ready');
  assert.ok(f.nodes.has(f.desktop));
});

test('command shortcut rename and delete persist across refreshes', async () => {
  const f = fixture();
  await f.send({ type: 'ready' });
  f.inputs.push('Commands');
  await f.send({ type: 'createCommandShortcut' });
  const id = f.messages.findLast(item => item.type === 'configUpdated').config.shortcuts[0].id;
  await f.send({ type: 'renameCommandShortcut', id, label: 'Renamed command' });
  await f.send({ type: 'refreshRemote' });
  assert.equal(f.messages.findLast(item => item.type === 'remoteState').config.shortcuts[0].label, 'Renamed command');
  await f.send({ type: 'deleteCommandShortcut', id });
  await f.send({ type: 'refreshRemote' });
  assert.deepEqual(f.messages.findLast(item => item.type === 'remoteState').config.shortcuts, []);
});

test('invalid external configuration is reported and never overwritten by a layout save', async () => {
  const f = fixture();
  await f.send({ type: 'ready' });
  f.file(`${f.desktop}/.remote-desktop.json`, '{invalid JSON');
  await f.send({ type: 'refreshRemote' });
  assert.ok(f.messages.findLast(item => item.type === 'remoteState').configError);
  await f.send({ type: 'saveDesktopConfig', config: { viewMode: 'details' }, requestId: 'invalid-config' });
  assert.equal(f.nodes.get(`${f.desktop}/.remote-desktop.json`).bytes.toString(), '{invalid JSON');
  const response = f.messages.findLast(item => item.requestId === 'invalid-config');
  assert.ok(response.error);
});

test('remote extension host finds the login home even before opening a workspace folder', async () => {
  const f = fixture({ native: true, noFolders: true, autoHome: true });
  await f.send({ type: 'ready' });
  const state = f.messages.findLast(item => item.type === 'remoteState');
  assert.equal(state.status, 'ready');
  assert.equal(state.rootPath, f.desktop);
  assert.equal(f.api.getDiagnostics().nativeRemoteHost, true);
});

test('remote delete confirms once for a batch and bypasses unsupported recycle bin', async () => {
  const f = fixture();
  await f.send({ type: 'ready' });
  f.file(`${f.desktop}/folder/child.txt`, 'child');
  await f.send({ type: 'fileOperation', operation: 'delete', paths: [`${f.desktop}/a.txt`, `${f.desktop}/folder`], requestId: 'delete-batch' });
  assert.equal(f.messages.findLast(item => item.requestId === 'delete-batch').success, true);
  assert.equal(f.calls.filter(call => call[0] === 'warning' && call[2]?.modal).length, 1);
  const deletions = f.calls.filter(call => call[0] === 'delete' && !call[1].includes('.tmp'));
  assert.equal(deletions.length, 2);
  assert.ok(deletions.every(call => call[2].useTrash === false));
  assert.equal(f.nodes.has(`${f.desktop}/folder/child.txt`), false);
});

test('cancelled permanent delete makes no mutation and returns cancellation without an error toast', async () => {
  const f = fixture();
  await f.send({ type: 'ready' });
  f.deleteChoices.push(undefined);
  await f.send({ type: 'fileOperation', operation: 'delete', paths: [`${f.desktop}/a.txt`], requestId: 'cancel-delete' });
  const result = f.messages.findLast(item => item.requestId === 'cancel-delete');
  assert.equal(result.success, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.error, undefined);
  assert.equal(f.calls.filter(call => call[0] === 'delete').length, 0);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.nodes.get(`${f.desktop}/a.txt`).bytes.toString(), 'alpha');
});

test('local delete keeps recycle bin behavior and does not show permanent delete confirmation', async () => {
  const f = fixture({ local: true });
  await f.send({ type: 'ready' });
  await f.send({ type: 'fileOperation', operation: 'delete', paths: [`${f.desktop}/a.txt`], requestId: 'local-delete' });
  assert.equal(f.messages.findLast(item => item.requestId === 'local-delete').success, true);
  assert.equal(f.calls.find(call => call[0] === 'delete')[2].useTrash, true);
  assert.equal(f.warnings.length, 0);
});

test('remote provider symlink delete never recursively deletes its target', async () => {
  const f = fixture();
  await f.send({ type: 'ready' });
  f.file(`${f.desktop}/folder/child.txt`, 'keep');
  f.nodes.set(`${f.desktop}/link`, { type: 64, target: `${f.desktop}/folder` });
  await f.send({ type: 'fileOperation', operation: 'delete', paths: [`${f.desktop}/link`], requestId: 'delete-link' });
  assert.equal(f.messages.findLast(item => item.requestId === 'delete-link').success, true);
  assert.equal(f.calls.find(call => call[0] === 'delete')[2].recursive, false);
  assert.equal(f.nodes.get(`${f.desktop}/folder/child.txt`).bytes.toString(), 'keep');
});

test('same-directory copy appends numbered suffix before extension and preserves the source', async () => {
  const f = fixture();
  await f.send({ type: 'ready' });
  f.file(`${f.desktop}/a(1).txt`, 'occupied');
  f.nodes.set(`${f.desktop}/a(2).txt`, { type: 64, target: `${f.desktop}/missing` });
  f.file(`${f.desktop}/.hidden`, 'dotfile');
  await f.send({ type: 'fileOperation', operation: 'paste', parent: f.desktop, clipboard: { mode: 'copy', paths: [`${f.desktop}/a.txt`, `${f.desktop}/.hidden`] }, requestId: 'same-directory' });
  assert.equal(f.messages.findLast(item => item.requestId === 'same-directory').success, true);
  assert.equal(f.nodes.get(`${f.desktop}/a(3).txt`).bytes.toString(), 'alpha');
  assert.equal(f.nodes.get(`${f.desktop}/a.txt`).bytes.toString(), 'alpha');
  assert.equal(f.nodes.get(`${f.desktop}/a(1).txt`).bytes.toString(), 'occupied');
  assert.equal(f.nodes.get(`${f.desktop}/a(2).txt`).type, 64);
  assert.equal(f.nodes.get(`${f.desktop}/.hidden(1)`).bytes.toString(), 'dotfile');
});

test('folder copy adds suffix after its full name, and rejects copying into descendants', async () => {
  const f = fixture();
  await f.send({ type: 'ready' });
  f.directory(`${f.desktop}/work.data`);
  f.file(`${f.desktop}/work.data/child.txt`, 'child');
  await f.send({ type: 'fileOperation', operation: 'paste', parent: f.desktop, clipboard: { mode: 'copy', paths: [`${f.desktop}/work.data`] }, requestId: 'folder-copy' });
  assert.equal(f.messages.findLast(item => item.requestId === 'folder-copy').success, true);
  assert.equal(f.nodes.get(`${f.desktop}/work.data(1)/child.txt`).bytes.toString(), 'child');
  await f.send({ type: 'fileOperation', operation: 'paste', parent: `${f.desktop}/work.data`, clipboard: { mode: 'copy', paths: [`${f.desktop}/work.data`] }, requestId: 'descendant-copy' });
  assert.equal(f.messages.findLast(item => item.requestId === 'descendant-copy').success, false);
  assert.equal(f.calls.filter(call => call[0] === 'copy').length, 1);
});

test('batch copy reserves duplicate names while move collisions never overwrite', async () => {
  const f = fixture();
  await f.send({ type: 'ready' });
  f.directory(`${f.desktop}/other`);
  f.file(`${f.desktop}/other/a.txt`, 'other');
  await f.send({ type: 'fileOperation', operation: 'paste', parent: `${f.desktop}/folder`, clipboard: { mode: 'copy', paths: [`${f.desktop}/a.txt`, `${f.desktop}/other/a.txt`] }, requestId: 'batch-copy' });
  assert.equal(f.messages.findLast(item => item.requestId === 'batch-copy').success, true);
  assert.equal(f.nodes.get(`${f.desktop}/folder/a.txt`).bytes.toString(), 'alpha');
  assert.equal(f.nodes.get(`${f.desktop}/folder/a(1).txt`).bytes.toString(), 'other');
  await f.send({ type: 'fileOperation', operation: 'paste', parent: `${f.desktop}/folder`, clipboard: { mode: 'move', paths: [`${f.desktop}/other/a.txt`] }, requestId: 'move-collision' });
  assert.equal(f.messages.findLast(item => item.requestId === 'move-collision').success, false);
  assert.equal(f.nodes.get(`${f.desktop}/other/a.txt`).bytes.toString(), 'other');
  assert.equal(f.nodes.get(`${f.desktop}/folder/a.txt`).bytes.toString(), 'alpha');
});

test('server identity and time come only from native extension host', async () => {
  const f = fixture({ native: true });
  const before = Date.now();
  await f.send({ type: 'ready' });
  let result = f.messages.findLast(item => item.type === 'serverInfo');
  assert.equal(result.username, 'test-user');
  assert.equal(result.hostname, 'ssh-test-host');
  assert.equal(result.remote, true);
  assert.ok(result.epochMs >= before && result.epochMs <= Date.now());
  assert.equal(typeof result.timeZone, 'string');
  await f.send({ type: 'getServerInfo' });
  assert.equal(f.messages.filter(item => item.type === 'serverInfo').length, 2);
  const uiHost = fixture();
  await uiHost.send({ type: 'ready' });
  result = uiHost.messages.findLast(item => item.type === 'serverInfo');
  assert.equal(result.username, null);
  assert.equal(result.hostname, null);
  assert.equal(result.epochMs, null);
  assert.ok(result.error);
});

test('pinned apps persist independently of layout and command shortcuts, and validate program names', async () => {
  const f = fixture();
  await f.send({ type: 'ready' });
  await f.send({ type: 'pinApp', app: { id: 'pinned-vim', label: 'Vim editor', program: 'vim' } });
  await f.send({ type: 'saveDesktopConfig', config: { viewMode: 'details' } });
  await f.send({ type: 'refreshRemote' });
  const saved = f.messages.findLast(item => item.type === 'remoteState').config;
  assert.deepEqual(saved.pinnedApps, [{ id: 'pinned-vim', label: 'Vim editor', program: 'vim' }]);
  assert.equal(saved.custom, 'preserved');
  await f.send({ type: 'pinApp', program: 'vim', label: 'Vim' });
  assert.equal(f.messages.findLast(item => item.type === 'configUpdated').config.pinnedApps.length, 1);
  await f.send({ type: 'pinApp', program: 'vim; rm -rf /', requestId: 'invalid-program' });
  assert.ok(f.messages.findLast(item => item.requestId === 'invalid-program').error);
  await f.send({ type: 'unpinApp', id: 'pinned-vim' });
  assert.deepEqual(f.messages.findLast(item => item.type === 'configUpdated').config.pinnedApps, []);
});

test('terminal messages delegate to native manager with validated cwd and dispose with extension', async () => {
  const f = fixture({ native: true });
  await f.send({ type: 'ready' });
  for (const type of ['openTerminal', 'terminalInput', 'terminalResize', 'terminalClose']) await f.send({ type, id: 'terminal-1', path: f.desktop });
  assert.equal(f.calls.filter(call => call[0] === 'terminalMessage').length, 4);
  const config = f.calls.find(call => call[0] === 'terminalManager')[1];
  assert.equal(config.isNativeHost(), true);
  assert.equal(config.isTrusted(), true);
  assert.equal(config.resolveCwd(f.desktop), f.desktop);
  assert.throws(() => config.resolveCwd('/etc'), /路径不在/);
  f.context.subscriptions.at(-1).dispose();
  assert.equal(f.calls.filter(call => call[0] === 'terminalDispose').length, 1);
});

test('displayed commands quote shell metacharacters and report actual numbered copy and link destinations', async () => {
  const f = fixture({ native: true });
  await f.send({ type: 'ready' });
  const name = "O'Brien $(echo ignored).txt";
  const target = `${f.desktop}/${name}`;
  await f.send({ type: 'fileOperation', operation: 'new-file', parent: f.desktop, name });
  let display = f.messages.findLast(item => item.type === 'operationCommand');
  assert.equal(display.command, `touch -- '${f.desktop}/O'"'"'Brien $(echo ignored).txt'`);
  assert.equal(display.status, 'success');
  assert.ok(f.nodes.has(target));
  await f.send({ type: 'fileOperation', operation: 'paste', parent: f.desktop, clipboard: { mode: 'copy', paths: [target] } });
  display = f.messages.findLast(item => item.type === 'operationCommand');
  assert.equal(display.command, `cp -R --no-clobber -- '${f.desktop}/O'"'"'Brien $(echo ignored).txt' '${f.desktop}/O'"'"'Brien $(echo ignored)(1).txt'`);
  assert.ok(f.nodes.has(`${f.desktop}/O'Brien $(echo ignored)(1).txt`));
  await f.send({ type: 'fileOperation', operation: 'shortcut', paths: [target] });
  await f.send({ type: 'fileOperation', operation: 'shortcut', paths: [target] });
  display = f.messages.findLast(item => item.type === 'operationCommand');
  assert.ok(display.command.startsWith('ln -s -- '));
  assert.ok(display.command.endsWith(`O'"'"'Brien $(echo ignored).txt - 快捷方式 (2)'`));
  assert.equal(f.calls.some(call => call[0] === 'command'), false, 'display commands must never be delegated for execution');
});

test('failed and cancelled file operations have explicit command status and no internal refresh overwrites it', async () => {
  const f = fixture({ native: true });
  await f.send({ type: 'ready' });
  await f.send({ type: 'fileOperation', operation: 'new-file', parent: f.desktop, name: 'a.txt' });
  assert.equal(f.messages.findLast(item => item.type === 'operationCommand').status, 'error');
  f.deleteChoices.push(undefined);
  await f.send({ type: 'fileOperation', operation: 'delete', paths: [`${f.desktop}/a.txt`] });
  const cancelled = f.messages.findLast(item => item.type === 'operationCommand');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.command, `rm -r -- '${f.desktop}/a.txt'`);
  assert.ok(f.nodes.has(`${f.desktop}/a.txt`));
  const commandCount = f.messages.filter(item => item.type === 'operationCommand').length;
  await f.send({ type: 'readDirectory', path: f.desktop });
  await f.send({ type: 'refreshRemote' });
  await f.send({ type: 'getServerInfo' });
  await f.send({ type: 'saveDesktopConfig', config: { viewMode: 'details' } });
  assert.equal(f.messages.filter(item => item.type === 'operationCommand').length, commandCount);
  await f.send({ type: 'fileOperation', operation: 'new-folder', parent: f.desktop, name: 'new-folder' });
  assert.equal(f.messages.filter(item => item.type === 'operationCommand').length, commandCount + 1, 'mutation refreshes must not emit ls commands');
  assert.equal(f.messages.findLast(item => item.type === 'operationCommand').command, `mkdir -- '${f.desktop}/new-folder'`);
});

test('explicit navigation normalizes paths within allowed roots and reports refresh or traversal errors', async () => {
  const f = fixture({ native: true });
  await f.send({ type: 'ready' });
  assert.equal(f.messages.findLast(item => item.type === 'remoteState').homePath, f.home);
  await f.send({ type: 'readDirectory', path: `${f.desktop}//folder/../folder/.`, intent: 'navigate' });
  let listing = f.messages.findLast(item => item.type === 'remoteDirectory');
  assert.equal(listing.path, `${f.desktop}/folder`);
  assert.equal(listing.error, undefined);
  assert.equal(listing.operationCommand.command, `cd -- '${f.desktop}/folder' && ls -la`);
  await f.send({ type: 'readDirectory', path: `${f.home}/../../etc`, intent: 'navigate' });
  listing = f.messages.findLast(item => item.type === 'remoteDirectory');
  assert.ok(listing.error);
  assert.equal(listing.entries, undefined);
  assert.equal(listing.operationCommand.status, 'error');
  f.setFailRead(`${f.desktop}/folder`);
  await f.send({ type: 'readDirectory', path: `${f.desktop}/folder`, intent: 'refresh' });
  listing = f.messages.findLast(item => item.type === 'remoteDirectory');
  assert.equal(listing.operationCommand.command, `ls -la -- '${f.desktop}/folder'`);
  assert.equal(listing.operationCommand.status, 'error');
  await f.send({ type: 'refreshRemote', intent: 'refresh' });
  assert.equal(f.messages.findLast(item => item.type === 'operationCommand').command, `ls -la -- '${f.desktop}'`);
  assert.equal(f.messages.findLast(item => item.type === 'operationCommand').status, 'success');
});

test('rename and move display their actual paths while non-Linux and VS Code actions stay comments', async () => {
  const f = fixture({ native: true });
  await f.send({ type: 'ready' });
  await f.send({ type: 'fileOperation', operation: 'rename', paths: [`${f.desktop}/a.txt`], name: 'renamed.txt' });
  assert.equal(f.messages.findLast(item => item.type === 'operationCommand').command, `mv --no-clobber -- '${f.desktop}/a.txt' '${f.desktop}/renamed.txt'`);
  await f.send({ type: 'fileOperation', operation: 'paste', parent: `${f.desktop}/folder`, clipboard: { mode: 'move', paths: [`${f.desktop}/renamed.txt`] } });
  assert.equal(f.messages.findLast(item => item.type === 'operationCommand').command, `mv --no-clobber -- '${f.desktop}/renamed.txt' '${f.desktop}/folder/renamed.txt'`);
  await f.send({ type: 'openResource', path: `${f.desktop}/folder/renamed.txt`, kind: 'file' });
  assert.ok(f.messages.findLast(item => item.type === 'operationCommand').command.startsWith('# VS Code vscode.open：'));
  const windows = fixture({ native: true, platform: 'win32' });
  await windows.send({ type: 'ready' });
  await windows.send({ type: 'fileOperation', operation: 'new-folder', parent: windows.desktop, name: 'new-folder' });
  assert.equal(windows.messages.findLast(item => item.type === 'serverInfo').platform, 'win32');
  assert.ok(windows.messages.findLast(item => item.type === 'operationCommand').command.startsWith('# VS Code 文件系统：'));
});

test('fullscreen delegates to VS Code Zen mode without assuming its resulting state or changing configuration', async () => {
  const f = fixture({ native: true });
  await f.send({ type: 'ready' });
  const originalConfig = f.nodes.get(`${f.desktop}/.remote-desktop.json`).bytes.toString();
  await f.send({ type: 'toggleFullscreen' });
  await f.send({ type: 'toggleFullscreen' });
  assert.equal(f.calls.filter(call => call[0] === 'command' && call[1] === 'workbench.action.toggleZenMode').length, 2);
  const reply = f.messages.findLast(item => item.type === 'fullscreenResult');
  assert.equal(reply.ok, true);
  assert.equal(reply.fullscreen, undefined);
  assert.ok(reply.message.includes('Escape'));
  assert.equal(f.nodes.get(`${f.desktop}/.remote-desktop.json`).bytes.toString(), originalConfig);
  const failed = fixture({ failCommand: 'workbench.action.toggleZenMode' });
  await failed.send({ type: 'toggleFullscreen' });
  assert.equal(failed.messages.findLast(item => item.type === 'fullscreenResult').ok, false);
  assert.equal(failed.messages.findLast(item => item.type === 'operationCommand').status, 'error');
});

test('terminal command display waits for successful PTY startup and does not record terminal input', async () => {
  const f = fixture({ native: true, terminalReply: 'opened' });
  await f.send({ type: 'ready' });
  await f.send({ type: 'openTerminal', id: 'vim-test', path: f.desktop, program: 'vim' });
  assert.equal(f.messages.findLast(item => item.type === 'operationCommand').command, `cd -- '${f.desktop}' && vim`);
  const count = f.messages.filter(item => item.type === 'operationCommand').length;
  await f.send({ type: 'terminalInput', id: 'vim-test', data: 'private-input' });
  await f.send({ type: 'terminalResize', id: 'vim-test', cols: 80, rows: 24 });
  assert.equal(f.messages.filter(item => item.type === 'operationCommand').length, count);
  const failed = fixture({ native: true, terminalReply: 'error' });
  await failed.send({ type: 'ready' });
  await failed.send({ type: 'openTerminal', id: 'failed-test', path: failed.desktop, program: 'htop' });
  assert.equal(failed.messages.findLast(item => item.type === 'operationCommand').status, 'error');
  assert.equal(failed.messages.findLast(item => item.type === 'operationCommand').detail, 'Program missing');
});
