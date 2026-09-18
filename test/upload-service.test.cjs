'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { SshBackend } = require('../lib/ssh-backend.cjs');
const { UploadService } = require('../lib/upload-service.cjs');
const { createUploadFixture } = require('./helpers/upload-ssh-fixture.cjs');
const options = { timeout: 30000 };
async function setup(t, settings = {}) {
  const fixture = await createUploadFixture(settings), backend = new SshBackend({ threshold: 32768 });
  const uploader = new UploadService(backend);
  t.after(async () => { await uploader.close(); await backend.disconnect(); await fixture.close(); });
  await backend.connect(fixture.config); return { fixture, backend, uploader };
}
async function localFile(fixture, name, bytes) { const target = path.join(fixture.localRoot, name); await fs.writeFile(target, bytes); return target; }

test('small single file uses a real SSH write stream, quotes names, and reports completion', options, async t => {
  const { fixture, uploader } = await setup(t); const bytes = Buffer.from('你好\ncontent\0binary'); const progress = [];
  const source = await localFile(fixture, "quote ' example.py", bytes);
  const result = await uploader.upload(source, fixture.home, { id: 'small', onProgress: value => progress.push(value) });
  assert.equal(result.method, 'ssh'); assert.deepEqual(await fs.readFile(fixture.mapPath(result.path)), bytes);
  assert.equal(progress.at(-1).done, bytes.length); assert.equal(progress.at(-1).direction, 'upload');
  assert.ok(fixture.calls.exec.some(command => command.startsWith('umask 077; set -C; cat > ')));
  assert.equal(fixture.calls.sftp.filter(call => call[0] === 'WRITE').length, 0);
  assert.deepEqual(await fs.readdir(fixture.remoteRoot), ["quote ' example.py"]);
});

test('large file and nested directory use real SFTP and preserve bytes plus empty directories', options, async t => {
  const { fixture, uploader } = await setup(t); const bytes = crypto.randomBytes(131072);
  const source = await localFile(fixture, 'large.bin', bytes); const result = await uploader.upload(source, fixture.home);
  assert.equal(result.method, 'sftp'); assert.deepEqual(await fs.readFile(fixture.mapPath(result.path)), bytes);
  const project = path.join(fixture.localRoot, 'project'); await fs.mkdir(path.join(project, 'empty'), { recursive: true });
  await fs.writeFile(path.join(project, 'file.txt'), 'project bytes');
  const directory = await uploader.upload(project, fixture.home);
  assert.equal(directory.method, 'sftp'); assert.equal(await fs.readFile(fixture.mapPath(directory.path + '/file.txt'), 'utf8'), 'project bytes');
  assert.ok((await fs.stat(fixture.mapPath(directory.path + '/empty'))).isDirectory());
  assert.ok(fixture.calls.sftp.some(call => call[0] === 'WRITE'));
  assert.equal(fixture.calls.exec.filter(command => command.startsWith('umask')).length, 0);
});

test('concurrent same-name uploads never overwrite a file or merge a directory', options, async t => {
  const { fixture, uploader } = await setup(t); const source = await localFile(fixture, 'sample.txt', 'new');
  await fs.writeFile(fixture.mapPath('/uploads/sample.txt'), 'existing');
  const results = await Promise.all([uploader.upload(source, fixture.home), uploader.upload(source, fixture.home)]);
  assert.equal(new Set(results.map(result => result.path)).size, 2);
  assert.equal(await fs.readFile(fixture.mapPath('/uploads/sample.txt'), 'utf8'), 'existing');
  const project = path.join(fixture.localRoot, 'folder'); await fs.mkdir(project); await fs.mkdir(fixture.mapPath('/uploads/folder')); await fs.writeFile(fixture.mapPath('/uploads/folder/user.txt'), 'safe');
  const result = await uploader.upload(project, fixture.home);
  assert.equal(result.path, '/uploads/folder (1)'); assert.equal(await fs.readFile(fixture.mapPath('/uploads/folder/user.txt'), 'utf8'), 'safe');
});

test('cancellation removes owned partial upload and keeps existing remote files', options, async t => {
  const { fixture, uploader } = await setup(t, { slowWrites: true }); const source = await localFile(fixture, 'cancel.bin', Buffer.alloc(2 * 1024 * 1024));
  await fs.writeFile(fixture.mapPath('/uploads/user.txt'), 'safe');
  await assert.rejects(uploader.upload(source, fixture.home, { id: 'cancel', onProgress: value => { if (value.done > 0) uploader.cancel('cancel'); } }), error => error.code === 'ABORT_ERR');
  assert.deepEqual(await fs.readdir(fixture.remoteRoot), ['user.txt']); assert.equal(uploader.transfers.size, 0);
});

test('unreadable target and changed local source fail without a completed destination', options, async t => {
  const { fixture, uploader } = await setup(t); const source = await localFile(fixture, 'change.txt', 'first');
  fixture.denied.add(fixture.home); await assert.rejects(uploader.upload(source, fixture.home), /Permission denied/); fixture.denied.clear();
  let changed = false;
  await assert.rejects(uploader.upload(source, fixture.home, { onProgress: value => { if (value.method !== 'preparing' && !changed) { changed = true; require('node:fs').appendFileSync(source, 'changed'); } } }), /发生变化/);
  assert.deepEqual(await fs.readdir(fixture.remoteRoot), []);
});

test('closing uploader aborts active transfers and prevents new tasks', options, async t => {
  const { fixture, uploader } = await setup(t, { slowWrites: true }); const source = await localFile(fixture, 'close.bin', Buffer.alloc(2 * 1024 * 1024));
  let close;
  const operation = uploader.upload(source, fixture.home, { onProgress: value => { if (value.done > 0 && !close) close = uploader.close(); } });
  await assert.rejects(operation, error => error.code === 'ABORT_ERR'); await close;
  assert.deepEqual(await fs.readdir(fixture.remoteRoot), []); await assert.rejects(uploader.upload(source, fixture.home), /已关闭/);
});

test('nested directory links are rejected before any remote upload directory is created', options, async t => {
  const { fixture, uploader } = await setup(t);
  const source = path.join(fixture.localRoot, 'with-link'), target = path.join(fixture.localRoot, 'target');
  await fs.mkdir(source); await fs.mkdir(target); await fs.writeFile(path.join(target, 'outside.txt'), 'do not follow');
  await fs.symlink(target, path.join(source, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(uploader.upload(source, fixture.home), /不跟随本地符号链接/);
  assert.deepEqual(await fs.readdir(fixture.remoteRoot), []);
});
