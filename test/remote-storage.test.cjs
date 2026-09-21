'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { EventEmitter } = require('node:events');
const { ensureRemoteStorage } = require('../lib/remote-storage.cjs');
const { SshBackend } = require('../lib/ssh-backend.cjs');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');

const options = { timeout: 30000 };

async function realContext(t, fixtureOptions = {}) {
  const fixture = await createSshFixture({ desktop: false, ...fixtureOptions });
  const backend = new SshBackend();
  t.after(async () => { await backend.disconnect(); await fixture.close(); });
  await backend.connect(fixture.config);
  return { fixture, backend };
}

test('real SFTP creates all default application directories using private mkdir modes', options, async t => {
  const { fixture, backend } = await realContext(t);
  const modes = [], mkdir = backend.sftp.mkdir.bind(backend.sftp);
  backend.sftp.mkdir = (target, attrs, callback) => { modes.push([target, attrs.mode]); mkdir(target, attrs, callback); };
  const result = await ensureRemoteStorage(backend);
  assert.deepEqual(result, {
    root: `${fixture.home}/.rdesktop`, desktop: `${fixture.home}/.rdesktop/desktop`,
    log: `${fixture.home}/.rdesktop/log`, download: `${fixture.home}/.rdesktop/download`, trash: `${fixture.home}/.rdesktop/trash`, config: `${fixture.home}/.rdesktop/config`
  });
  for (const target of Object.values(result)) assert.ok((await fs.stat(fixture.mapPath(target))).isDirectory());
  // Windows cannot enforce POSIX directory modes. Verify the mode passed over
  // the SFTP client API, while the endpoint verifies actual creation and paths.
  assert.deepEqual(modes, Object.values(result).map(target => [target, 0o700]));
  assert.equal(backend.appPaths, undefined, 'caller owns publishing current appPaths');
  assert.equal(backend.desktop, null, 'initialization does not select a desktop');
});

test('repeated initialization keeps existing files, directories, and old desktop contents', options, async t => {
  const { fixture, backend } = await realContext(t);
  await fixture.put('Desktop/old.txt', 'old desktop');
  await fixture.put('.rdesktop/desktop/keep.txt', 'user desktop data');
  await fixture.put('.rdesktop/log/keep.jsonl', 'old log data');
  await fixture.put('.rdesktop/download/keep.bin', Buffer.from([0, 1, 255]));
  await fixture.put('.rdesktop/trash/keep.txt', 'keep trash');
  await fixture.put('.rdesktop/config/keep.json', '{"retained":true}');
  const before = fixture.calls.sftp.length;
  const first = await ensureRemoteStorage(backend), second = await ensureRemoteStorage(backend);
  assert.deepEqual(second, first);
  assert.ok(!fixture.calls.sftp.slice(before).some(call => ['MKDIR', 'REMOVE', 'RMDIR', 'RENAME', 'OPEN'].includes(call[0])));
  assert.equal(await fs.readFile(fixture.mapPath(`${first.desktop}/keep.txt`), 'utf8'), 'user desktop data');
  assert.equal(await fs.readFile(fixture.mapPath(`${first.log}/keep.jsonl`), 'utf8'), 'old log data');
  assert.equal(await fs.readFile(fixture.mapPath(`${first.config}/keep.json`), 'utf8'), '{"retained":true}');
  assert.deepEqual(await fs.readFile(fixture.mapPath(`${first.download}/keep.bin`)), Buffer.from([0, 1, 255]));
  assert.equal(await fs.readFile(fixture.mapPath(`${fixture.home}/Desktop/old.txt`), 'utf8'), 'old desktop');
});

test('a symlink HOME is canonicalized before constructing application directories', options, async t => {
  const { fixture, backend } = await realContext(t, { homeOutput: '/account-alias' });
  fixture.link('/account-alias', fixture.home);
  const result = await ensureRemoteStorage(backend);
  assert.equal(result.root, `${fixture.home}/.rdesktop`);
  assert.equal(backend.home, '/account-alias', 'home selection remains caller-owned');
  assert.ok(fixture.calls.sftp.filter(call => call[0] === 'MKDIR').every(call => call[1].startsWith(`${fixture.home}/.rdesktop`)));
});

for (const relative of ['.rdesktop', '.rdesktop/desktop', '.rdesktop/log', '.rdesktop/download', '.rdesktop/trash', '.rdesktop/config']) {
  test(`existing file conflict is reported and preserved: ${relative}`, options, async t => {
    const { fixture, backend } = await realContext(t);
    const remote = await fixture.put(relative, 'preserve conflict data');
    await assert.rejects(ensureRemoteStorage(backend), error => error.message.includes('冲突') && error.message.includes(remote));
    assert.equal(await fs.readFile(fixture.mapPath(remote), 'utf8'), 'preserve conflict data');
  });

  test(`symlink app path is rejected before following its destination: ${relative}`, options, async t => {
    const { fixture, backend } = await realContext(t);
    if (relative !== '.rdesktop') await fs.mkdir(fixture.mapPath(`${fixture.home}/.rdesktop`));
    const remote = `${fixture.home}/${relative}`;
    fixture.link(remote, '/outside');
    await assert.rejects(ensureRemoteStorage(backend), error => error.message.includes('符号链接') && error.message.includes(remote));
    assert.deepEqual(await fs.readdir(fixture.outsideRoot), []);
    assert.equal(fixture.links.get(remote), '/outside');
    assert.ok(!fixture.calls.sftp.some(call => call[0] === 'MKDIR' && (call[1] === remote || call[1].startsWith(`${remote}/`))));
  });
}

test('permission-denied creation names the blocked path and keeps the original SFTP error', options, async t => {
  const { fixture, backend } = await realContext(t);
  const target = `${fixture.home}/.rdesktop`;
  fixture.readOnlyPaths.add(fixture.home);
  await assert.rejects(ensureRemoteStorage(backend), error => error.code === 3 && error.message.includes('无访问权限') && error.message.includes(target) && /Permission denied/.test(error.message));
  await assert.rejects(fs.stat(fixture.mapPath(target)), { code: 'ENOENT' });
});

test('two concurrent initializations revalidate mkdir races and return the same paths', options, async t => {
  const { fixture, backend } = await realContext(t);
  const [first, second] = await Promise.all([ensureRemoteStorage(backend), ensureRemoteStorage(backend)]);
  assert.deepEqual(first, second);
  for (const target of Object.values(first)) assert.ok((await fs.stat(fixture.mapPath(target))).isDirectory());
});

test('SFTP identity replacement rejects a delayed result without creating any directories', options, async t => {
  const { fixture, backend } = await realContext(t);
  const sftp = backend.sftp, realpath = sftp.realpath.bind(sftp);
  let pending;
  sftp.realpath = (target, callback) => { pending = () => realpath(target, callback); };
  const operation = ensureRemoteStorage(backend);
  assert.equal(typeof pending, 'function');
  backend.sftp = {};
  pending();
  await assert.rejects(operation, { code: 'SSH_CONNECTION_CHANGED' });
  backend.sftp = sftp;
  assert.ok(!fixture.calls.sftp.some(call => call[0] === 'MKDIR'));
});

test('disconnect stops initialization even if the SFTP operation never replies', options, async t => {
  const { fixture, backend } = await realContext(t);
  backend.sftp.realpath = () => {};
  const operation = ensureRemoteStorage(backend);
  const rejected = assert.rejects(operation, { code: 'SSH_CONNECTION_CHANGED' });
  await backend.disconnect();
  await rejected;
  assert.ok(!fixture.calls.sftp.some(call => call[0] === 'MKDIR'));
});

test('stalled SFTP times out and discards late callbacks without continuing writes', async () => {
  const client = new EventEmitter(), sftp = new EventEmitter();
  let lateCallback, mkdirCount = 0;
  sftp.realpath = (_target, callback) => { lateCallback = callback; };
  sftp.mkdir = () => { mkdirCount++; };
  const backend = { client, sftp, home: '/home/user' };
  await assert.rejects(ensureRemoteStorage(backend, { timeoutMs: 20 }), error => error.code === 'ETIMEDOUT' && error.message.includes('/home/user'));
  lateCallback(null, '/home/user');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mkdirCount, 0);
  for (const emitter of [client, sftp]) for (const event of ['end', 'close', 'error']) assert.equal(emitter.listenerCount(event), 0);
});
