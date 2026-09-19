'use strict';

const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const posixQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const normalizeRemote = value => { if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) throw new Error('远程路径必须是绝对路径。'); return path.posix.normalize(value); };

const ACTIONS = new Set(['status', 'focus', 'connect', 'exec', 'upload', 'download', 'cancel']);
const MAX_REQUEST = 128 * 1024;
const MAX_RESPONSE = 64 * 1024 * 1024; // JSON escaping can expand bounded exec bytes.
const cancelled = () => Object.assign(new Error('命令已取消。'), { code: 'ABORT_ERR' });
const ACTIVITY_ARGUMENTS = {
  connect: ['host', 'port', 'username'], exec: ['command', 'cwd', 'timeoutMs', 'maxBytes'],
  upload: ['localPath', 'remoteDirectory', 'id'], download: ['remotePath', 'destination', 'id'], cancel: ['id']
};
const pickPrimitives = (value, keys) => Object.fromEntries(keys.filter(key => ['string', 'number', 'boolean'].includes(typeof value?.[key])).map(key => [key, value[key]]));
function defaultUserDataDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'remote-desktop-app');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'remote-desktop-app');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'remote-desktop-app');
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('实例注册路径不是普通目录。');
  if (process.platform !== 'win32') {
    if (stats.uid !== process.getuid()) throw new Error('实例注册目录不属于当前用户。');
    await fs.chmod(directory, 0o700); return;
  }
  // Windows mode bits do not restrict ACLs. Replace inheritance on our newly
  // dedicated registry with an explicit current-user ACL (SID avoids locale).
  const script = "$ErrorActionPreference='Stop'; $p=$env:RDESKTOP_REGISTRY; $id=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($id); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($p,$acl)";
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, RDESKTOP_REGISTRY: directory }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { if (stderr.length < 2048) stderr += data.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('实例注册目录权限设置超时。')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`无法保护实例注册目录：${stderr.trim()}`)); });
  });
}

class InstanceBridge {
  constructor(options = {}) {
    this.userDataDir = path.resolve(options.userDataDir || defaultUserDataDir());
    this.instanceId = options.instanceId || crypto.randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(this.instanceId)) throw new Error('无效实例 ID。');
    this.callbacks = options.callbacks || {};
    this.onActivity = options.onActivity;
    this.metadata = { pid: process.pid, ...(typeof options.metadata?.executable === 'string' ? { executable: options.metadata.executable } : {}) };
    this.token = crypto.randomBytes(32).toString('hex'); this.sockets = new Set(); this.server = null;
    this.directory = path.join(this.userDataDir, 'instances');
    this.registryPath = path.join(this.directory, `${this.instanceId}.json`);
    const suffix = crypto.randomBytes(12).toString('hex');
    this.endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\rdesktop-${suffix}` : path.join(os.tmpdir(), `rdesktop-${process.getuid()}-${suffix}.sock`);
  }
  async start() {
    if (this.server) return this.instanceId;
    await privateDirectory(this.directory);
    this.server = net.createServer(socket => this._serve(socket));
    try {
      await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.endpoint, () => { this.server.removeListener('error', reject); resolve(); }); });
      this.server.on('error', () => {});
      if (process.platform !== 'win32') await fs.chmod(this.endpoint, 0o600);
      await fs.writeFile(this.registryPath, JSON.stringify({ version: 1, instanceId: this.instanceId, endpoint: this.endpoint, token: this.token, ...this.metadata, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      return this.instanceId;
    } catch (error) { await this.close(); throw error; }
  }
  _activity(event) {
    // Observability must never change a command's result or create an unhandled rejection.
    try { Promise.resolve(this.onActivity?.(event)).catch(() => {}); } catch {}
  }
  _serve(socket) {
    if (this.sockets.size >= 64) { socket.destroy(); return; }
    this.sockets.add(socket); let buffer = '', dispatched = false;
    const controller = new AbortController();
    let activity, activityFinished = false, secretValues = [];
    const report = (type, details = {}) => {
      if (!activity || activityFinished) return;
      if (type === 'finish' || type === 'error') activityFinished = true;
      this._activity({ ...activity, type, ...details });
    };
    const errorRecord = error => {
      let message = String(error?.message || error);
      for (const secret of secretValues) message = message.replaceAll(secret, '[redacted]');
      return { message: message.slice(0, 8192), code: error?.code || 'INSTANCE_ERROR' };
    };
    const send = message => { if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n'); };
    socket.setEncoding('utf8'); socket.setTimeout(10000, () => { if (!dispatched) socket.destroy(); });
    socket.on('error', () => {});
    socket.once('close', () => { report('error', { error: errorRecord(cancelled()) }); controller.abort(); this.sockets.delete(socket); });
    socket.on('data', chunk => {
      if (dispatched) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST) { socket.destroy(); return; }
      const newline = buffer.indexOf('\n'); if (newline < 0) return;
      dispatched = true; socket.setTimeout(0);
      void (async () => {
        try {
          const request = JSON.parse(buffer.slice(0, newline)); buffer = '';
          const token = Buffer.from(typeof request.token === 'string' ? request.token : '', 'utf8'); const expected = Buffer.from(this.token, 'utf8');
          if (token.length !== expected.length || !crypto.timingSafeEqual(token, expected)) throw new Error('实例认证失败。');
          if (!ACTIONS.has(request.action) || typeof this.callbacks[request.action] !== 'function') throw new Error('此实例不支持该操作。');
          const args = request.args === undefined ? {} : request.args;
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('无效请求参数。');
          if (ACTIVITY_ARGUMENTS[request.action]) {
            activity = { connection: { id: crypto.randomUUID(), connectedAt: new Date().toISOString(), transport: process.platform === 'win32' ? 'named-pipe' : 'unix-socket', ip: null }, action: request.action, args: pickPrimitives(args, ACTIVITY_ARGUMENTS[request.action]) };
            if (request.action === 'connect') secretValues = ['password', 'passphrase', 'privateKey', 'privateKeyPath'].map(key => args[key]).filter(value => typeof value === 'string' && value.length > 0);
            report('start');
          }
          const result = await this.callbacks[request.action](args, { signal: controller.signal, onProgress: progress => {
            // Connection setup has no loggable payload: it may contain credentials.
            if (request.action !== 'connect') report('progress', { progress });
            send({ type: 'progress', progress });
          } });
          if (controller.signal.aborted) throw cancelled();
          report('finish', { result: request.action === 'connect' ? pickPrimitives(result, ['connected', 'host', 'port', 'username']) : result });
          send({ type: 'result', ok: true, result });
        } catch (error) { const failure = errorRecord(error); report('error', { error: failure }); send({ type: 'result', ok: false, error: failure }); }
        finally { socket.end(); }
      })();
    });
  }
  async close() {
    for (const socket of this.sockets) socket.destroy(); this.sockets.clear();
    const server = this.server; this.server = null;
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    try {
      const registry = JSON.parse(await fs.readFile(this.registryPath, 'utf8'));
      if (registry.token === this.token) await fs.unlink(this.registryPath);
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (process.platform !== 'win32') await fs.unlink(this.endpoint).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function readRegistry(file) {
  const stats = await fs.lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16384) throw new Error('实例注册文件无效。');
  if (process.platform !== 'win32' && (stats.uid !== process.getuid() || (stats.mode & 0o077))) throw new Error('实例注册文件权限不安全。');
  const entry = JSON.parse(await fs.readFile(file, 'utf8'));
  if (entry.version !== 1 || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.instanceId) || !/^[a-f0-9]{64}$/.test(entry.token)) throw new Error('实例注册记录无效。');
  if (process.platform === 'win32' ? !/^\\\\\.\\pipe\\rdesktop-[a-f0-9]{24}$/.test(entry.endpoint) : !new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/rdesktop-${process.getuid()}-[a-f0-9]{24}\\.sock$`).test(entry.endpoint)) throw new Error('实例端点无效。');
  return entry;
}

function requestInstance(entry, action, args = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(entry.endpoint); let buffer = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); socket.destroy(); error ? reject(error) : resolve(value); };
    const abort = () => finish(cancelled());
    const timeout = options.timeoutMs || 360000;
    const timer = setTimeout(() => finish(Object.assign(new Error('实例请求超时。'), { code: 'ETIMEDOUT' })), timeout);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify({ token: entry.token, action, args }) + '\n'));
    socket.on('error', error => finish(error));
    socket.once('close', () => { if (!settled) finish(new Error('实例连接提前关闭。')); });
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_RESPONSE) { finish(new Error('实例返回超过允许大小。')); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        let message; try { message = JSON.parse(buffer.slice(0, newline)); } catch { finish(new Error('实例返回无效数据。')); return; }
        buffer = buffer.slice(newline + 1);
        if (message.type === 'progress') { try { options.onProgress?.(message.progress); } catch (error) { finish(error); } }
        else if (message.type === 'result') finish(message.ok ? null : Object.assign(new Error(message.error?.message || '实例操作失败。'), { code: message.error?.code }), message.result);
      }
    });
  });
}

async function listInstances(userDataDir = defaultUserDataDir(), options = {}) {
  const directory = path.join(path.resolve(userDataDir), 'instances');
  let names; try { names = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const results = await Promise.all(names.filter(name => /^[a-zA-Z0-9_-]{1,100}\.json$/.test(name)).map(async name => {
    try { const entry = await readRegistry(path.join(directory, name)); const status = await requestInstance(entry, 'status', {}, { timeoutMs: options.timeoutMs || 1500 }); return { ...entry, status }; } catch { return null; }
  }));
  return results.filter(Boolean);
}

function executeRemote(backend, input = {}, options = {}) {
  backend._requireConnected();
  const command = input.command;
  if (typeof command !== 'string' || !command.trim() || command.includes('\0') || Buffer.byteLength(command) > 65536) throw new Error('远程命令必须是 1–65536 字节的文本。');
  const timeoutMs = input.timeoutMs === undefined ? 30000 : Number(input.timeoutMs);
  const maxBytes = input.maxBytes === undefined ? 4 * 1024 * 1024 : Number(input.maxBytes);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error('命令超时须为 100–300000 毫秒。');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error('命令输出上限须为 1–8388608 字节。');
  const text = input.cwd ? `cd -- ${posixQuote(normalizeRemote(input.cwd))} && (\n${command}\n)` : command;
  return new Promise((resolve, reject) => {
    let channel, settled = false, size = 0; const stdout = [], stderr = [];
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const complete = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); if (error) { try { channel?.signal('TERM'); } catch {} channel?.close(); reject(error); } else resolve(result); };
    const abort = () => complete(cancelled());
    const timer = setTimeout(() => complete(Object.assign(new Error(`远程命令超时（${timeoutMs} 毫秒）。`), { code: 'ETIMEDOUT' })), timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    options.onCommand?.(text);
    backend.client.exec(text, (error, stream) => {
      if (error) { complete(error); return; }
      channel = stream;
      if (settled) { stream.close(); return; }
      const collect = (kind, chunks) => chunk => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) { complete(Object.assign(new Error('远程命令输出超过允许上限。'), { code: 'OUTPUT_LIMIT' })); return; }
        const bytes = Buffer.from(chunk); chunks.push(bytes);
        try { const data = decoders[kind].write(bytes); if (data) options.onProgress?.({ kind, data }); } catch (caught) { complete(caught); }
      };
      stream.on('data', collect('stdout', stdout)); stream.stderr?.on('data', collect('stderr', stderr));
      stream.once('error', complete);
      stream.once('close', (code, signal) => {
        if (settled) return;
        try { for (const kind of ['stdout', 'stderr']) { const data = decoders[kind].end(); if (data) options.onProgress?.({ kind, data }); } }
        catch (error) { complete(error); return; }
        complete(null, { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code: Number.isInteger(code) ? code : null, signal: signal || null });
      });
      stream.end();
    });
  });
}

module.exports = { InstanceBridge, executeRemote, requestInstance, listInstances, readRegistry, defaultUserDataDir };
