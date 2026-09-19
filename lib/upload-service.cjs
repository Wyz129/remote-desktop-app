'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform, PassThrough } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { closed } = require('./sftp-stream.cjs');
const { posixQuote, normalizeRemote, DEFAULT_THRESHOLD } = require('./ssh-backend.cjs');

const abortError = () => Object.assign(new Error('上传已取消。'), { code: 'ABORT_ERR' });
const missing = error => error?.code === 2 || error?.code === 'ENOENT';
const validName = name => name && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
const numberedName = (name, number, directory) => {
  if (!number) return name;
  const ext = directory ? '' : path.posix.extname(name);
  return `${ext ? name.slice(0, -ext.length) : name} (${number})${ext}`;
};

class UploadService {
  constructor(backend) { this.backend = backend; this.transfers = new Map(); this.closed = false; }
  _call(method, ...args) { return new Promise((resolve, reject) => this.backend.sftp[method](...args, (error, result) => error ? reject(error) : resolve(result))); }
  _check(transfer) { if (transfer.controller.signal.aborted) throw abortError(); this.backend._requireConnected(); }
  cancel(id) { const transfer = this.transfers.get(String(id)); if (!transfer) return false; transfer.controller.abort(); return true; }
  async close() { this.closed = true; const transfers = [...this.transfers.values()]; transfers.forEach(transfer => transfer.controller.abort()); await Promise.allSettled(transfers.map(transfer => transfer.finished)); }
  async _plan(localPath, transfer, filesOnly = false) {
    const files = [], directories = []; let total = 0, count = 0;
    const visit = async (source, relative) => {
      this._check(transfer);
      if (relative.length > 128 || ++count > 100000) throw new Error('上传目录超过 128 层或 100000 个项目，请分批上传。');
      const stats = await fsp.lstat(source);
      if (stats.isSymbolicLink()) throw new Error(`上传不跟随本地符号链接，请直接选择其目标：${source}`);
      if (stats.isDirectory()) {
        if (filesOnly) throw new Error(`上传仅支持文件，不支持文件夹：${source}`);
        directories.push(relative);
        for (const name of await fsp.readdir(source)) {
          if (!validName(name)) throw new Error(`不支持的文件名：${name}`);
          await visit(path.join(source, name), [...relative, name]);
        }
      } else if (stats.isFile()) {
        if (!Number.isSafeInteger(stats.size) || stats.size < 0) throw new Error('本地文件大小无效。');
        total += stats.size;
        if (!Number.isSafeInteger(total)) throw new Error('上传总大小超过支持上限。');
        files.push({ source, relative, size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino, dev: stats.dev });
      } else throw new Error(`不支持上传特殊文件：${source}`);
    };
    await visit(localPath, []);
    return { files, directories, total, directory: directories.length > 0 };
  }
  async _file(file, target, transfer, method) {
    this._check(transfer);
    // Open before starting the remote write and verify identity. O_NOFOLLOW is
    // available on POSIX; lstat additionally rejects Windows links/reparse paths.
    const before = await fsp.lstat(file.source);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`上传源不再是普通文件：${file.source}`);
    const handle = await fsp.open(file.source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let remote, destination, source, completion; let transferred = 0;
    try {
      const opened = await handle.stat();
      if (opened.size !== file.size || opened.mtimeMs !== file.mtimeMs || opened.ino !== file.ino || opened.dev !== file.dev) throw new Error(`本地文件在上传前发生变化：${file.source}`);
      source = handle.createReadStream({ autoClose: false });
      if (method === 'ssh') {
        ({ stream: remote, completion } = await this.backend._execStream(`umask 077; set -C; cat > ${posixQuote(target)}`, transfer.controller.signal, { audit: transfer.audit }));
        remote.resume(); // Drain command stdout so SSH EOF/CLOSE is observed.
        destination = new PassThrough();
        destination.pipe(remote);
      } else { destination = this.backend.sftp.createWriteStream(target, { flags: 'wx', mode: 0o600 }); completion = closed(destination); }
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        transferred += chunk.length; transfer.done += chunk.length;
        try { transfer.report(method); callback(null, chunk); } catch (error) { callback(error); }
      } });
      const writing = pipeline(source, meter, destination, { signal: transfer.controller.signal });
      const remoteCompletion = completion.catch(error => { destination.destroy(error); throw error; });
      const outcomes = await Promise.allSettled([writing, remoteCompletion]);
      const failure = outcomes.find(outcome => outcome.status === 'rejected');
      if (failure) throw failure.reason;
      this._check(transfer);
      const after = await handle.stat();
      if (transferred !== file.size || after.size !== file.size || after.mtimeMs !== file.mtimeMs) throw new Error(`本地文件在上传期间发生变化，请重试：${file.source}`);
    } finally {
      if (remote && destination) destination.unpipe(remote);
      source?.destroy();
      await handle.close();
    }
  }
  async _removeOwned(staging, plan) {
    // Only remove names generated in our exclusively created staging directory;
    // never recursively discover or follow remote links during cleanup.
    const ignoreMissing = async promise => { try { await promise; } catch (error) { if (!missing(error)) throw error; } };
    for (const file of plan.files) await ignoreMissing(this._call('unlink', path.posix.join(staging, 'content', ...file.relative)));
    if (plan.directory) for (const relative of [...plan.directories].reverse()) await ignoreMissing(this._call('rmdir', path.posix.join(staging, 'content', ...relative)));
    await ignoreMissing(this._call('rmdir', staging));
  }
  async upload(localPath, remoteDirectory, options = {}) {
    if (this.closed) throw new Error('上传服务已关闭。');
    this.backend._requireConnected();
    if (typeof localPath !== 'string' || !path.isAbsolute(localPath)) throw new Error('本地上传路径必须是绝对路径。');
    const id = String(options.id || crypto.randomUUID());
    if (id.length > 200 || this.transfers.has(id)) throw new Error('上传任务 ID 无效或已存在。');
    const parent = normalizeRemote(remoteDirectory);
    const name = path.basename(path.resolve(localPath));
    if (!validName(name)) throw new Error('不能直接上传本地磁盘根目录。');
    const controller = new AbortController();
    const externalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    let finish; const transfer = { controller, audit: options.audit, done: 0, total: 0, destination: null, finished: new Promise(resolve => { finish = resolve; }) };
    transfer.report = method => options.onProgress?.({ id, direction: 'upload', source: localPath, path: transfer.destination, done: transfer.done, total: transfer.total, method });
    this.transfers.set(id, transfer);
    let staging, plan, committed = false, failure;
    try {
      transfer.report('preparing');
      plan = await this._plan(localPath, transfer, options.filesOnly); transfer.total = plan.total;
      const parentStats = await this.backend.stat(parent);
      if (!parentStats.isDirectory()) throw new Error('上传目标必须是服务器目录。');
      this._check(transfer);
      const candidate = path.posix.join(parent, `.rdesktop-upload-${crypto.randomBytes(16).toString('hex')}`);
      await this._call('mkdir', candidate, { mode: 0o700 }); staging = candidate;
      const content = path.posix.join(staging, 'content');
      const method = plan.directory || plan.total >= (this.backend.threshold || DEFAULT_THRESHOLD) ? 'sftp' : 'ssh';
      transfer.report(method);
      if (plan.directory) for (const relative of plan.directories) { this._check(transfer); await this._call('mkdir', path.posix.join(content, ...relative), { mode: 0o700 }); }
      for (const file of plan.files) await this._file(file, path.posix.join(content, ...file.relative), transfer, method);
      for (let number = 0; number < 100000; number++) {
        this._check(transfer);
        const target = path.posix.join(parent, numberedName(name, number, plan.directory));
        try { await this.backend.stat(target, false); continue; } catch (error) { if (!missing(error)) throw error; }
        try {
          // SSH_FXP_RENAME v3 is no-replace. Never use posix-rename here, which
          // explicitly overwrites, and never delete an existing destination.
          await this._call('rename', content, target); transfer.destination = target; committed = true; break;
        } catch (error) { try { await this.backend.stat(target, false); } catch { throw error; } }
      }
      if (!committed) throw new Error('服务器目标名称冲突过多。');
      transfer.report(method);
      return { id, path: transfer.destination, method, total: transfer.total, direction: 'upload' };
    } catch (error) { failure = error; throw error; }
    finally {
      try {
        if (staging && this.backend.sftp) {
          if (committed) await this._call('rmdir', staging); else await this._removeOwned(staging, plan);
        } else if (staging && failure) {
          failure.message += ` SSH 已断开，可能保留临时上传目录：${staging}。`;
        }
      } catch (cleanupError) {
        if (failure) failure.message += ` 临时上传目录清理失败：${staging}（${cleanupError.message}）。`;
        else if (!committed) throw cleanupError;
      } finally { options.signal?.removeEventListener('abort', externalAbort); this.transfers.delete(id); finish(); }
    }
  }
}

module.exports = { UploadService };
