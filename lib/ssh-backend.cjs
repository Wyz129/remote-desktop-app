'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform, PassThrough } = require('node:stream');
const { Client } = require('ssh2');
const { readBuffer, closed } = require('./sftp-stream.cjs');

const DEFAULT_THRESHOLD = 50 * 1024 * 1024;
const MAX_IMAGE_SIZE = 25 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.bmp', 'image/bmp'],
  ['.avif', 'image/avif']
]);

function posixQuote(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('无效的远程路径。');
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function normalizeRemote(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) throw new Error('远程路径必须是绝对路径。');
  return path.posix.normalize(value);
}
function safeName(value) {
  let clean = String(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
  if (!clean || clean === '.' || clean === '..') clean = 'download';
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(clean)) clean = `_${clean}`;
  return clean.slice(0, 180).replace(/[. ]+$/g, '') || 'download';
}
function numberedName(name, index) {
  if (!index) return name;
  const ext = path.extname(name);
  return `${ext ? name.slice(0, -ext.length) : name} (${index})${ext}`;
}
async function uniqueDestination(dir, name, exists = fs.existsSync) {
  const clean = safeName(name);
  for (let index = 0; index < 100000; index += 1) {
    const candidate = path.join(dir, numberedName(clean, index));
    if (!exists(candidate)) return candidate;
  }
  throw new Error('本地目标文件名冲突过多。');
}
function validEntryName(name) { return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !/[\/\\\0]/.test(name); }
function isDirectory(stats) { return Boolean(stats?.isDirectory?.()); }
function isFile(stats) { return typeof stats?.isFile === 'function' ? stats.isFile() : !isDirectory(stats) && !isLink(stats); }
function isLink(stats) { return Boolean(stats?.isSymbolicLink?.()); }
function abortError() { return Object.assign(new Error('下载已取消。'), { code: 'ABORT_ERR' }); }
function isMissing(error) { return error?.code === 2 || error?.code === 'ENOENT'; }
function asError(error) { return error instanceof Error ? error : new Error(String(error)); }

class SshBackend {
  constructor(options = {}) {
    this.clientFactory = options.clientFactory || (() => new Client());
    // Main supplies Electron app.getPath('downloads'), which follows the system
    // Known Folder / XDG setting instead of assuming a home/Downloads path.
    this.downloadsPath = options.downloadsPath || null;
    this.verifyHost = options.verifyHost;
    this.onDisconnect = options.onDisconnect;
    this.threshold = Number(options.threshold) > 0 ? Number(options.threshold) : DEFAULT_THRESHOLD;
    this.client = null; this.connectingClient = null; this.sftp = null; this.home = null; this.desktop = null;
    this.hostFingerprint = null;
    this.downloads = new Map(); this.shells = new Map(); this.pendingShells = new Map(); this.terminalSessions = new Map();
  }
  get connected() { return Boolean(this.client && this.sftp && this.home); }
  _requireConnected() { if (!this.connected) throw new Error('尚未连接 SSH。'); }

  async connect(input = {}) {
    await this.disconnect();
    const host = String(input.host || '').trim(); const username = String(input.username || '').trim();
    const port = input.port === undefined || input.port === '' ? 22 : Number(input.port);
    if (!host || !username) throw new Error('请输入主机和用户名。');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须在 1–65535 之间。');
    const expected = String(input.hostKeyFingerprint || '').trim();
    const client = this.clientFactory(); this.connectingClient = client;
    let observed = null; let verified = false; let verificationError;
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error) => { if (!settled) { settled = true; reject(verificationError || error); } };
        client.once('ready', () => {
          if (!verified) { fail(new Error('未确认 SSH 主机密钥，连接已拒绝。')); return; }
          if (!settled) { settled = true; resolve(); }
        });
        client.on('error', fail);
        client.once('close', () => { if (!settled) fail(new Error('SSH 连接在认证完成前关闭。')); });
        const config = {
          host, port, username, readyTimeout: 120000, keepaliveInterval: 15000,
          hostVerifier: (key, callback) => {
            observed = `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
            const verify = async () => {
              if (expected) {
                if (expected.replace(/=+$/, '') !== observed) throw new Error(`SSH 主机密钥不匹配。当前指纹：${observed}`);
                return true;
              }
              if (typeof this.verifyHost !== 'function') throw new Error(`未知 SSH 主机密钥，请核验指纹后连接：${observed}`);
              if (await this.verifyHost({ host, port, username, fingerprint: observed }) !== true) throw new Error('已取消 SSH 主机密钥确认。');
              return true;
            };
            verify().then(value => { verified = value; callback(value); }, error => { verificationError = asError(error); callback(false); });
          }
        };
        if (input.privateKey) config.privateKey = input.privateKey;
        if (input.passphrase) config.passphrase = input.passphrase;
        if (input.password) config.password = input.password;
        if (input.agent) config.agent = input.agent;
        try { client.connect(config); } catch (error) { fail(error); }
      });
      if (this.connectingClient !== client) throw new Error('SSH 连接已取消。');
      this.client = client; this.connectingClient = null; this.hostFingerprint = observed;
      const loginHome = await this.execText(`printf '%s' "$HOME"`);
      if (/[\r\n]/.test(loginHome)) throw new Error('SSH 登录环境返回了无效主目录。');
      this.home = normalizeRemote(loginHome);
      this.sftp = await new Promise((resolve, reject) => client.sftp((error, session) => error ? reject(error) : resolve(session)));
      client.on('close', () => {
        if (this.client !== client) return;
        this.client = null; this.sftp = null; this.home = null; this.desktop = null;
        for (const transfer of this.downloads.values()) transfer.controller.abort();
        this.onDisconnect?.();
      });
      return { username, host, home: this.home, hostFingerprint: observed, verified };
    } catch (error) {
      try { client.end(); } catch {}
      if (this.connectingClient === client) this.connectingClient = null;
      if (this.client === client) { this.client = null; this.sftp = null; this.home = null; }
      throw error;
    }
  }

  async disconnect() {
    const transfers = [...this.downloads.values()];
    for (const transfer of transfers) transfer.controller.abort();
    for (const id of [...this.shells.keys(), ...this.pendingShells.keys()]) this.closeShell(id);
    const client = this.client; const connectingClient = this.connectingClient;
    this.connectingClient = null;
    this.client = null; this.sftp = null; this.home = null; this.desktop = null;
    this._desktopService = null;
    try { client?.end(); } catch {}
    try { connectingClient?.end(); } catch {}
    await Promise.allSettled(transfers.map(transfer => transfer.finished));
  }

  async execText(command, maxBytes = 1024 * 1024) {
    if (!this.client) throw new Error('尚未连接 SSH。');
    const { stream, completion } = await this._execStream(command);
    const chunks = []; let size = 0;
    const reading = (async () => {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > maxBytes) { stream.destroy(); throw new Error('远程命令输出超过安全上限。'); }
        chunks.push(Buffer.from(chunk));
      }
    })();
    await Promise.all([reading, completion]);
    return Buffer.concat(chunks).toString('utf8');
  }

  _execStream(command, signal) {
    if (!this.client) return Promise.reject(new Error('尚未连接 SSH。'));
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      this.client.exec(command, (error, stream) => {
        if (error) return reject(error);
        if (signal?.aborted) { stream.destroy(); reject(abortError()); return; }
        let stderr = '';
        stream.stderr?.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString().slice(0, 4096 - stderr.length); });
        const completion = new Promise((done, fail) => {
          const abort = () => { stream.destroy(abortError()); fail(abortError()); };
          const cleanup = () => signal?.removeEventListener('abort', abort);
          signal?.addEventListener('abort', abort, { once: true });
          stream.once('error', error => { cleanup(); fail(error); });
          stream.once('close', (code, exitSignal) => {
            cleanup();
            if (signal?.aborted) fail(abortError());
            else if (code === 0 && !exitSignal) done();
            else fail(new Error(`SSH 命令失败（退出码 ${code ?? '未知'}）：${stderr.trim()}`));
          });
        });
        // Attach a rejection handler before callers set up the stream pipeline.
        completion.catch(() => {});
        resolve({ stream, completion });
      });
    });
  }

  async stat(remotePath, followLinks = true) {
    this._requireConnected(); const target = normalizeRemote(remotePath);
    const method = followLinks ? 'stat' : 'lstat';
    return new Promise((resolve, reject) => this.sftp[method](target, (error, stats) => error ? reject(error) : resolve(stats)));
  }
  async _entries(remotePath) {
    this._requireConnected();
    const entries = await new Promise((resolve, reject) => this.sftp.readdir(normalizeRemote(remotePath), (error, list) => error ? reject(error) : resolve(list || [])));
    for (const entry of entries) if (!validEntryName(entry.filename)) throw new Error('服务器返回了不安全的目录项名称。');
    return entries;
  }
  async list(remotePath = this.desktop || this.home) {
    const target = normalizeRemote(remotePath);
    const entries = await this._entries(target);
    return Promise.all(entries.map(async entry => {
      let attrs = entry.attrs;
      if (isLink(attrs)) { try { attrs = await this.stat(path.posix.join(target, entry.filename)); } catch {} }
      return {
        name: entry.filename, path: path.posix.join(target, entry.filename),
        type: isDirectory(attrs) ? 'directory' : 'file', isSymbolicLink: isLink(entry.attrs),
        size: Number(attrs?.size || 0), modified: Number(attrs?.mtime || 0) * 1000, mode: Number(attrs?.mode || 0),
        image: IMAGE_TYPES.has(path.posix.extname(entry.filename).toLowerCase())
      };
    })).then(list => list.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  }
  async discoverDesktop(create = false) {
    const service = this.desktopService();
    return service.serialize(() => this._discoverDesktop(create));
  }
  async _discoverDesktop(create = false) {
    this._requireConnected();
    if (this.desktop) return this._activateDesktop(this.desktop);
    const entries = await this._entries(this.home);
    const candidates = ['rdesktop', 'Desktop', 'desktop', '桌面'];
    const sorted = entries.filter(entry => /^(rdesktop|desktop|桌面)$/i.test(entry.filename)).sort((a, b) => {
      const ai = candidates.indexOf(a.filename); const bi = candidates.indexOf(b.filename);
      return (ai < 0 ? 4 : ai) - (bi < 0 ? 4 : bi);
    });
    for (const entry of sorted) {
      const candidate = path.posix.join(this.home, entry.filename);
      const attrs = isLink(entry.attrs) ? await this.stat(candidate) : entry.attrs;
      if (isDirectory(attrs)) {
        return this._activateDesktop(candidate);
      }
    }
    if (create) {
      const candidate = path.posix.join(this.home, 'rdesktop');
      await new Promise((resolve, reject) => this.sftp.mkdir(candidate, error => error ? reject(error) : resolve()));
      return { ...(await this._activateDesktop(candidate)), created: true };
    }
    return { found: false, home: this.home, candidates };
  }

  async setDesktop(remotePath, options = {}) {
    return this.desktopService().setDesktop(remotePath, options);
  }

  async _activateDesktop(remotePath, { beforeCommit, assertActive = () => {} } = {}) {
    this._requireConnected();
    const connection = this.sftp;
    const target = normalizeRemote(remotePath);
    const stats = await this.stat(target);
    if (!isDirectory(stats)) throw new Error('桌面位置必须是目录。');
    const entries = await this.list(target);
    const service = this.desktopService();
    const configState = await service.readConfig(target);
    assertActive();
    if (this.sftp !== connection) throw new Error('SSH 连接已改变，请重新选择桌面位置。');
    if (beforeCommit) await beforeCommit();
    assertActive();
    if (this.sftp !== connection) throw new Error('SSH 连接已改变，请重新选择桌面位置。');
    // Commit only after the directory can be listed and its configuration has
    // been read. Config writes and all desktop changes share the service queue.
    this.desktop = target;
    Object.assign(service, configState);
    return { found: true, path: target, home: this.home, entries, ...configState };
  }

  async checkFileAccess(remotePath) {
    this._requireConnected();
    const target = normalizeRemote(remotePath);
    const stats = await this.stat(target);
    if (!isFile(stats)) throw new Error('文件路径不是普通文件。');
    // The shell tests use the authenticated user's effective permissions,
    // including group membership and ACLs; mode bits alone cannot tell us this.
    const quoted = posixQuote(target);
    const text = await this.execText(`# remote-desktop-file-access-v1\nif test -r ${quoted}; then printf '1'; else printf '0'; fi; if test -w ${quoted}; then printf '1'; else printf '0'; fi`, 16);
    if (!/^[01]{2}$/.test(text)) throw new Error('服务器返回了无效的文件权限信息。');
    return { path: target, readable: text[0] === '1', writable: text[1] === '1' };
  }

  async _readBuffer(remotePath, maxBytes) {
    this._requireConnected();
    return readBuffer(this.sftp, remotePath, maxBytes);
  }
  async readImage(remotePath) {
    const target = normalizeRemote(remotePath); const type = IMAGE_TYPES.get(path.posix.extname(target).toLowerCase());
    if (!type) throw new Error('不支持的图片格式。');
    const stats = await this.stat(target);
    if (!isFile(stats)) throw new Error('图片路径不是普通文件。');
    if (Number(stats.size) > MAX_IMAGE_SIZE) throw new Error('图片超过 25 MiB，无法在查看器中载入。');
    const buffer = await this._readBuffer(target, MAX_IMAGE_SIZE);
    return { mime: type, data: buffer.toString('base64'), name: path.posix.basename(target) };
  }

  async loadDesktopConfig() {
    this._requireConnected();
    const service = this.desktopService();
    const config = await service.serialize(() => service.loadConfig());
    return { config, configPath: service.configPath, configError: service.configError };
  }
  saveDesktopConfig(patch) {
    const service = this.desktopService();
    return service.saveConfig(patch).then(config => ({ config, configPath: service.configPath }));
  }
  desktopService() {
    if (!this._desktopService) {
      const { DesktopService } = require('./desktop-service.cjs');
      this._desktopService = new DesktopService(this);
    }
    return this._desktopService;
  }

  cancelDownload(id) {
    const transfer = this.downloads.get(String(id));
    if (!transfer) return false;
    transfer.controller.abort(); return true;
  }
  _checkTransfer(transfer) { if (transfer.controller.signal.aborted) throw abortError(); }
  async _downloadPlan(source, transfer) {
    const files = []; const directories = []; let total = 0; let count = 0;
    const visit = async (remote, relative, stats) => {
      this._checkTransfer(transfer);
      if (relative.length > 128) throw new Error('目录嵌套超过 128 层，请分批下载。');
      if (++count > 100000) throw new Error('目录项目超过 100000 个，请分批下载。');
      if (isLink(stats)) {
        // Dereference a selected or nested symlink once, but never descend into
        // symlinked directories. This makes loops impossible without guessing.
        const resolved = await this.stat(remote);
        if (isDirectory(resolved)) throw new Error(`目录包含指向文件夹的符号链接，已停止以避免循环：${remote}`);
        if (!isFile(resolved)) throw new Error(`不支持下载此符号链接目标：${remote}`);
        stats = resolved;
      }
      if (isDirectory(stats)) {
        directories.push(relative);
        const entries = await this._entries(remote); const reserved = new Set();
        for (const entry of entries) {
          let clean = safeName(entry.filename); let index = 0; let name = clean;
          while (reserved.has(name.toLowerCase())) name = numberedName(clean, ++index);
          reserved.add(name.toLowerCase());
          const attrs = entry.attrs || await this.stat(path.posix.join(remote, entry.filename), false);
          await visit(path.posix.join(remote, entry.filename), [...relative, name], attrs);
        }
      } else {
        if (!isFile(stats)) throw new Error(`不支持下载特殊文件：${remote}`);
        const size = Number(stats.size);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('远程文件大小无效。');
        total += size; files.push({ source: remote, relative, size });
      }
    };
    let initial = await this.stat(source, false);
    // A directly selected directory shortcut can be downloaded. Nested
    // directory links are rejected by visit, so a link back to this root never
    // causes recursive traversal.
    if (isLink(initial)) initial = await this.stat(source);
    await visit(source, [], initial);
    return { files, directories, total, directory: isDirectory(initial) };
  }
  async _transferFile(file, target, transfer, method) {
    this._checkTransfer(transfer);
    let source; let remoteChannel; let completion = Promise.resolve();
    if (method === 'ssh') {
      ({ stream: remoteChannel, completion } = await this._execStream(`cat -- ${posixQuote(file.source)}`, transfer.controller.signal));
      // ssh2 Channel.destroy() requests SSH channel closure but is not a Node
      // stream destroy. Use a normal local stream so pipeline cancellation can
      // close the local file immediately even while SSH closure is in flight.
      source = new PassThrough();
      remoteChannel.pipe(source);
    } else { source = this.sftp.createReadStream(file.source); completion = closed(source); }
    let transferred = 0;
    const meter = new Transform({ transform: (chunk, encoding, done) => {
      transferred += chunk.length;
      transfer.done += chunk.length;
      try { transfer.report(method); done(null, chunk); } catch (error) { done(error); }
    } });
    const writing = pipeline(source, meter, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal: transfer.controller.signal });
    // An SSH exit failure can arrive before the local write stream closes.
    // Stop both sides and await their settlement before removing staging files.
    const checkedCompletion = completion.catch(error => { source.destroy(error); throw error; });
    const outcomes = await Promise.allSettled([writing, checkedCompletion]);
    remoteChannel?.unpipe(source);
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw failed.reason;
    if (transferred !== file.size) throw new Error(`远程文件在下载期间发生变化，请重试：${file.source}`);
  }
  async _commitFile(temp, root, name, transfer) {
    for (let index = 0; index < 100000; index += 1) {
      this._checkTransfer(transfer);
      const target = path.join(root, numberedName(safeName(name), index));
      try {
        // A hard link commits complete staged bytes atomically and fails if a
        // target already exists. Filesystems without hard-link support still
        // use exclusive copy; neither path can replace another user's file.
        try { await fsp.link(temp, target); }
        catch (error) {
          if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) throw error;
          await fsp.copyFile(temp, target, fs.constants.COPYFILE_EXCL);
        }
        if (transfer.controller.signal.aborted) { await fsp.unlink(target); throw abortError(); }
        return target;
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    throw new Error('本地文件名冲突过多。');
  }
  async _commitDirectory(temp, root, name, transfer) {
    // Reserve one new directory exclusively, then move only our staged items
    // into it. Existing directories are never reused, merged or removed.
    let destination;
    for (let index = 0; index < 100000; index += 1) {
      this._checkTransfer(transfer);
      const candidate = path.join(root, numberedName(safeName(name), index));
      try { await fsp.mkdir(candidate); destination = candidate; break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (!destination) throw new Error('本地文件名冲突过多。');
    try {
      for (const name of await fsp.readdir(temp)) {
        this._checkTransfer(transfer);
        await fsp.rename(path.join(temp, name), path.join(destination, name));
      }
      return destination;
    } catch (error) { await fsp.rm(destination, { recursive: true, force: true }); throw error; }
  }
  async download(remotePath, options = {}) {
    this._requireConnected();
    const id = String(options.id || crypto.randomUUID());
    if (this.downloads.has(id)) throw new Error('下载任务 ID 已存在。');
    const source = normalizeRemote(remotePath);
    const root = options.destination || this.downloadsPath;
    if (!root || !path.isAbsolute(root)) throw new Error('未获取到系统 Downloads 目录。');
    const transfer = { controller: new AbortController(), done: 0, total: 0, destination: null, report: null };
    let finish;
    transfer.finished = new Promise(resolve => { finish = resolve; });
    transfer.report = method => options.onProgress?.({ id, done: transfer.done, total: transfer.total, method, path: transfer.destination, source });
    this.downloads.set(id, transfer); let staging;
    try {
      transfer.report('preparing');
      const plan = await this._downloadPlan(source, transfer); transfer.total = plan.total;
      this._checkTransfer(transfer); await fsp.mkdir(root, { recursive: true });
      staging = await fsp.mkdtemp(path.join(root, '.remote-desktop-part-'));
      const content = path.join(staging, 'content'); const method = plan.directory || plan.total >= this.threshold ? 'sftp' : 'ssh';
      transfer.report(method);
      if (plan.directory) {
        await fsp.mkdir(content);
        for (const directory of plan.directories) if (directory.length) await fsp.mkdir(path.join(content, ...directory), { recursive: true });
        for (const file of plan.files) await this._transferFile(file, path.join(content, ...file.relative), transfer, 'sftp');
        transfer.destination = await this._commitDirectory(content, root, path.posix.basename(source) || 'download', transfer);
      } else {
        await this._transferFile(plan.files[0], content, transfer, method);
        transfer.destination = await this._commitFile(content, root, path.posix.basename(source), transfer);
      }
      transfer.report(method);
      return { id, path: transfer.destination, method, total: transfer.total };
    } finally {
      // `staging` comes solely from mkdtemp under the selected download root.
      try { if (staging) await fsp.rm(staging, { recursive: true, force: true }); }
      finally { this.downloads.delete(id); finish(); }
    }
  }

  openShell(id, cwd, onData, onClose, options = {}) {
    this._requireConnected();
    if (!id || this.shells.has(id) || this.pendingShells.has(id)) throw new Error('终端 ID 已存在或为空。');
    if (this.shells.size + this.pendingShells.size >= 8) throw new Error('终端数量已达上限（8）。');
    const target = normalizeRemote(cwd || this.home); const client = this.client; const token = {};
    this.pendingShells.set(id, token);
    const program = options.program || 'shell';
    if (!['shell', 'vim', 'htop'].includes(program)) { this.pendingShells.delete(id); throw new Error('不支持的终端程序。'); }
    const marker = `\x1b]777;remote-desktop-vim-${crypto.randomBytes(16).toString('hex')}\x07`;
    const session = { program, filePath: options.filePath, ready: program !== 'vim', marker, output: '', closing: null };
    this.terminalSessions.set(id, session);
    const ready = (error, stream) => {
      if (this.pendingShells.get(id) !== token || this.client !== client) { stream?.destroy(); return; }
      this.pendingShells.delete(id);
      if (error) { this.terminalSessions.delete(id); onClose?.(error); return; }
      this.shells.set(id, stream);
      let finished = false;
      const close = (error, code) => {
        if (finished) return; finished = true; this.shells.delete(id); this.terminalSessions.delete(id);
        session.finish?.(error || (code !== 0 ? new Error('未收到 Vim 正常退出的确认，请检查文件保存结果。') : null));
        onClose?.(error);
      };
      const output = chunk => {
        if (program === 'vim' && !session.ready) {
          session.output = (session.output + chunk.toString('utf8')).slice(-8192);
          if (session.output.includes(marker)) { session.ready = true; session.output = ''; }
        }
        onData(chunk);
      };
      stream.on('data', output); stream.stderr?.on('data', output); stream.once('error', close);
      stream.once('close', (code, signal) => close(code && code !== 0 ? new Error(`远程 ${program} 已退出（代码 ${code}）。请检查该程序是否安装及文件权限。`) : signal ? new Error(`远程进程被信号 ${signal} 终止。`) : undefined, code));
      options.onReady?.();
    };
    const pty = { term: 'xterm-256color', cols: Math.max(2, Math.min(500, Number(options.cols) || 120)), rows: Math.max(1, Math.min(200, Number(options.rows) || 32)) };
    // exec's PTY gives interactive shell/TUI semantics. Paths are POSIX quoted
    // and programs are from a fixed allowlist; scripts are never executed.
    // VimEnter runs only after startup and any swap/recovery question has been
    // resolved. Never send :wqa into a still-active E325 choice prompt.
    const vimReady = `autocmd VimEnter * call writefile(["\\e]777;${marker.slice(6, -1)}\\x07"], "/dev/tty", "a")`;
    const command = `cd -- ${posixQuote(target)} && ` + (program === 'shell' ? 'exec "${SHELL:-/bin/sh}" -l' : `exec ${program}${program === 'vim' ? ` -c ${posixQuote(vimReady)}${options.readOnly ? ' -R' : ''}` : ''}${options.filePath && program === 'vim' ? ` -- ${posixQuote(normalizeRemote(options.filePath))}` : ''}`);
    client.exec(command, { pty }, ready);
  }
  writeShell(id, data) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > 65536) throw new Error('终端单次输入不能超过 64 KiB。');
    if (this.terminalSessions.get(id)?.closing) return;
    this.shells.get(id)?.write(data);
  }
  resizeShell(id, cols, rows) {
    const width = Math.max(1, Math.min(500, Math.floor(Number(cols) || 120)));
    const height = Math.max(1, Math.min(300, Math.floor(Number(rows) || 32)));
    this.shells.get(id)?.setWindow(height, width, 0, 0);
  }
  async closeVim(id, save, timeout = 8000) {
    const session = this.terminalSessions.get(id), stream = this.shells.get(id);
    if (!session || !stream) return;
    if (session.program !== 'vim') throw new Error('请在终端中正常退出编辑器后再关闭。');
    if (!session.ready) throw new Error('Vim 尚未完成启动，可能正在询问交换文件恢复。请先在终端处理提示，再关闭窗口。');
    if (session.closing) return session.closing;
    session.closing = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.finish = null;
        reject(new Error('Vim 尚未退出。可能存在只读文件、未命名缓冲区或其他提示；窗口已保留，请在终端处理后重试。'));
      }, timeout);
      session.finish = error => { clearTimeout(timer); session.finish = null; error ? reject(error) : resolve(); };
      // Ctrl-\\ Ctrl-N returns from insert/visual/command/terminal mode to
      // Normal mode. :wqa deliberately has no !, so write failures stay open.
      stream.write(`\x1c\x0e:${save ? 'wqa' : 'qa!'}\r`);
    });
    try { await session.closing; } finally { session.closing = null; }
  }
  closeShell(id) {
    this.pendingShells.delete(id); const stream = this.shells.get(id); this.shells.delete(id);
    const session = this.terminalSessions.get(id); this.terminalSessions.delete(id);
    session?.finish?.(new Error('终端连接已中断，无法确认保存。'));
    try { stream?.destroy(); } catch {}
  }
}

module.exports = { SshBackend, DEFAULT_THRESHOLD, DEFAULT_LARGE_FILE_THRESHOLD: DEFAULT_THRESHOLD, normalizeRemote, uniqueDestination, safeName, posixQuote };
