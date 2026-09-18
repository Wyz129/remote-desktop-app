'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { SshBackend } = require('../lib/ssh-backend.cjs');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');

// These tests exchange real SSH/SFTP packets over 127.0.0.1. The endpoint is a
// controlled Node process fixture, not the user's server or an OpenSSH host.
async function setup(t, options = {}) {
  const fixture = await createSshFixture(options);
  const backend = new SshBackend({ downloadsPath: fixture.downloads, threshold: options.threshold || 32 * 1024 });
  t.after(async () => { await backend.disconnect(); await fixture.close(); });
  return { fixture, backend };
}

async function connected(t, options) {
  const context = await setup(t, options);
  context.result = await context.backend.connect(context.fixture.config);
  return context;
}

function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
const options = { timeout: 20000 };

test('real SSH authentication and pinned host key derive the login home', options, async t => {
  const { backend, fixture, result } = await connected(t);
  assert.equal(result.home, fixture.home);
  assert.equal(result.hostFingerprint, fixture.fingerprint);
  assert.equal(result.verified, true);
  assert.equal(backend.connected, true);
  assert.ok(fixture.calls.auth.some(call => call.method === 'password' && call.username === fixture.username));
  assert.ok(fixture.calls.exec.some(command => command.includes('$HOME')));
  const desktop = await backend.discoverDesktop();
  assert.equal(desktop.found, true);
  assert.equal(desktop.path, `${fixture.home}/Desktop`);
});

test('incorrect password is rejected without claiming a connected session', options, async t => {
  const { backend, fixture } = await setup(t);
  await assert.rejects(backend.connect({ ...fixture.config, password: 'incorrect-test-password' }), /auth|认证|password/i);
  assert.equal(backend.connected, false);
  assert.equal(fixture.calls.exec.length, 0);
});

test('incorrect pinned host key is rejected before authentication', options, async t => {
  const { backend, fixture } = await setup(t);
  await assert.rejects(backend.connect({ ...fixture.config, hostKeyFingerprint: 'SHA256:incorrect-fingerprint' }), /host|key|校验|指纹|verification/i);
  assert.equal(backend.connected, false);
  assert.equal(fixture.calls.auth.length, 0);
});

for (const desktopName of ['desktop', '桌面']) test(`discovers ${desktopName} from the actual remote home`, options, async t => {
  const { backend, fixture } = await connected(t, { desktop: desktopName });
  const result = await backend.discoverDesktop();
  assert.equal(result.path, `${fixture.home}/${desktopName}`);
  assert.equal(result.found, true);
});

test('missing desktop is explicit and creation occurs only on the create request', options, async t => {
  const { backend, fixture } = await connected(t, { desktop: false });
  const result = await backend.discoverDesktop();
  assert.equal(result.found, false);
  assert.equal(result.home, fixture.home);
  assert.deepEqual(await fsp.readdir(fixture.serverRoot), []);
  const created = await backend.discoverDesktop(true);
  assert.equal(created.created, true);
  assert.equal(created.path, `${fixture.home}/Desktop`);
  assert.equal((await fsp.stat(fixture.mapPath(created.path))).isDirectory(), true);
});

test('small binary file with a quoted Unicode name uses SSH exec without corruption', options, async t => {
  const { backend, fixture } = await connected(t);
  const bytes = crypto.randomBytes(18000);
  const source = await fixture.put("Desktop/中文 'special' $name.bin", bytes);
  const progress = [];
  const result = await backend.download(source, { id: 'small-transfer', onProgress: value => progress.push(value) });
  assert.equal(result.method, 'ssh');
  assert.equal(path.dirname(result.path), fixture.downloads);
  assert.equal(hash(await fsp.readFile(result.path)), hash(bytes));
  assert.ok(fixture.calls.exec.some(command => command.startsWith('cat -- ') && command.includes('special')));
  assert.equal(fixture.calls.sftp.some(call => call[0] === 'OPEN' && call[1] === source), false);
  assert.equal(progress.at(-1).done, bytes.length);
  assert.equal(progress.at(-1).total, bytes.length);
});

test('large binary file uses real SFTP and reports completed byte counts', options, async t => {
  const { backend, fixture } = await connected(t);
  const bytes = crypto.randomBytes(180000);
  const source = await fixture.put('Desktop/large.bin', bytes);
  const progress = [];
  const result = await backend.download(source, { id: 'large-transfer', onProgress: value => progress.push(value) });
  assert.equal(result.method, 'sftp');
  assert.equal(hash(await fsp.readFile(result.path)), hash(bytes));
  assert.ok(fixture.calls.sftp.some(call => call[0] === 'READ' && call[1] === source));
  assert.equal(fixture.calls.exec.some(command => command.startsWith('cat -- ')), false);
  assert.ok(progress.some(value => value.done > 0 && value.method === 'sftp'));
  assert.equal(progress.at(-1).done, bytes.length);
});

test('configurable threshold changes the transfer protocol for the same file size', options, async t => {
  const { backend, fixture } = await connected(t, { threshold: 1024 });
  const source = await fixture.put('Desktop/threshold.bin', Buffer.alloc(2048, 0x93));
  const result = await backend.download(source);
  assert.equal(result.method, 'sftp');
  assert.ok(fixture.calls.sftp.some(call => call[0] === 'READ' && call[1] === source));
});

test('directory download preserves nested files and empty directories', options, async t => {
  const { backend, fixture } = await connected(t);
  await fixture.put('Desktop/package/readme.txt', 'top level');
  await fixture.put('Desktop/package/nested/结果.txt', 'nested 中文');
  const binary = crypto.randomBytes(60000);
  await fixture.put('Desktop/package/nested/data.bin', binary);
  await fsp.mkdir(fixture.mapPath(`${fixture.home}/Desktop/package/empty`));
  const result = await backend.download(`${fixture.home}/Desktop/package`, { id: 'directory-transfer' });
  assert.equal(await fsp.readFile(path.join(result.path, 'readme.txt'), 'utf8'), 'top level');
  assert.equal(await fsp.readFile(path.join(result.path, 'nested', '结果.txt'), 'utf8'), 'nested 中文');
  assert.equal(hash(await fsp.readFile(path.join(result.path, 'nested', 'data.bin'))), hash(binary));
  assert.equal((await fsp.stat(path.join(result.path, 'empty'))).isDirectory(), true);
  assert.equal((await fsp.readdir(fixture.downloads)).some(name => name.includes('.part-')), false);
});

test('file and directory conflicts retain pre-existing local contents', options, async t => {
  const { backend, fixture } = await connected(t);
  const source = await fixture.put('Desktop/existing.txt', 'new data');
  await fsp.writeFile(path.join(fixture.downloads, 'existing.txt'), 'must remain');
  const result = await backend.download(source);
  assert.notEqual(path.basename(result.path), 'existing.txt');
  assert.equal(await fsp.readFile(path.join(fixture.downloads, 'existing.txt'), 'utf8'), 'must remain');
  assert.equal(await fsp.readFile(result.path, 'utf8'), 'new data');
  await fixture.put('Desktop/folder/content.txt', 'new folder content');
  await fsp.mkdir(path.join(fixture.downloads, 'folder'));
  await fsp.writeFile(path.join(fixture.downloads, 'folder', 'keep.txt'), 'keep directory');
  const folder = await backend.download(`${fixture.home}/Desktop/folder`);
  assert.notEqual(path.basename(folder.path), 'folder');
  assert.equal(await fsp.readFile(path.join(fixture.downloads, 'folder', 'keep.txt'), 'utf8'), 'keep directory');
  assert.equal(await fsp.readFile(path.join(folder.path, 'content.txt'), 'utf8'), 'new folder content');
});

test('concurrent downloads reserve distinct targets instead of overwriting', options, async t => {
  const { backend, fixture } = await connected(t);
  const source = await fixture.put('Desktop/concurrent.bin', crypto.randomBytes(80000));
  fixture.slowReads.add(source);
  const [first, second] = await Promise.all([backend.download(source, { id: 'concurrent-one' }), backend.download(source, { id: 'concurrent-two' })]);
  assert.notEqual(first.path, second.path);
  assert.equal(hash(await fsp.readFile(first.path)), hash(await fsp.readFile(second.path)));
});

for (const method of ['ssh', 'sftp']) test(`cancelling an active ${method} transfer removes unfinished output`, options, async t => {
  const { backend, fixture } = await connected(t, { threshold: method === 'ssh' ? 1024 * 1024 : 1024 });
  const source = await fixture.put(`Desktop/cancel-${method}.bin`, crypto.randomBytes(400000));
  fixture.slowReads.add(source);
  const id = `cancel-${method}`; let cancelled = false;
  await assert.rejects(backend.download(source, { id, onProgress: progress => {
    if (progress.done > 0 && !cancelled) { cancelled = true; backend.cancelDownload(id); }
  } }), /cancel|取消|abort/i);
  assert.equal(cancelled, true, 'transfer must expose progress while cancellable');
  assert.deepEqual(await fsp.readdir(fixture.downloads), []);
});

test('SFTP failure cleans unfinished files and preserves other local files', options, async t => {
  const { backend, fixture } = await connected(t);
  const source = await fixture.put('Desktop/failing.bin', crypto.randomBytes(100000));
  fixture.failReads.add(source);
  await fsp.writeFile(path.join(fixture.downloads, 'keep.txt'), 'keep');
  await assert.rejects(backend.download(source, { id: 'failed-transfer' }));
  assert.deepEqual(await fsp.readdir(fixture.downloads), ['keep.txt']);
  assert.equal(await fsp.readFile(path.join(fixture.downloads, 'keep.txt'), 'utf8'), 'keep');
});

test('recursive transfer failure removes its incomplete directory tree', options, async t => {
  const { backend, fixture } = await connected(t);
  await fixture.put('Desktop/incomplete/a-finished.txt', 'already copied');
  const failing = await fixture.put('Desktop/incomplete/z-failing.bin', crypto.randomBytes(100000));
  fixture.failReads.add(failing);
  await assert.rejects(backend.download(`${fixture.home}/Desktop/incomplete`, { id: 'failed-directory' }));
  assert.deepEqual(await fsp.readdir(fixture.downloads), []);
});

test('image loading returns real remote bytes and refuses unsupported files', options, async t => {
  const { backend, fixture } = await connected(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCq0AAAAASUVORK5CYII=', 'base64');
  const source = await fixture.put('Desktop/pixel.png', png);
  const result = await backend.readImage(source);
  assert.equal(result.mime, 'image/png');
  assert.deepEqual(Buffer.from(result.data, 'base64'), png);
  const text = await fixture.put('Desktop/plain.txt', 'not an image');
  await assert.rejects(backend.readImage(text), /图片|格式|image/i);
});

// Security/planning cases below identify explicitly when they inject directory
// metadata. All other download tests above use actual loopback SSH packets.
test('unknown host keys require explicit acceptance and rejection does not authenticate', options, async t => {
  const { backend, fixture } = await setup(t);
  const input = { ...fixture.config }; delete input.hostKeyFingerprint;
  await assert.rejects(backend.connect(input), /未知.*主机|主机密钥/);
  assert.equal(fixture.calls.auth.length, 0);
  let observed;
  backend.verifyHost = async details => { observed = details; return true; };
  const result = await backend.connect(input);
  assert.equal(result.verified, true);
  assert.equal(observed.fingerprint, fixture.fingerprint);
  assert.equal(observed.host, '127.0.0.1');
});

test('a rejected first-use prompt and a changed pinned key cannot be bypassed', options, async t => {
  const { backend, fixture } = await setup(t);
  backend.verifyHost = async () => false;
  const input = { ...fixture.config }; delete input.hostKeyFingerprint;
  await assert.rejects(backend.connect(input), /取消.*主机/);
  backend.verifyHost = async () => true;
  await assert.rejects(backend.connect({ ...fixture.config, hostKeyFingerprint: 'SHA256:wrong' }), /不匹配/);
  assert.equal(fixture.calls.auth.length, 0);
});

for (const homeOutput of ['', 'relative/home', '/srv/fixture-user\nforged']) test(`invalid login home is rejected without a fallback (${JSON.stringify(homeOutput)})`, options, async t => {
  const { backend, fixture } = await setup(t, { homeOutput });
  await assert.rejects(backend.connect(fixture.config), /主目录|绝对路径/);
  assert.equal(backend.connected, false);
});

test('exact threshold uses SFTP while an empty small file still completes', options, async t => {
  const { backend, fixture } = await connected(t, { threshold: 1024 });
  const boundary = await fixture.put('Desktop/boundary.bin', Buffer.alloc(1024, 5));
  assert.equal((await backend.download(boundary)).method, 'sftp');
  const empty = await fixture.put('Desktop/empty.txt', Buffer.alloc(0));
  const result = await backend.download(empty);
  assert.equal(result.method, 'ssh'); assert.equal((await fsp.stat(result.path)).size, 0);
});

test('cancel before directory planning creates no output and starts no file stream', options, async t => {
  const { backend, fixture } = await connected(t);
  const source = await fixture.put('Desktop/early.txt', 'early cancel');
  await assert.rejects(backend.download(source, { id: 'cancel-early', onProgress: () => backend.cancelDownload('cancel-early') }), /取消/);
  assert.deepEqual(await fsp.readdir(fixture.downloads), []);
  assert.equal(fixture.calls.exec.some(command => command.startsWith('cat --')), false);
});

test('config lookup follows legacy priority and preserves unrelated JSON properties', options, async t => {
  const { backend, fixture } = await connected(t);
  await fixture.put('.remote-desktop.json', JSON.stringify({ wallpaper: 'teal', retained: true }));
  await fixture.put('.config/remote-desktop/config.json', JSON.stringify({ wallpaper: 'purple' }));
  await fixture.put('Desktop/config.json', JSON.stringify({ wallpaper: 'slate', custom: 42 }));
  let result = await backend.discoverDesktop();
  assert.equal(result.config.wallpaper, 'slate');
  assert.equal(result.config.custom, 42);
  await fixture.put('Desktop/.remote-desktop.json', JSON.stringify({ wallpaper: 'purple', shortcuts: [] }));
  result = await backend.discoverDesktop();
  assert.equal(result.config.wallpaper, 'purple');
  await fixture.put('Desktop/.remote-desktop.json', '{invalid');
  result = await backend.discoverDesktop();
  assert.match(result.configError, /配置/);
  assert.deepEqual(result.config, {});
});

test('Windows filenames are sanitized, including reserved names and trailing dots', () => {
  const { safeName } = require('../lib/ssh-backend.cjs');
  for (const value of ['CON', 'con.txt', 'NUL.tar.gz', 'com1.png', 'LPT9.log']) assert.ok(safeName(value).startsWith('_'));
  assert.equal(safeName('report?.txt'), 'report_.txt');
  assert.equal(safeName('name. '), 'name');
  assert.equal(safeName('..'), 'download');
  assert.equal(/[<>:"/\\|?*\u0000-\u001f]/.test(safeName('bad:/\\?name')), false);
});

test('injected unsafe server directory names fail before any local filesystem write', options, async t => {
  const { backend, fixture } = await connected(t);
  backend.sftp.readdir = (_remote, callback) => callback(null, [{ filename: '../escape', attrs: { isDirectory: () => true } }]);
  await assert.rejects(backend.download(`${fixture.home}/Desktop`), /不安全/);
  assert.deepEqual(await fsp.readdir(fixture.downloads), []);
});

test('injected directory symlink loop is rejected and local-name collisions are distinct', async () => {
  const backend = new SshBackend();
  const directory = { isDirectory: () => true, isSymbolicLink: () => false };
  const file = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 3 };
  const symlink = { isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true };
  backend.stat = async value => value === '/root' ? directory : directory;
  backend._entries = async () => [{ filename: 'loop', attrs: symlink }];
  const transfer = { controller: new AbortController() };
  await assert.rejects(backend._downloadPlan('/root', transfer), /符号链接.*循环/);
  backend._entries = async () => ['CON', 'name?', 'name*', 'FILE.txt', 'file.txt'].map(filename => ({ filename, attrs: file }));
  const plan = await backend._downloadPlan('/root', transfer);
  const names = plan.files.map(item => item.relative[0].toLowerCase());
  assert.equal(new Set(names).size, names.length);
  assert.equal(plan.total, 15);
  assert.equal(names[0], '_con');
});

test('disconnect waits for in-flight SFTP download cleanup', options, async t => {
  const { backend, fixture } = await connected(t);
  const source = await fixture.put('Desktop/disconnect.bin', Buffer.alloc(256 * 1024, 3));
  fixture.slowReads.add(source);
  let start;
  const started = new Promise(resolve => { start = resolve; });
  const outcome = backend.download(source, { onProgress: progress => { if (progress.done > 0) start(); } }).then(() => null, error => error);
  await started;
  await backend.disconnect();
  const error = await outcome;
  assert.ok(error); assert.deepEqual(await fsp.readdir(fixture.downloads), []);
  assert.equal(backend.downloads.size, 0);
});
