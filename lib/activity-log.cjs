'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { systemRecord } = require('./activity-audit.cjs');

const DEFAULT_ROTATE_BYTES = 8 * 1024 * 1024;
const DEFAULT_QUEUE_BYTES = 32 * 1024 * 1024;
const SECRET_KEY = /^(?:password|passphrase|token|privateKey|authorization|cookie|set-cookie)$/i;
const now = () => new Date().toISOString();
const missing = error => error?.code === 2 || error?.code === 'ENOENT';
const invoke = (sftp, method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (error, result) => error ? reject(error) : resolve(result)));

function remotePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) throw new Error('日志目录必须是远程绝对路径。');
  return path.posix.normalize(value);
}

// The caller supplies allowlisted operation metadata. This additionally blocks
// structured credentials, but intentionally does not rewrite command transcripts.
function clean(value, maxString = Infinity, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return value.length > maxString ? `${value.slice(0, maxString)}\n[实时显示已截断；完整内容请查看日志]` : value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object' || depth > 12) return undefined;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (value instanceof Error) return { message: clean(value.message, maxString), code: value.code };
  if (Buffer.isBuffer(value)) return clean(value.toString('utf8'), maxString);
  const result = Array.isArray(value) ? [] : {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    result[key] = clean(item, maxString, depth + 1, seen);
  }
  seen.delete(value);
  return result;
}

/**
 * Ordered remote NDJSON audit storage. Public calls never wait for remote I/O
 * except attach/flush/disconnect. capture() tokens bind asynchronous GUI work to
 * its original SSH connection/desktop; pass the token to system(record, token).
 * beginCli() returns a session immediately; cli(id, {type:'end'}) closes it.
 * Errors are reported in snapshot()/state events rather than stopping the app.
 */
class ActivityLog {
  constructor(options = {}) {
    this.onEvent = options.onEvent;
    this.rotateBytes = options.rotateBytes || DEFAULT_ROTATE_BYTES;
    this.maxQueueBytes = options.maxQueueBytes || DEFAULT_QUEUE_BYTES;
    this.maxEntries = options.maxEntries || 600;
    this.maxEntryBytes = options.maxEntryBytes || 2 * 1024 * 1024;
    this.maxSessions = options.maxSessions || 100;
    this.operationTimeout = options.operationTimeout || 15000;
    this.context = null;
    this.contexts = new Set();
    this.sessions = new Map();
    this.sessionContexts = new Map();
    this.entries = [];
    this.entryBytes = 0;
    this.sequence = 0;
    this.error = null;
    this.transition = Promise.resolve();
  }

  _emit(event) { try { this.onEvent?.(event); } catch { /* UI listeners cannot break logging. */ } }
  _state() { this._emit({ type: 'state', ...this.snapshot() }); }

  snapshot() {
    return clean({ connected: Boolean(this.context?.accepting), sessions: [...this.sessions.values()],
      entries: this.entries.map(item => item.value), systemLogPath: this.context?.system?.path || null,
      systemLogPaths: this.context?.system?.paths || [], error: this.error });
  }

  capture() { return this.context?.accepting ? this.context : null; }

  retain(context) {
    if (!context || context.closed || context.failed) return () => {};
    context.holds = (context.holds || 0) + 1;
    let released = false;
    return () => {
      if (released) return; released = true; context.holds--;
      if (context.retired && !context.holds && ![...this.sessionContexts.values()].some(item => item.context === context)) {
        context.tail = context.tail.then(() => this._finishContext(context));
      }
    };
  }

  attach(backend, desktopPath, options = {}) {
    const requested = remotePath(desktopPath);
    const directory = options.directory === undefined ? null : remotePath(options.directory);
    const perform = async () => {
      if (options.isCurrent && !options.isCurrent()) return { ...this.snapshot(), error: 'SSH 连接已改变，未切换日志目录。' };
      if (this.context?.backend === backend && this.context.sftp === backend?.sftp && this.context.requested === requested && this.context.requestedDirectory === directory && this.context.accepting && !this.context.failed) {
        if (this.error) { this.error = null; this._state(); }
        return this.snapshot();
      }
      // A desktop change on the same SSH channel keeps running CLI requests
      // attached to their original files. A reconnect cannot reuse that channel.
      const previous = this.context?.backend === backend && this.context.sftp === backend?.sftp ? this.context : null;
      if (!previous) await this._disconnect();
      const context = { id: crypto.randomUUID(), backend, sftp: backend?.sftp, requested, requestedDirectory: directory,
        directory: null, accepting: false, retired: false, closed: false, failed: false, error: null, tail: Promise.resolve(), queuedBytes: 0,
        writers: new Set(), system: null };
      this.contexts.add(context);
      try {
        if (!context.sftp) throw new Error('SSH 尚未连接，无法写入操作日志。');
        const canonical = remotePath(await this._call(context, 'realpath', requested));
        const desktop = await this._call(context, 'lstat', canonical);
        if (!desktop.isDirectory() || desktop.isSymbolicLink()) throw new Error('远程桌面不是普通目录。');
        context.directory = directory || path.posix.join(canonical, '.log');
        try {
          const stats = await this._call(context, 'lstat', context.directory);
          if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('日志目录已存在且不是普通目录；拒绝跟随符号链接。');
        } catch (error) {
          if (!missing(error)) throw error;
          try { await this._call(context, 'mkdir', context.directory, { mode: 0o700 }); }
          catch (createError) {
            // A simultaneous app may create the same .log directory. Revalidate
            // its type below; never accept a substituted symlink.
            try { await this._validateDirectory(context); } catch { throw createError; }
          }
        }
        await this._validateDirectory(context);
        // Restrict the app's log directory as well as newly created files.
        if (!options.preserveDirectoryMode) await this._call(context, 'chmod', context.directory, 0o700);
        context.system = this._writer(context, 'system');
        await this._write(context, context.system, this._line({ type: 'system-start', operationId: context.id, time: now(), desktop: canonical, directory: context.directory }));
        if (context.sftp !== backend?.sftp || (options.isCurrent && !options.isCurrent())) throw new Error('SSH 连接已改变，未切换日志目录。');
        // Publish only a fully initialized writer. Commands started while the
        // target is being checked keep using the previous, writable context.
        context.accepting = true; this.context = context; this.error = null;
        if (previous) await this._retire(previous);
      } catch (error) {
        this._fail(context, error);
        if (previous) await this._finishContext(context);
        else { context.accepting = true; this.context = context; }
        this.error = context.error;
      }
      this._state();
      return this.snapshot();
    };
    this.transition = this.transition.then(perform, perform);
    return this.transition;
  }

  async _call(context, method, ...args) {
    if (context.sftp !== context.backend?.sftp) throw new Error('SSH 连接已改变，原操作日志未转移到新连接。');
    let timer;
    try {
      return await Promise.race([invoke(context.sftp, method, ...args), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`日志 SFTP ${method} 超时。`)), this.operationTimeout);
      })]);
    } finally { clearTimeout(timer); }
  }

  async _validateDirectory(context) {
    const stats = await this._call(context, 'lstat', context.directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('日志目录不是普通目录；拒绝跟随符号链接。');
    const canonical = await this._call(context, 'realpath', context.directory);
    if (canonical !== context.directory) throw new Error('日志目录路径已改变；拒绝跟随符号链接。');
  }

  _writer(context, prefix, session = null) {
    const stamp = now().replace(/[:.]/g, '-');
    const stem = `${prefix}-${stamp}-${crypto.randomBytes(8).toString('hex')}`;
    const writer = { stem, session, path: path.posix.join(context.directory, `${stem}.log`), paths: [],
      part: 0, size: 0, handle: null, closed: false };
    writer.paths.push(writer.path); context.writers.add(writer);
    return writer;
  }

  async _open(context, writer) {
    await this._validateDirectory(context);
    // Exclusive creation prevents an existing file/symlink from being followed.
    writer.handle = await this._call(context, 'open', writer.path, 'wx', { mode: 0o600 });
    const stats = await this._call(context, 'fstat', writer.handle);
    if (!stats.isFile()) throw new Error('日志目标不是普通文件。');
    await this._call(context, 'fchmod', writer.handle, 0o600);
  }

  async _close(context, writer) {
    const handle = writer.handle; writer.handle = null;
    if (handle) await this._call(context, 'close', handle);
  }

  async _write(context, writer, bytes) {
    if (writer.closed) return;
    if (writer.size && writer.size + bytes.length > this.rotateBytes) {
      await this._close(context, writer);
      writer.part += 1; writer.size = 0;
      writer.path = path.posix.join(context.directory, `${writer.stem}.part${String(writer.part + 1).padStart(3, '0')}.log`);
      writer.paths.push(writer.path);
      if (writer.session) {
        writer.session.logPaths = [...writer.paths];
        writer.session.logPath = writer.path;
        this._emit({ type: 'session', session: clean(writer.session) });
        await this._write(context, context.system, this._line({ type: 'cli-connection', operationId: writer.session.id, time: writer.session.time, ip: writer.session.ip, logPath: writer.path }));
      }
      this._state();
    }
    if (!writer.handle) await this._open(context, writer);
    // Bound individual SFTP requests, preserving complete NDJSON records across
    // rotation. A large logical record may therefore exceed the nominal size.
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      const length = Math.min(32768, bytes.length - offset);
      await this._call(context, 'write', writer.handle, bytes, offset, length, writer.size);
      writer.size += length;
    }
  }

  _line(record) { return Buffer.from(`${JSON.stringify(clean(record))}\n`, 'utf8'); }

  _fail(context, error) {
    if (context.failed) return;
    context.failed = true;
    context.error = `操作日志写入失败：${error?.message || String(error)}`;
    if (this.context === context) this.error = context.error;
    const affected = new Set([...context.writers].map(writer => writer.session).filter(Boolean));
    for (const [id, state] of this.sessionContexts) if (state.context === context && this.sessions.has(id)) affected.add(this.sessions.get(id));
    for (const session of affected) {
      session.error = context.error; session.status = 'error'; this._emit({ type: 'session', session: clean(session) });
    }
    this._state();
  }

  _enqueue(context, bytes, task, allowRetired = false) {
    if (!context || context.failed || context.closed || (!context.accepting && !(allowRetired && context.retired))) return false;
    if (context.queuedBytes + bytes > this.maxQueueBytes) {
      this._fail(context, new Error('待写日志超过内存上限，已停止该连接的日志写入；请检查服务器响应后重新连接。'));
      return false;
    }
    context.queuedBytes += bytes;
    context.tail = context.tail.then(async () => { if (!context.failed) await task(); }).catch(error => this._fail(context, error)).finally(() => { context.queuedBytes -= bytes; });
    return true;
  }

  _entry(session, record, scope = 'cli') {
    const entry = clean({ ...record, id: `activity-${++this.sequence}`, seq: this.sequence,
      operationId: record.operationId || session.id, sessionId: session.id, source: scope, scope, time: record.time || now() }, 32768);
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    this.entries.push({ value: entry, bytes }); this.entryBytes += bytes;
    while (this.entries.length > this.maxEntries || this.entryBytes > this.maxEntryBytes) this.entryBytes -= this.entries.shift().bytes;
    this._emit({ type: 'entry', entry });
    return entry;
  }

  beginCli(meta = {}) {
    const context = this.capture();
    const supplied = typeof meta.id === 'string' && meta.id.length < 200 ? meta.id : crypto.randomUUID();
    const id = this.sessions.has(supplied) || this.sessionContexts.has(supplied) ? crypto.randomUUID() : supplied;
    const session = { id, time: typeof meta.time === 'string' ? meta.time : now(), ip: typeof meta.ip === 'string' ? meta.ip : null,
      ipSource: meta.ipSource || null, transport: meta.transport || 'named-pipe', action: meta.action || 'exec',
      logPath: null, logPaths: [], status: context && !context.failed ? 'recording' : 'error',
      error: context?.error || (!context ? '当前没有可用的远程日志目录。' : null) };
    const writer = context?.directory && !context.failed ? this._writer(context, 'cli', session) : null;
    if (writer) { session.logPath = writer.path; session.logPaths = [...writer.paths]; }
    this.sessions.set(id, session);
    this.sessionContexts.set(id, { context, writer, session, ended: false });
    while (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
    this._emit({ type: 'connection', session: clean(session) });
    if (writer) {
      const reference = this._line({ type: 'cli-connection', operationId: id, time: session.time, ip: session.ip, logPath: session.logPath });
      const connection = this._line({ type: 'connection', operationId: id, ...session });
      this._enqueue(context, reference.length + connection.length, async () => {
        await this._write(context, context.system, reference);
        await this._write(context, writer, connection);
      });
    }
    return clean(session);
  }

  cli(id, record = {}) {
    const state = this.sessionContexts.get(id);
    if (!state || state.ended) return false;
    const session = state.session;
    if (!session) return false;
    const value = { ...record, operationId: record.operationId || id, time: record.time || now() };
    this._entry(session, value);
    const { context, writer } = state;
    const ending = record.type === 'end';
    if (ending) {
      state.ended = true;
      session.status = session.error ? 'error' : 'ended'; session.endedAt = value.time;
    }
    let accepted = false;
    if (context && writer) {
      const bytes = this._line({ ...value, sessionId: id });
      accepted = this._enqueue(context, bytes.length, async () => {
        await this._write(context, writer, bytes);
        if (ending) {
          await this._close(context, writer); writer.closed = true; context.writers.delete(writer);
          if (context.retired && !context.holds && ![...this.sessionContexts.values()].some(item => item.context === context)) await this._finishContext(context);
        }
      }, true);
    }
    if (ending) {
      this.sessionContexts.delete(id); this._emit({ type: 'session', session: clean(session) }); this._state();
      if (!accepted && context?.retired && !context.holds && ![...this.sessionContexts.values()].some(item => item.context === context)) {
        context.tail = context.tail.then(() => this._finishContext(context));
      }
    }
    return accepted;
  }

  system(record, context = this.capture()) {
    const retained = Boolean(context?.retired && context.holds);
    if (!context || !context.system || (!retained && (context !== this.context || !context.accepting))) return false;
    const value = { ...systemRecord(record), operationId: record?.operationId || record?.terminalId || crypto.randomUUID(),
      sessionId: 'system', source: 'system', scope: 'system', time: record?.time || now() };
    this._entry({ id: 'system' }, value, 'system');
    const bytes = this._line(value);
    return this._enqueue(context, bytes.length, () => this._write(context, context.system, bytes), retained);
  }

  async flush() {
    await this.transition;
    await Promise.all([...this.contexts].map(context => context.tail));
    return this.snapshot();
  }

  async _retire(context = this.context) {
    if (!context) return;
    context.accepting = false;
    context.retired = true;
    if (this.context === context) this.context = null;
    if (!context.holds && ![...this.sessionContexts.values()].some(item => item.context === context)) {
      await context.tail;
      await this._finishContext(context);
    }
  }

  async _finishContext(context) {
    if (context.closed) return;
    context.closed = true;
    await Promise.all([...context.writers].map(async writer => {
      try { await this._close(context, writer); } catch (error) { this._fail(context, error); }
      writer.closed = true;
    }));
    context.writers.clear();
    for (const [id, state] of this.sessionContexts) {
      if (state.context !== context) continue;
      const session = this.sessions.get(id);
      if (session) { session.status = session.error ? 'error' : 'disconnected'; session.endedAt = now(); }
      this.sessionContexts.delete(id);
    }
    this.contexts.delete(context);
    if (this.context === context) this.context = null;
    this._state();
  }

  async _disconnect() {
    for (const context of [...this.contexts]) {
      context.accepting = false; context.retired = false;
      await context.tail;
      await this._finishContext(context);
    }
  }

  disconnect() {
    const perform = () => this._disconnect();
    this.transition = this.transition.then(perform, perform);
    return this.transition;
  }
}

module.exports = { ActivityLog, DEFAULT_ROTATE_BYTES, DEFAULT_QUEUE_BYTES };
