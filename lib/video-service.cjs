'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path').posix;
const { normalizeRemote } = require('./ssh-backend.cjs');

const VIDEO_TYPES = Object.freeze({ '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.ogg': 'video/ogg', '.mov': 'video/quicktime' });
const MAX_VIDEO_SIZE = 8 * 1024 ** 4;
const READ_SIZE = 256 * 1024;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const revision = stats => `${stats.size}:${stats.mtimeMs ?? stats.mtime}:${stats.mode}`;

function parseRange(value, size) {
  if (value === undefined) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw failure('Unsupported byte range', 416);
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw failure('Unsupported byte range', 416);
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) throw failure('Unsupported byte range', 416);
    end = Math.min(end, size - 1);
  }
  return { start, end, partial: true };
}

function matchesContainer(bytes, extension) {
  if (extension === '.webm') return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (extension === '.ogg' || extension === '.ogv') return bytes.subarray(0, 4).toString('ascii') === 'OggS';
  const atom = bytes.subarray(4, 8).toString('ascii');
  return atom === 'ftyp' || (extension === '.mov' && ['moov', 'mdat', 'wide', 'free'].includes(atom));
}

// Each opaque URL grants read access to one selected video on one SSH session.
// It never accepts remote paths in HTTP requests and never exposes credentials.
class VideoService {
  constructor(backend) {
    this.backend = backend; this.connection = backend.client; this.sftp = backend.sftp;
    this.items = new Map(); this.sockets = new Set(); this.server = null; this.starting = null; this.disposed = false;
    this.onDisconnected = () => { void this.disconnect(); };
    this.connection?.once?.('close', this.onDisconnected);
  }
  assertConnected() {
    if (this.disposed || !this.backend.connected || this.backend.client !== this.connection || this.backend.sftp !== this.sftp) throw failure('SSH 连接已改变，请重新打开视频。', 410);
  }
  call(method, ...args) {
    this.assertConnected();
    return new Promise((resolve, reject) => this.sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)));
  }
  async closeHandle(handle) {
    if (!handle) return;
    await new Promise(resolve => { try { this.sftp.close(handle, () => resolve()); } catch { resolve(); } });
  }
  async read(handle, position, length) {
    const bytes = Buffer.allocUnsafe(length);
    const count = await this.call('read', handle, bytes, 0, length, position);
    this.assertConnected();
    return bytes.subarray(0, count);
  }
  async listen() {
    if (this.starting) return this.starting;
    this.assertConnected();
    this.server = http.createServer((request, response) => { void this.serve(request, response); });
    this.server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    this.server.requestTimeout = 30000; this.server.headersTimeout = 10000;
    this.starting = new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    await this.starting;
    this.assertConnected();
  }
  async open(remotePath) {
    this.assertConnected();
    if (this.items.size >= 16) throw new Error('最多同时打开 16 个视频，请先关闭不需要的播放器。');
    const target = normalizeRemote(await this.call('realpath', normalizeRemote(remotePath)));
    const extension = path.extname(target).toLowerCase(), mime = VIDEO_TYPES[extension];
    if (!mime) throw new Error('视频播放器支持 MP4、M4V、WebM、OGV、OGG 和 MOV 容器；其他格式请下载后使用 VLC 等播放器打开。');
    let handle, stats;
    try {
      const initial = await this.call('stat', target);
      if (!initial.isFile()) throw new Error('视频播放器仅接受普通文件。');
      handle = await this.call('open', target, 'r');
      stats = await this.call('fstat', handle);
      if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 8 || stats.size > MAX_VIDEO_SIZE) throw new Error('视频须为 8 字节至 8 TiB 的普通文件。');
      if (!matchesContainer(await this.read(handle, 0, Math.min(64, stats.size)), extension)) throw new Error('文件内容与视频容器不匹配，可能已损坏；请下载后检查原文件。');
      if (revision(await this.call('fstat', handle)) !== revision(stats)) throw failure('视频文件正在变化，请写入完成后重新打开。', 409);
    } catch (error) {
      if ([3, 'EACCES', 'EPERM'].includes(error.code)) throw new Error(`无访问权限：${target}`);
      throw error;
    } finally { await this.closeHandle(handle); }
    await this.listen(); this.assertConnected();
    if (this.items.size >= 16) throw new Error('最多同时打开 16 个视频，请先关闭不需要的播放器。');
    const id = crypto.randomUUID(), token = crypto.randomBytes(32).toString('hex');
    const item = { id, token, path: target, mime, name: path.basename(target), size: stats.size, revision: revision(stats), etag: `"${crypto.randomBytes(20).toString('hex')}"`, requests: new Set(), closed: false };
    this.items.set(id, item);
    return { id, url: `http://127.0.0.1:${this.server.address().port}/${token}`, path: target, name: item.name, mime, size: item.size };
  }
  async serve(request, response) {
    let handle, item;
    const operation = { cancelled: false, response };
    response.on('close', () => { operation.cancelled = true; });
    const active = () => { this.assertConnected(); if (operation.cancelled || item?.closed) throw failure('Playback cancelled', 410); };
    const abort = () => { operation.cancelled = true; response.destroy(); };
    operation.abort = abort;
    try {
      const address = this.server.address();
      if (!address || request.headers.host !== `127.0.0.1:${address.port}`) throw failure('Invalid host', 403);
      if (request.headers.origin && request.headers.origin !== 'null') throw failure('Origin denied', 403);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
      response.setHeader('Access-Control-Allow-Origin', 'null');
      if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); throw failure('Only media reads are supported', 405); }
      // Exact URL matching deliberately forbids queries, traversal and ranges of
      // sibling files, even for a caller that knows an existing capability.
      item = [...this.items.values()].find(value => request.url === `/${value.token}` && !value.closed);
      if (!item) throw failure('Media URL expired', 404);
      if (item.requests.size >= 6) throw failure('Too many media requests', 429);
      item.requests.add(operation); active();
      if (normalizeRemote(await this.call('realpath', item.path)) !== item.path) throw failure('Remote video path changed; reopen it', 409);
      active();
      handle = await this.call('open', item.path, 'r'); active();
      const stats = await this.call('fstat', handle); active();
      if (!stats.isFile() || revision(stats) !== item.revision) throw failure('Remote video changed; reopen it', 409);
      if (request.headers['if-match'] && request.headers['if-match'] !== item.etag && request.headers['if-match'] !== '*') throw failure('Media revision differs', 412);
      response.setHeader('Accept-Ranges', 'bytes'); response.setHeader('ETag', item.etag);
      const range = parseRange(request.headers['if-range'] && request.headers['if-range'] !== item.etag ? undefined : request.headers.range, item.size);
      response.setHeader('Content-Type', item.mime);
      response.setHeader('Content-Length', range.end - range.start + 1);
      if (range.partial) response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${item.size}`);
      response.statusCode = range.partial ? 206 : 200;
      if (request.method === 'HEAD') { response.end(); return; }
      let position = range.start;
      while (position <= range.end) {
        active();
        const bytes = await this.read(handle, position, Math.min(READ_SIZE, range.end - position + 1)); active();
        if (!bytes.length) throw failure('Remote video was truncated', 409);
        position += bytes.length;
        // Check the last chunk before returning it, so an interrupted/truncated
        // revision cannot masquerade as a successfully completed range.
        if (position > range.end && revision(await this.call('fstat', handle)) !== item.revision) throw failure('Remote video changed; reopen it', 409);
        active();
        if (!response.write(bytes)) await new Promise((resolve, reject) => {
          const clean = () => { response.off('drain', drained); response.off('close', closed); response.off('error', failed); };
          const drained = () => { clean(); resolve(); };
          const closed = () => { clean(); reject(failure('Playback cancelled', 410)); };
          const failed = error => { clean(); reject(error); };
          response.once('drain', drained); response.once('close', closed); response.once('error', failed);
        });
      }
      response.end();
    } catch (error) {
      if (response.headersSent || response.destroyed) response.destroy();
      else {
        response.removeHeader('Content-Length'); response.removeHeader('Content-Range');
        const status = error.status || ([3, 'EACCES', 'EPERM'].includes(error.code) ? 403 : 502);
        if (status === 416 && item) response.setHeader('Content-Range', `bytes */${item.size}`);
        response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(status === 409 ? 'Remote video changed; reopen it' : 'Video unavailable');
      }
    } finally { item?.requests.delete(operation); await this.closeHandle(handle); }
  }
  release(id) {
    const item = this.items.get(id);
    if (!item) return false;
    item.closed = true; this.items.delete(id);
    for (const request of item.requests) request.abort();
    return true;
  }
  async disconnect() {
    if (this.disposed) return;
    this.disposed = true; this.connection?.off?.('close', this.onDisconnected);
    for (const id of this.items.keys()) this.release(id);
    for (const socket of this.sockets) socket.destroy();
    if (this.server) { await this.starting?.catch(() => {}); await new Promise(resolve => this.server.close(resolve)); }
  }
}

module.exports = { VideoService, VIDEO_TYPES, MAX_VIDEO_SIZE, parseRange };
