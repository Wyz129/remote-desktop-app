'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerLocalPaths, transferIdentity, openTransferTarget } = require('../lib/transfer-targets.cjs');
test('local upload grants accept files and reject mixed folders, junctions and stale connections atomically', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdesktop-target-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'a.txt'), other = path.join(root, 'b.py'), directory = path.join(root, 'folder'), link = path.join(root, 'link');
  await fs.writeFile(file, 'safe'); await fs.writeFile(other, 'print(1)'); await fs.mkdir(directory); await fs.symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  const granted = new Set();
  await assert.rejects(registerLocalPaths([file, link], granted), /符号链接/); assert.equal(granted.size, 0);
  await assert.rejects(registerLocalPaths([file, directory], granted), /不支持文件夹/); assert.equal(granted.size, 0);
  await assert.rejects(registerLocalPaths([file], granted, () => false), /连接已改变/); assert.equal(granted.size, 0);
  assert.deepEqual(await registerLocalPaths([file, other, file], granted), [file, other]);
  assert.deepEqual([...granted], [file, other]);
});
test('invalid upload selections preserve all existing grants and never grant part of a failed batch', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdesktop-target-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'new.txt');
  await fs.writeFile(file, 'new');
  const granted = new Set(['previously-granted']);
  for (const values of [null, Array(1001).fill(file), [file, 'relative.txt'], [file, 42], [file, `${root}\0`], [file, path.join(root, 'missing.txt')]]) {
    await assert.rejects(registerLocalPaths(values, granted));
    assert.deepEqual([...granted], ['previously-granted']);
  }
  assert.deepEqual(await registerLocalPaths([], granted), []);
  assert.deepEqual([...granted], ['previously-granted']);
});
test('local transfer history opens directories and reports missing paths or operating system failures', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rdesktop-target-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'a.txt');
  await fs.writeFile(file, 'safe');
  const opened = []; const shell = { openPath: async value => { opened.push(value); return ''; } };
  assert.deepEqual(await openTransferTarget({ targetSide: 'local', targetDirectory: directory }, { shell }), { side: 'local' }); assert.deepEqual(opened, [directory]);
  await assert.rejects(openTransferTarget({ targetSide: 'local', targetDirectory: file }, { shell }), /目录已不存在/);
  await assert.rejects(openTransferTarget({ targetSide: 'local', targetDirectory: directory }, { shell: { openPath: async () => 'OS error' } }), /OS error/);
});
test('remote history opens only on the same verified account and accessible directory', async () => {
  const backend = { connected: true, desktopIdentity: JSON.stringify(['server', 22, 'user', 'fingerprint']), list: async value => { if (value === '/denied') throw new Error('Permission denied'); } };
  const task = { targetSide: 'remote', targetDirectory: '/projects', serverIdentity: transferIdentity(backend) };
  assert.deepEqual(await openTransferTarget(task, { getBackend: () => backend }), { side: 'remote', path: '/projects' });
  for (const key of ['host', 'username', 'port', 'fingerprint']) await assert.rejects(openTransferTarget({ ...task, serverIdentity: { ...task.serverIdentity, [key]: 'different' } }, { getBackend: () => backend }), /对应的服务器账号/);
  await assert.rejects(openTransferTarget({ ...task, targetDirectory: '/denied' }, { getBackend: () => backend }), /Permission denied/);
});
