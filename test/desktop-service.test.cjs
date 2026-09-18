'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const path = require('node:path');
const { Readable, PassThrough } = require('node:stream');
const { SshBackend } = require('../lib/ssh-backend.cjs');
const { DesktopService } = require('../lib/desktop-service.cjs');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');

const options = { timeout: 20000 };
async function setup(t, fixtureOptions = {}) {
  const fixture = await createSshFixture(fixtureOptions);
  const backend = new SshBackend({ downloadsPath: fixture.downloads });
  t.after(async () => { await backend.disconnect(); await fixture.close(); });
  await backend.connect(fixture.config);
  const service = backend.desktopService();
  await service.inspect();
  return { fixture, backend, service, desktop: `${fixture.home}/Desktop` };
}
const missing = error => error.code === 'ENOENT';
const noConfirmation = () => { throw new Error('Unexpected delete confirmation'); };
const readJson = async (fixture, remote) => JSON.parse(await fsp.readFile(fixture.mapPath(remote), 'utf8'));
async function until(predicate, label) {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('SFTP create and rename use real files, report affected paths and preserve conflicts', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  const folder = await service.operate({ operation: 'new-folder', parent: desktop, name: 'New Folder' }, noConfirmation);
  assert.equal((await fsp.stat(fixture.mapPath(`${desktop}/New Folder`))).isDirectory(), true);
  assert.ok(folder.affectedPaths.includes(desktop));
  const created = await service.operate({ operation: 'new-file', parent: desktop, name: 'New File.txt' }, noConfirmation);
  assert.equal(await fsp.readFile(fixture.mapPath(created.paths[0]), 'utf8'), '');
  await fsp.writeFile(fixture.mapPath(created.paths[0]), 'must not overwrite');
  await assert.rejects(service.operate({ operation: 'new-file', parent: desktop, name: 'New File.txt' }, noConfirmation), /同名/);
  const renamed = await service.operate({ operation: 'rename', paths: created.paths, name: '中文 name.txt' }, noConfirmation);
  assert.equal(await fsp.readFile(fixture.mapPath(renamed.paths[0]), 'utf8'), 'must not overwrite');
  await assert.rejects(fsp.stat(fixture.mapPath(created.paths[0])), missing);
  assert.ok(fixture.calls.sftp.some(call => call[0] === 'RENAME'));
});

test('recursive SFTP copy numbers conflicts and preserves source data and empty directories', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  const source = await fixture.put('Desktop/tree/nested/结果.txt', 'recursive 中文');
  await fsp.mkdir(fixture.mapPath(`${desktop}/tree/empty`));
  const message = { operation: 'paste', parent: desktop, clipboard: { mode: 'copy', paths: [`${desktop}/tree`] } };
  const first = await service.operate(message, noConfirmation);
  const second = await service.operate(message, noConfirmation);
  assert.equal(first.paths[0], `${desktop}/tree (2)`);
  assert.equal(second.paths[0], `${desktop}/tree (3)`);
  for (const folder of [`${desktop}/tree`, ...first.paths, ...second.paths]) {
    assert.equal(await fsp.readFile(fixture.mapPath(`${folder}/nested/结果.txt`), 'utf8'), 'recursive 中文');
    assert.equal((await fsp.stat(fixture.mapPath(`${folder}/empty`))).isDirectory(), true);
  }
  assert.equal(await fsp.readFile(fixture.mapPath(source), 'utf8'), 'recursive 中文');
});

test('move refuses a conflict, retains both files, then moves to an empty destination', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  const source = await fixture.put('Desktop/source/name.txt', 'source');
  const occupied = await fixture.put('Desktop/target/name.txt', 'existing target');
  const message = { operation: 'paste', parent: `${desktop}/target`, clipboard: { mode: 'move', paths: [source] } };
  await assert.rejects(service.operate(message, noConfirmation), /同名/);
  assert.equal(await fsp.readFile(fixture.mapPath(source), 'utf8'), 'source');
  assert.equal(await fsp.readFile(fixture.mapPath(occupied), 'utf8'), 'existing target');
  await service.operate({ operation: 'new-folder', parent: desktop, name: 'empty-target' }, noConfirmation);
  const result = await service.operate({ ...message, parent: `${desktop}/empty-target` }, noConfirmation);
  assert.equal(await fsp.readFile(fixture.mapPath(result.paths[0]), 'utf8'), 'source');
  await assert.rejects(fsp.stat(fixture.mapPath(source)), missing);
});

test('delete cancellation does not send mutation requests; confirmation deletes recursively', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  await fixture.put('Desktop/delete-tree/nested/file.txt', 'delete candidate');
  let confirmations = 0;
  const message = { operation: 'delete', paths: [`${desktop}/delete-tree`] };
  const before = fixture.calls.sftp.length;
  const cancelled = await service.operate(message, async paths => { confirmations++; assert.deepEqual(paths, message.paths); return false; });
  assert.equal(cancelled.cancelled, true);
  assert.equal(fixture.calls.sftp.slice(before).some(call => ['REMOVE', 'RMDIR'].includes(call[0])), false);
  assert.equal(await fsp.readFile(fixture.mapPath(`${desktop}/delete-tree/nested/file.txt`), 'utf8'), 'delete candidate');
  const deleted = await service.operate(message, async () => { confirmations++; return true; });
  assert.equal(deleted.success, true); assert.equal(confirmations, 2);
  await assert.rejects(fsp.stat(fixture.mapPath(message.paths[0])), missing);
});

test('shortcut uses SFTP symlink and deleting the link preserves its real target', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  const source = await fixture.put('source/file.txt', 'target survives');
  const result = await service.operate({ operation: 'shortcut', paths: [source] }, noConfirmation);
  const shortcut = result.paths[0];
  assert.equal(fixture.links.get(shortcut), source);
  assert.ok(fixture.calls.sftp.some(call => call[0] === 'SYMLINK'));
  const entries = await service.entries(desktop);
  assert.equal(entries.find(entry => entry.path === shortcut).isSymbolicLink, true);
  assert.equal(await service.call('realpath', shortcut), source);
  await service.operate({ operation: 'delete', paths: [shortcut] }, async () => true);
  assert.equal(fixture.links.has(shortcut), false);
  assert.equal(await fsp.readFile(fixture.mapPath(source), 'utf8'), 'target survives');
});

test('copy preserves links without traversing a linked directory', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  await fixture.put('Desktop/linked-tree/regular.txt', 'regular');
  const target = await fixture.put('target/note.txt', 'outside copied tree');
  fixture.link(`${desktop}/linked-tree/to-target`, path.posix.dirname(target));
  const result = await service.operate({ operation: 'paste', parent: desktop, clipboard: { mode: 'copy', paths: [`${desktop}/linked-tree`] } }, noConfirmation);
  assert.equal(fixture.links.get(`${result.paths[0]}/to-target`), path.posix.dirname(target));
  await service.operate({ operation: 'delete', paths: result.paths }, async () => true);
  assert.equal(await fsp.readFile(fixture.mapPath(target), 'utf8'), 'outside copied tree');
});

test('new files do not overwrite dangling links and link deletion does not follow directory targets', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  fixture.link(`${desktop}/dangling.txt`, `${fixture.home}/missing-target.txt`);
  await assert.rejects(service.operate({ operation: 'new-file', parent: desktop, name: 'dangling.txt' }, noConfirmation), /同名/);
  assert.equal(fixture.links.get(`${desktop}/dangling.txt`), `${fixture.home}/missing-target.txt`);
  await fixture.put('kept-directory/file.txt', 'retained');
  fixture.link(`${desktop}/directory-link`, `${fixture.home}/kept-directory`);
  await service.operate({ operation: 'delete', paths: [`${desktop}/directory-link`] }, async () => true);
  assert.equal(fixture.links.has(`${desktop}/directory-link`), false);
  assert.equal(await fsp.readFile(fixture.mapPath(`${fixture.home}/kept-directory/file.txt`), 'utf8'), 'retained');
});

test('configuration lookup honors all four legacy candidates in order', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  const candidates = [`${desktop}/.remote-desktop.json`, `${desktop}/config.json`, `${fixture.home}/.config/remote-desktop/config.json`, `${fixture.home}/.remote-desktop.json`];
  for (let index = candidates.length - 1; index >= 0; index--) {
    await fixture.put(candidates[index].slice(fixture.home.length + 1), JSON.stringify({ viewMode: 'icons', selected: index }));
    const config = await service.loadConfig();
    assert.equal(config.selected, index); assert.equal(service.configPath, candidates[index]);
  }
});

test('configuration save retains changes made externally after the last read', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  const configPath = `${desktop}/.remote-desktop.json`;
  await fixture.put('Desktop/.remote-desktop.json', JSON.stringify({ viewMode: 'icons', wallpaper: 'teal', custom: 'original' }));
  await service.loadConfig();
  await fixture.put('Desktop/.remote-desktop.json', JSON.stringify({ viewMode: 'details', wallpaper: 'purple', custom: 'external', shortcuts: [{ kind: 'command', command: 'legacy-command' }] }));
  const result = await service.saveConfig({ showHiddenFiles: false });
  assert.equal(result.viewMode, 'details'); assert.equal(result.wallpaper, 'purple'); assert.equal(result.custom, 'external');
  assert.deepEqual(result.shortcuts, [{ kind: 'command', command: 'legacy-command' }]);
  assert.equal(result.showHiddenFiles, false);
  assert.deepEqual(await readJson(fixture, configPath), result);
  assert.ok(fixture.calls.sftp.some(call => call[0] === 'POSIX_RENAME' && call[2] === configPath));
});

test('serialized configuration patches do not lose each other and first save creates the file', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  await Promise.all([service.saveConfig({ wallpaper: 'slate' }), service.saveConfig({ viewMode: 'icons' }), service.saveConfig({ showHiddenFiles: false })]);
  const config = await readJson(fixture, `${desktop}/.remote-desktop.json`);
  assert.deepEqual(config, { wallpaper: 'slate', viewMode: 'icons', showHiddenFiles: false });
  assert.equal((await fsp.readdir(fixture.mapPath(desktop))).some(name => name.includes('.tmp-')), false);
});

test('invalid configuration stops fallback and cannot be overwritten by an unrelated save', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  await fixture.put('Desktop/config.json', JSON.stringify({ wallpaper: 'purple' }));
  await fixture.put('Desktop/.remote-desktop.json', '{not valid json');
  assert.deepEqual(await service.loadConfig(), {});
  assert.match(service.configError, /无法载入/);
  assert.equal(service.configPath, `${desktop}/.remote-desktop.json`);
  await assert.rejects(service.saveConfig({ viewMode: 'icons' }));
  assert.equal(await fsp.readFile(fixture.mapPath(service.configPath), 'utf8'), '{not valid json');
  assert.equal((await fsp.readdir(fixture.mapPath(desktop))).some(name => name.includes('.tmp-')), false);
});

test('config validation and failed atomic replacement retain the original bytes', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  const original = '{"wallpaper":"teal","custom":17}\n';
  await fixture.put('Desktop/.remote-desktop.json', original); await service.loadConfig();
  await assert.rejects(service.saveConfig({ wallpaper: 'invalid' }), /背景/);
  fixture.failRenames.add(`${desktop}/.remote-desktop.json`);
  await assert.rejects(service.saveConfig({ wallpaper: 'slate' }), /rename/i);
  assert.equal(await fsp.readFile(fixture.mapPath(`${desktop}/.remote-desktop.json`), 'utf8'), original);
  assert.equal((await fsp.readdir(fixture.mapPath(desktop))).some(name => name.includes('.tmp-')), false);
});

test('oversized and non-object configuration files are rejected before save', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  for (const bytes of [JSON.stringify(['invalid-config']), JSON.stringify({ custom: 'x'.repeat(65536) })]) {
    await fixture.put('Desktop/.remote-desktop.json', bytes);
    assert.deepEqual(await service.loadConfig(), {});
    assert.match(service.configError, /JSON 对象|64 KiB/);
    await assert.rejects(service.saveConfig({ showHiddenFiles: true }));
    assert.equal(await fsp.readFile(fixture.mapPath(`${desktop}/.remote-desktop.json`), 'utf8'), bytes);
  }
});

test('public directories can be browsed and edited while protected roots cannot be mutated', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  assert.ok((await service.entries('/')).some(entry => entry.path === '/outside'));
  await service.operate({ operation: 'new-file', parent: '/outside', name: 'shared.txt' }, noConfirmation);
  assert.equal(await fsp.readFile(path.join(fixture.outsideRoot, 'shared.txt'), 'utf8'), '');
  assert.equal((await service.entries(`${fixture.home}/../../outside`))[0].name, 'shared.txt');
  for (const root of [fixture.home, desktop, '/srv', '/']) {
    await assert.rejects(service.operate({ operation: 'delete', paths: [root] }, noConfirmation), /主目录|根目录/);
    await assert.rejects(service.operate({ operation: 'rename', paths: [root], name: 'renamed-root' }, noConfirmation), /主目录|根目录/);
  }
  await assert.rejects(service.operate({ operation: 'new-file', parent: desktop, name: '../escape' }, noConfirmation), /名称/);
  assert.deepEqual(await fsp.readdir(fixture.outsideRoot), ['shared.txt']);
});

test('public directory and configuration symlinks are accessible outside the home', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  await fsp.writeFile(path.join(fixture.outsideRoot, 'settings.json'), '{"custom":"outside"}');
  fixture.link(`${desktop}/escape`, '/outside');
  assert.equal((await service.entries(`${desktop}/escape`))[0].name, 'settings.json');
  await service.operate({ operation: 'new-file', parent: `${desktop}/escape`, name: 'shared.txt' }, noConfirmation);
  fixture.link(`${desktop}/.remote-desktop.json`, '/outside/settings.json');
  assert.deepEqual(await service.loadConfig(), { custom: 'outside' }); assert.equal(service.configError, null);
  assert.equal(await fsp.readFile(path.join(fixture.outsideRoot, 'settings.json'), 'utf8'), '{"custom":"outside"}');
  assert.deepEqual(await fsp.readdir(fixture.outsideRoot), ['settings.json', 'shared.txt']);
});

test('arbitrary desktop selection outside home survives refresh and selected paths restore after reconnect', options, async t => {
  const { fixture, backend, service } = await setup(t);
  await fsp.mkdir(fixture.mapPath('/outside/Team Space'));
  await fsp.writeFile(fixture.mapPath('/outside/Team Space/readme.txt'), 'shared workspace');
  const state = await backend.setDesktop('/outside/Team Space');
  assert.equal(state.status, 'ready'); assert.equal(state.rootPath, '/outside/Team Space');
  assert.equal(state.entries[0].name, 'readme.txt'); assert.equal(state.entries[0].type, 'file');
  assert.equal((await service.inspect()).rootPath, '/outside/Team Space');
  assert.equal((await backend.discoverDesktop()).path, '/outside/Team Space');
  await backend.disconnect(); await backend.connect(fixture.config);
  assert.equal((await backend.desktopService().inspect(false, '/outside/Team Space')).rootPath, '/outside/Team Space');
});

test('unreadable desktop selection preserves previous path and configuration without persisting', options, async t => {
  const { fixture, backend, service, desktop } = await setup(t);
  await service.saveConfig({ wallpaper: 'purple' });
  fixture.deniedDirectories.add('/outside');
  let persisted = false;
  await assert.rejects(backend.setDesktop('/outside', { beforeCommit: async () => { persisted = true; } }), error => error.code === 3 && /Permission denied/.test(error.message));
  assert.equal(persisted, false); assert.equal(backend.desktop, desktop);
  assert.equal(service.configPath, `${desktop}/.remote-desktop.json`); assert.equal(service.config.wallpaper, 'purple');
  await assert.rejects(service.entries('/outside'), error => error.code === 3);
  assert.equal((await service.inspect()).rootPath, desktop);
});

test('desktop persistence failure rolls back and read-only desktop remains usable', options, async t => {
  const { fixture, backend, service, desktop } = await setup(t);
  await assert.rejects(backend.setDesktop('/outside', { beforeCommit: async () => { throw new Error('Local preference write failed'); } }), /preference write failed/);
  assert.equal(backend.desktop, desktop);
  fixture.readOnlyPaths.add('/outside');
  assert.equal((await backend.setDesktop('/outside')).rootPath, '/outside');
  await assert.rejects(service.saveConfig({ wallpaper: 'slate' }), error => error.code === 3 && /Permission denied/.test(error.message));
  assert.equal((await service.inspect()).rootPath, '/outside');
  assert.deepEqual(await fsp.readdir(fixture.outsideRoot), []);
});

test('desktop switches serialize with configuration saves to keep each location consistent', options, async t => {
  const { fixture, backend, service, desktop } = await setup(t);
  const oldSave = service.saveConfig({ wallpaper: 'purple' });
  const switchDesktop = backend.setDesktop('/outside');
  const newSave = service.saveConfig({ wallpaper: 'slate' });
  await Promise.all([oldSave, switchDesktop, newSave]);
  assert.equal((await readJson(fixture, `${desktop}/.remote-desktop.json`)).wallpaper, 'purple');
  assert.equal((await readJson(fixture, '/outside/.remote-desktop.json')).wallpaper, 'slate');
  assert.equal(backend.desktop, '/outside');
});

test('desktop switch rejects late timeout completion before persistence or state changes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish; let persisted = false;
  const backend = new SshBackend();
  backend.client = {}; backend.home = '/home/test'; backend.desktop = '/home/test/rdesktop'; backend.sftp = {};
  backend.stat = async () => ({ isDirectory: () => true });
  backend.list = () => new Promise(resolve => { finish = resolve; });
  const service = backend.desktopService();
  service.readConfig = async () => ({ config: {}, configPath: '/outside/.remote-desktop.json', configError: null });
  const rejection = assert.rejects(backend.setDesktop('/outside', { beforeCommit: () => { persisted = true; } }), /超时/);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(15000); await rejection;
  finish([]); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(persisted, false); assert.equal(backend.desktop, '/home/test/rdesktop');
});

test('desktop switch deadline includes queue waiting and never starts expired validation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = new SshBackend();
  let unblock, activated = false;
  backend._activateDesktop = async () => { activated = true; };
  const service = backend.desktopService();
  const blocking = service.serialize(() => new Promise(resolve => { unblock = resolve; }));
  await Promise.resolve();
  const rejection = assert.rejects(backend.setDesktop('/shared'), /超时/);
  t.mock.timers.tick(15000); await rejection;
  unblock(); await blocking; await service.queue;
  assert.equal(activated, false);
});

test('desktop switch awaits persistence commit beyond validation deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = new SshBackend();
  backend.client = {}; backend.home = '/home/test'; backend.desktop = '/home/test/rdesktop'; backend.sftp = {};
  backend.stat = async () => ({ isDirectory: () => true }); backend.list = async () => [];
  const service = backend.desktopService();
  service.readConfig = async () => ({ config: {}, configPath: '/outside/.remote-desktop.json', configError: null });
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const result = backend.setDesktop('/outside', { beforeCommit: () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
  await started; t.mock.timers.tick(20000);
  assert.equal(backend.desktop, '/home/test/rdesktop');
  finish(); assert.equal((await result).rootPath, '/outside');
  assert.equal(backend.desktop, '/outside');
});

test('copy and move into their own descendant are rejected', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  await fixture.put('Desktop/tree/child/keep.txt', 'keep');
  fixture.link('/outside/alias-child', `${desktop}/tree/child`);
  for (const mode of ['copy', 'move']) for (const parent of [`${desktop}/tree/child`, '/outside/alias-child']) await assert.rejects(service.operate({ operation: 'paste', parent, clipboard: { mode, paths: [`${desktop}/tree`] } }, noConfirmation), /自身内部/);
  assert.equal(await fsp.readFile(fixture.mapPath(`${desktop}/tree/child/keep.txt`), 'utf8'), 'keep');
});

test('server information is returned by the authenticated SSH command channel', options, async t => {
  const { fixture, service } = await setup(t);
  const info = await service.serverInfo();
  assert.equal(info.remote, true); assert.equal(info.username, fixture.username); assert.equal(info.hostname, 'fixture-host');
  assert.equal(info.utcOffsetMinutes, 0); assert.match(info.timeZoneLabel, /Etc\/UTC/); assert.ok(Math.abs(info.epochMs - Date.now()) < 5000);
  assert.ok(fixture.calls.exec.some(command => command.startsWith('# remote-desktop-server-clock-v1\n')));
});

test('system settings information uses the authenticated SSH channel and real login home', options, async t => {
  const { fixture, service } = await setup(t);
  const info = await service.systemInfo();
  assert.equal(info.home, fixture.home); assert.equal(info.username, fixture.username);
  assert.equal(info.os, 'Ubuntu 24.04 LTS (fixture)'); assert.equal(info.timeZone, 'Etc/UTC');
  assert.equal(info.architecture, 'x86_64'); assert.equal(info.cpu, 'Fixture CPU'); assert.equal(info.shell, '/bin/bash');
  assert.match(info.disk, /100G 25G 75G/); assert.match(info.memory, /16Gi/); assert.match(info.network, /192\.0\.2\.10/);
  assert.equal(Object.values(info).every(value => typeof value === 'string'), true);
  assert.equal(fixture.calls.exec.filter(command => command.startsWith('# remote-desktop-system-info-v1\n')).length, 1);
  assert.equal((await service.serverInfo()).hostname, 'fixture-host');
});

const systemFields = ['os', 'kernel', 'architecture', 'cpu', 'hostname', 'username', 'disk', 'memory', 'dateTime', 'timeZone', 'locale', 'shell', 'network'];
const systemReply = values => systemFields.map(key => `${key}\0${values[key] || ''}\0`).join('');

test('system settings queries never include caller text and unavailable fields degrade individually', async () => {
  const calls = [];
  const home = '/home/quoted-user; echo injected';
  const service = new DesktopService({ home, async _execStream(command) {
    calls.push(command);
    return { stream: Readable.from([Buffer.from(systemReply({ os: 'Ubuntu\n', disk: 'line 1\nline 2', locale: 'LANG=C.UTF-8' }))]), completion: Promise.resolve() };
  } });
  const info = await service.systemInfo({ command: 'touch /tmp/unauthorized' });
  assert.equal(info.home, home); assert.equal(info.os, 'Ubuntu'); assert.equal(info.disk, 'line 1\nline 2'); assert.equal(info.cpu, '未提供');
  assert.equal(calls.length, 1); assert.equal(calls[0].includes('injected'), false); assert.equal(calls[0].includes('unauthorized'), false);
  assert.match(calls[0], /df -h -- "\$HOME"/);
  assert.doesNotMatch(calls[0], /\b(?:sudo|apt|apt-get|systemctl|eval)\b|(?:^|;)\s*\.\s+\/etc\/os-release/);
});

test('system settings rejects excessive or malformed output and aborts only its command', async () => {
  for (const bytes of [Buffer.alloc(32769), Buffer.from('unexpected\0value\0')]) {
    let commandSignal;
    const service = new DesktopService({ home: '/home/test', async _execStream(_command, signal) {
      commandSignal = signal;
      return { stream: Readable.from([bytes]), completion: Promise.resolve() };
    } });
    await assert.rejects(service.systemInfo(), /32 KiB|格式无效/);
    assert.equal(commandSignal.aborted, true);
  }
});

test('system settings timeout cancels its SSH command and never blocks indefinitely', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = new PassThrough(); let commandSignal;
  const service = new DesktopService({ home: '/home/test', async _execStream(_command, signal) {
    commandSignal = signal;
    const completion = new Promise((_, reject) => signal.addEventListener('abort', () => { stream.destroy(); reject(new Error('aborted')); }, { once: true }));
    return { stream, completion };
  } });
  const rejection = assert.rejects(service.systemInfo(), /超时/);
  await Promise.resolve();
  t.mock.timers.tick(8000);
  await rejection;
  assert.equal(commandSignal.aborted, true); assert.equal(stream.destroyed, true);
});

test('system settings requires an active login home before opening a command channel', async () => {
  const service = new DesktopService({ home: null, _execStream() { throw new Error('must not execute'); } });
  await assert.rejects(service.systemInfo(), /尚未连接 SSH/);
});

test('SSH PTY shell carries real channel input, echo, resize and close', options, async t => {
  const { fixture, backend, desktop } = await setup(t);
  let output = ''; let closed = false;
  backend.openShell('fixture-terminal', desktop, data => { output += data.toString(); }, () => { closed = true; });
  await until(() => output.includes('fixture-shell-ready'), 'shell greeting');
  backend.writeShell('fixture-terminal', '中文 controlled input\r');
  await until(() => output.includes('fixture-echo:中文 controlled input'), 'shell echo');
  backend.resizeShell('fixture-terminal', 97, 31);
  await until(() => fixture.calls.resize.some(info => info.cols === 97 && info.rows === 31), 'PTY resize');
  assert.equal(fixture.calls.pty[0].term, 'xterm-256color');
  assert.ok(fixture.calls.exec.some(command => command.startsWith(`cd -- '${desktop}' && exec `)));
  assert.ok(fixture.calls.shell.join('').includes('中文 controlled input'));
  backend.closeShell('fixture-terminal');
  await until(() => closed, 'terminal closed');
  assert.equal(backend.shells.size, 0);
});

test('pin operations preserve external fields, deduplicate by program and restore after reconnect', options, async t => {
  const { fixture, backend, service } = await setup(t);
  await service.updatePinned({ program: 'shell', label: 'Shell' });
  await fixture.put('Desktop/.remote-desktop.json', JSON.stringify({ ...service.config, external: 'retained', wallpaper: 'slate' }));
  await Promise.all([service.updatePinned({ program: 'vim', label: 'Vim' }), service.updatePinned({ program: 'htop', label: 'htop' })]);
  let config = await service.updatePinned({ program: 'shell', label: 'Terminal' });
  assert.equal(config.external, 'retained'); assert.equal(config.wallpaper, 'slate');
  assert.equal(config.pinnedApps.length, 3); assert.equal(config.pinnedApps.filter(item => item.program === 'shell').length, 1);
  config = await service.updatePinned(null, 'pinned-shell'); assert.equal(config.pinnedApps.length, 2);
  await backend.disconnect(); await backend.connect(fixture.config);
  const restored = await backend.discoverDesktop();
  assert.deepEqual(restored.config.pinnedApps.map(item => item.id).sort(), ['pinned-htop', 'pinned-vim']);
  assert.equal(restored.config.external, 'retained');
});

test('image and config readers settle remote CLOSE before immediate disconnect', options, async t => {
  const { fixture, backend, service } = await setup(t);
  await fixture.put('Desktop/bytes.png', Buffer.alloc(16000, 1));
  await fixture.put('Desktop/.remote-desktop.json', JSON.stringify({ wallpaper: 'slate' }));
  await Promise.all([backend.readImage(`${fixture.home}/Desktop/bytes.png`), service.loadConfig()]);
  await backend.disconnect();
  assert.equal(backend.connected, false);
});
