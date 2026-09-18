'use strict';
const path = require('node:path').posix;
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { readBuffer } = require('./sftp-stream.cjs');
const { normalizeRemote } = require('./ssh-backend.cjs');
const LIMIT = 16 * 1024 * 1024;
const revision = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
class DocumentService {
  constructor(backend) { this.backend = backend; this.connection = backend.client; this.sftp = backend.sftp; this.queue = Promise.resolve(); }
  assertConnected() { if (!this.backend.connected || this.backend.client !== this.connection || this.backend.sftp !== this.sftp) throw new Error('SSH 连接已改变，文档操作已取消。'); }
  call(method, ...args) {
    this.assertConnected();
    return new Promise((resolve, reject) => this.sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)));
  }
  async read(remotePath) {
    const target = normalizeRemote(await this.call('realpath', normalizeRemote(remotePath)));
    this.assertConnected();
    const permission = await this.backend.checkFileAccess(target);
    this.assertConnected();
    if (!permission.readable) throw new Error(`无访问权限：${target}`);
    const stats = await this.call('stat', target);
    if (!stats.isFile() || stats.size > LIMIT) throw new Error('文档须为不超过 16 MiB 的普通文件；更大文件可用 Vim 或下载。');
    const bytes = await readBuffer(this.sftp, target, LIMIT);
    this.assertConnected();
    if (bytes.includes(0)) throw new Error('该文件包含二进制内容，请下载后使用对应应用打开。');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('工作台支持 UTF-8 文本；此文件编码无法识别，请使用 Vim 转换编码。'); }
    return { path: target, name: path.basename(target), text, revision: revision(bytes), readOnly: !permission.writable, bom: bytes.subarray(0,3).equals(Buffer.from([239,187,191])) };
  }
  save(document, text) {
    const task = this.queue.then(async () => {
      if (typeof text !== 'string' || Buffer.byteLength(text) > LIMIT) throw new Error('文档超过 16 MiB。');
      this.assertConnected();
      if (document.readOnly) throw new Error('无编辑权限：请使用另存为。');
      const target = normalizeRemote(document.path), current = await this.read(target);
      if (current.readOnly) throw new Error('无编辑权限：当前账号不能保存此文件。');
      if (current.path !== target || current.revision !== document.revision) throw Object.assign(new Error('远程文件已被其他程序修改。请重新载入或另存为，原文件未覆盖。'), { code: 'CONFLICT' });
      const stats = await this.call('stat', target);
      const bytes = Buffer.from((document.bom ? '\uFEFF' : '') + text, 'utf8');
      const temporary = `${target}.rdesktop-save-${crypto.randomUUID()}`;
      try {
        await this.call('writeFile', temporary, bytes, { flag: 'wx', mode: stats.mode & 0o777 });
        const latest = await this.read(target);
        if (latest.revision !== document.revision || latest.path !== target) throw Object.assign(new Error('保存期间远程文件发生变化，原文件未覆盖。'), { code: 'CONFLICT' });
        await this.call('ext_openssh_rename', temporary, target);
        return { ...document, text, revision: revision(bytes), readOnly: false };
      } finally { try { await this.call('unlink', temporary); } catch(error) { if (![2,'ENOENT'].includes(error.code)) this.cleanupError = error.message; } }
    });
    this.queue = task.catch(() => {}); return task;
  }
  async saveAs(remotePath, text) {
    const target = normalizeRemote(remotePath);
    if (typeof text !== 'string' || Buffer.byteLength(text) > LIMIT) throw new Error('文档超过 16 MiB。');
    await this.call('writeFile', target, Buffer.from(text), { flag: 'wx', mode: 0o600 });
    return this.read(target);
  }
}
module.exports = { DocumentService, LIMIT };
