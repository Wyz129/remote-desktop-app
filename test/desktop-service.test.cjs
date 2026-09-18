'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const path = require('node:path');
const { SshBackend } = require('../lib/ssh-backend.cjs');
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

test('paths outside the login home and protected roots cannot be mutated', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  for (const parent of ['/outside', `${fixture.home}/../../outside`, '/srv/fixture-user-sibling']) {
    await assert.rejects(service.operate({ operation: 'new-file', parent, name: 'must-not-exist' }, noConfirmation), /主目录/);
  }
  for (const root of [fixture.home, desktop, '/']) {
    await assert.rejects(service.operate({ operation: 'delete', paths: [root] }, noConfirmation), /主目录|根目录/);
    await assert.rejects(service.operate({ operation: 'rename', paths: [root], name: 'renamed-root' }, noConfirmation), /主目录|根目录/);
  }
  await assert.rejects(service.operate({ operation: 'new-file', parent: desktop, name: '../escape' }, noConfirmation), /名称/);
  assert.deepEqual(await fsp.readdir(fixture.outsideRoot), []);
});

test('resolved directory links and configuration links cannot escape the home boundary', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  await fsp.writeFile(path.join(fixture.outsideRoot, 'settings.json'), '{"custom":"outside"}');
  fixture.link(`${desktop}/escape`, '/outside');
  await assert.rejects(service.entries(`${desktop}/escape`), /主目录之外/);
  await assert.rejects(service.operate({ operation: 'new-file', parent: `${desktop}/escape`, name: 'blocked.txt' }, noConfirmation), /主目录之外/);
  fixture.link(`${desktop}/.remote-desktop.json`, '/outside/settings.json');
  assert.deepEqual(await service.loadConfig(), {}); assert.match(service.configError, /主目录之外/);
  await assert.rejects(service.saveConfig({ wallpaper: 'slate' }), /主目录之外/);
  assert.equal(await fsp.readFile(path.join(fixture.outsideRoot, 'settings.json'), 'utf8'), '{"custom":"outside"}');
  assert.deepEqual(await fsp.readdir(fixture.outsideRoot), ['settings.json']);
});

test('copy and move into their own descendant are rejected', options, async t => {
  const { fixture, service, desktop } = await setup(t);
  await fixture.put('Desktop/tree/child/keep.txt', 'keep');
  for (const mode of ['copy', 'move']) await assert.rejects(service.operate({ operation: 'paste', parent: `${desktop}/tree/child`, clipboard: { mode, paths: [`${desktop}/tree`] } }, noConfirmation), /自身内部/);
  assert.equal(await fsp.readFile(fixture.mapPath(`${desktop}/tree/child/keep.txt`), 'utf8'), 'keep');
});

test('server information is returned by the authenticated SSH command channel', options, async t => {
  const { fixture, service } = await setup(t);
  const info = await service.serverInfo();
  assert.equal(info.remote, true); assert.equal(info.username, fixture.username); assert.equal(info.hostname, 'fixture-host');
  assert.equal(info.timeZone, 'UTC'); assert.ok(Math.abs(info.epochMs - Date.now()) < 5000);
  assert.ok(fixture.calls.exec.includes('id -un; hostname; date -u +%s'));
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
