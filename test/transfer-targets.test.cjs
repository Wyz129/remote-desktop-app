'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerLocalPaths, transferIdentity, openTransferTarget } = require('../lib/transfer-targets.cjs');
test('mixed local grants validate real files and directories, reject junctions and stale connections atomically', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdesktop-target-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'a.txt'), directory = path.join(root, 'folder'), link = path.join(root, 'link');
  await fs.writeFile(file, 'safe'); await fs.mkdir(directory); await fs.symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  const granted = new Set();
  await assert.rejects(registerLocalPaths([file, link], granted), /符号链接/); assert.equal(granted.size, 0);
  await assert.rejects(registerLocalPaths([file], granted, () => false), /连接已改变/); assert.equal(granted.size, 0);
  assert.deepEqual(await registerLocalPaths([file, directory, file], granted), [file, directory]);
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
