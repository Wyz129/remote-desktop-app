'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const { VideoService, parseRange, MAX_VIDEO_SIZE } = require('../lib/video-service.cjs');
const { SshBackend } = require('../lib/ssh-backend.cjs');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');

const options = { timeout: 30000 };
const sample = Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'), Buffer.alloc(512 * 1024, 0x5a)]);
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const call = http.request(url, options, response => {
      const chunks = []; response.on('data', data => chunks.push(data)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    call.on('error', reject); call.end();
  });
}
async function setup(t) {
  const fixture = await createSshFixture();
  const backend = new SshBackend(); await backend.connect(fixture.config);
  const service = new VideoService(backend);
  t.after(async () => { await service.disconnect(); await backend.disconnect(); await fixture.close(); });
  const remotePath = await fixture.put('video.mp4', sample);
  return { fixture, backend, service, remotePath };
}

test('video bridge reads real SSH/SFTP byte ranges, suffix, HEAD and full response without a whole-file buffer', options, async t => {
  const { fixture, service, remotePath } = await setup(t);
  const media = await service.open(remotePath);
  assert.equal(media.mime, 'video/mp4'); assert.equal(media.path, remotePath); assert.equal(media.size, sample.length);
  assert.match(media.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}$/);
  const before = fixture.calls.sftp.length;
  const partial = await request(media.url, { headers: { Range: 'bytes=7000-7999' } });
  assert.equal(partial.status, 206); assert.deepEqual(partial.body, sample.subarray(7000, 8000));
  assert.equal(partial.headers['content-range'], `bytes 7000-7999/${sample.length}`);
  assert.equal(partial.headers['accept-ranges'], 'bytes');
  assert.equal(partial.headers['content-type'], 'video/mp4');
  const reads = fixture.calls.sftp.slice(before).filter(call => call[0] === 'READ');
  assert.equal(reads.length, 1); assert.equal(reads[0][2], 7000); assert.equal(reads[0][3], 1000);
  assert.equal(partial.headers['cache-control'], 'no-store'); assert.equal(partial.headers['x-content-type-options'], 'nosniff');
  const suffix = await request(media.url, { headers: { Range: 'bytes=-45' } });
  assert.equal(suffix.status, 206); assert.deepEqual(suffix.body, sample.subarray(-45));
  const headBefore = fixture.calls.sftp.length;
  const head = await request(media.url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(Number(head.headers['content-length']), sample.length);
  assert.equal(fixture.calls.sftp.slice(headBefore).filter(call => call[0] === 'READ').length, 0);
  const full = await request(media.url); assert.equal(full.status, 200); assert.deepEqual(full.body, sample);
  const noMatch = await request(media.url, { headers: { 'If-Match': '"other"' } }); assert.equal(noMatch.status, 412);
});

test('video capability cannot read sibling paths, accept external origins or hosts, or execute writes', options, async t => {
  const { service, remotePath } = await setup(t), media = await service.open(remotePath);
  assert.equal((await request(new URL('/video.mp4', media.url))).status, 404);
  assert.equal((await request(`${media.url}?path=/etc/passwd`)).status, 404);
  assert.equal((await request(`${media.url}/../secret`)).status, 404);
  assert.equal((await request(media.url, { method: 'POST' })).status, 405);
  assert.equal((await request(media.url, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await request(media.url, { headers: { Host: 'untrusted.example' } })).status, 403);
  assert.equal((await request(media.url, { headers: { Range: 'bytes=0-7', Origin: 'null' } })).status, 206);
  assert.equal(service.release(media.id), true); assert.equal(service.release(media.id), false);
  assert.equal((await request(media.url)).status, 404);
});

test('video bridge rejects malformed, multiple and unsatisfiable ranges without reading bytes', options, async t => {
  const { fixture, service, remotePath } = await setup(t), media = await service.open(remotePath);
  const before = fixture.calls.sftp.length;
  for (const Range of ['bytes=-0', 'bytes=4-3', `bytes=${sample.length}-`, 'bytes=0-1,4-5', 'bytes=9007199254740992-', 'items=0-1', 'bytes=-', 'bytes=a-b']) {
    const result = await request(media.url, { headers: { Range } });
    assert.equal(result.status, 416, Range); assert.equal(result.headers['content-range'], `bytes */${sample.length}`);
  }
  assert.equal(fixture.calls.sftp.slice(before).filter(call => call[0] === 'READ').length, 0);
  assert.deepEqual(parseRange('bytes=5-999', 10), { start: 5, end: 9, partial: true });
  assert.deepEqual(parseRange('bytes=-999', 10), { start: 0, end: 9, partial: true });
});

test('permission, unsupported containers, directories, empty, oversize and disguised text fail before playback', options, async t => {
  const { fixture, service, remotePath } = await setup(t);
  fixture.unreadableFiles.add(remotePath); await assert.rejects(service.open(remotePath), /无访问权限/);
  await assert.rejects(service.open(await fixture.put('other.avi', sample)), /VLC/);
  await assert.rejects(service.open(await fixture.put('empty.mp4', '')), /普通文件/);
  await assert.rejects(service.open(await fixture.put('script.mp4', '<script>alert(1)</script>')), /不匹配/);
  await fs.mkdir(fixture.mapPath(`${fixture.home}/folder.mp4`)); await assert.rejects(service.open(`${fixture.home}/folder.mp4`), /普通文件/);
  const fake = { connected: true, client: {}, sftp: {
    realpath: (value, done) => done(null, value), stat: (value, done) => done(null, { isFile: () => true }),
    open: (value, mode, done) => done(null, Buffer.from('handle')),
    fstat: (handle, done) => done(null, { isFile: () => true, size: MAX_VIDEO_SIZE + 1 }), close: (handle, done) => done(),
  } };
  const oversized = new VideoService(fake); await assert.rejects(oversized.open('/large.mp4'), /8 TiB/); await oversized.disconnect();
});

test('remote revision changes, revocation and SSH replacement invalidate existing video URLs', options, async t => {
  const { fixture, backend, service, remotePath } = await setup(t);
  const media = await service.open(remotePath);
  await fs.appendFile(fixture.mapPath(remotePath), 'changed');
  const changed = await request(media.url, { headers: { Range: 'bytes=0-10' } }); assert.equal(changed.status, 409);
  const reopened = await service.open(remotePath); assert.notEqual(reopened.url, media.url);
  assert.equal((await request(reopened.url, { headers: { Range: 'bytes=0-10' } })).status, 206);
  const original = backend.client; backend.client = {};
  assert.equal((await request(reopened.url)).status, 410);
  await assert.rejects(service.open(remotePath), /SSH/); backend.client = original;
  await service.disconnect(); await service.disconnect(); await assert.rejects(request(reopened.url));
});

test('symlink replacement cannot expand the selected video capability, and SSH close revokes the bridge', options, async t => {
  const { fixture, backend, service, remotePath } = await setup(t), media = await service.open(remotePath);
  const other = await fixture.put('other.mp4', sample);
  fixture.link(remotePath, other);
  assert.equal((await request(media.url, { headers: { Range: 'bytes=0-15' } })).status, 409);
  await backend.disconnect();
  await assert.rejects(service.open(other), /SSH/);
  try { const result = await request(media.url); assert.equal(result.status, 410); } catch (error) { assert.ok(['ECONNREFUSED', 'ECONNRESET'].includes(error.code), error.message); }
});

test('cancelling a playback response stops range reads and release interrupts pending media', options, async t => {
  const { fixture, service } = await setup(t);
  const remotePath = await fixture.put('large.mp4', Buffer.concat([sample, Buffer.alloc(4 * 1024 * 1024, 1)]));
  fixture.slowReads.add(remotePath);
  const media = await service.open(remotePath);
  let received = 0;
  await new Promise((resolve, reject) => {
    const call = http.get(media.url, response => {
      response.once('data', data => { received += data.length; response.destroy(); call.destroy(); resolve(); });
      response.on('error', () => {});
    }); call.on('error', reject);
  });
  assert.ok(received > 0 && received < sample.length);
  const before = fixture.calls.sftp.filter(call => call[0] === 'READ').length;
  await new Promise(resolve => setTimeout(resolve, 200));
  const after = fixture.calls.sftp.filter(call => call[0] === 'READ').length;
  // One already-issued 256 KiB SFTP read may finish (ssh2 splits it into
  // approximately 32 KiB packets); cancellation must prevent the next chunk.
  assert.ok(after <= before + 9, `cancel continued reading: ${before} -> ${after}`);
  await new Promise((resolve, reject) => {
    const call = http.get(media.url, response => {
      response.once('data', () => service.release(media.id));
      response.on('error', error => error.code === 'ECONNRESET' ? resolve() : reject(error));
      response.on('end', () => reject(new Error('Revoked stream unexpectedly completed')));
    }); call.on('error', reject);
  });
  assert.equal((await request(media.url)).status, 404);
});
