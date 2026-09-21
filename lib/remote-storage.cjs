'use strict';

const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 15000;
const missing = error => error?.code === 2 || error?.code === 'ENOENT';

function absolutePath(value, label) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\0\r\n]/.test(value)) {
    throw new Error(`${label}不是有效的服务器绝对路径。`);
  }
  return path.posix.normalize(value);
}

/** Initialize this account's private application folders without migrating or
 * replacing any pre-existing data. The caller commits appPaths only after this
 * promise succeeds, alongside its own current-connection guard.
 */
async function ensureRemoteStorage(backend, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const client = backend?.client, sftp = backend?.sftp, home = backend?.home;
  const fingerprint = backend?.hostFingerprint;
  if (!client || !sftp || !home) throw new Error('尚未连接 SSH，无法初始化应用目录。');
  absolutePath(home, 'SSH 主目录');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new Error('应用目录初始化超时必须在 1–120000 毫秒之间。');

  let cancelled, currentPath = home, rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const cancel = error => { if (!cancelled) { cancelled = error; rejectAbort(error); } };
  const changed = () => Object.assign(new Error('SSH 连接已改变，应用目录初始化已取消。'), { code: 'SSH_CONNECTION_CHANGED' });
  const assertActive = () => {
    if (cancelled) throw cancelled;
    if (backend.client !== client || backend.sftp !== sftp || backend.home !== home || backend.hostFingerprint !== fingerprint) throw changed();
  };
  const listeners = [];
  for (const emitter of new Set([client, sftp])) {
    if (typeof emitter.once !== 'function' || typeof emitter.removeListener !== 'function') continue;
    for (const event of ['close', 'end', 'error']) {
      const listener = () => cancel(changed());
      emitter.once(event, listener); listeners.push([emitter, event, listener]);
    }
  }
  const timer = setTimeout(() => cancel(Object.assign(new Error(`应用目录初始化超时：${currentPath}`), { code: 'ETIMEDOUT' })), timeoutMs);
  const call = (method, target, ...args) => {
    assertActive(); currentPath = target;
    return new Promise((resolve, reject) => {
      const done = (error, result) => {
        try { assertActive(); } catch (stale) { reject(stale); return; }
        if (error) {
          const denied = [3, 'EACCES', 'EPERM'].includes(error.code);
          const wrapped = new Error(`${denied ? '无访问权限' : '无法初始化应用目录'}：${target}（${method}）：${error.message || String(error)}`, { cause: error });
          if (error.code !== undefined) wrapped.code = error.code;
          reject(wrapped);
        } else resolve(result);
      };
      try { sftp[method](target, ...args, done); } catch (error) { done(error); }
    });
  };
  const validate = async (target, stats) => {
    if (!stats) stats = await call('lstat', target);
    if (stats.isSymbolicLink?.()) throw new Error(`应用目录不能是符号链接：${target}`);
    if (!stats.isDirectory?.()) throw new Error(`应用目录与已有文件或特殊文件冲突：${target}`);
    const actual = absolutePath(await call('realpath', target), '服务器返回的应用目录');
    if (actual !== target) throw new Error(`应用目录实际位置已改变或包含符号链接：${target} → ${actual}`);
    return stats;
  };
  const ensureDirectory = async target => {
    let stats;
    try { stats = await call('lstat', target); }
    catch (error) {
      if (!missing(error)) throw error;
      let creationError;
      try { await call('mkdir', target, { mode: 0o700 }); }
      catch (error) { creationError = error; }
      // Another app instance may have created the directory since lstat. Never
      // assume any mkdir failure means a safe existing directory.
      try { stats = await call('lstat', target); }
      catch (error) { throw missing(error) && creationError ? creationError : error; }
    }
    await validate(target, stats);
  };

  const initialize = async () => {
    // HOME itself may legitimately be a symlink. Resolve it before constructing
    // app-owned paths; no symlink is accepted below the canonical home.
    const canonicalHome = absolutePath(await call('realpath', home), '服务器主目录');
    const homeStats = await call('lstat', canonicalHome);
    if (!homeStats.isDirectory?.() || homeStats.isSymbolicLink?.()) throw new Error(`SSH 主目录不是普通目录：${canonicalHome}`);
    const root = path.posix.join(canonicalHome, '.rdesktop');
    const result = { root, desktop: path.posix.join(root, 'desktop'), log: path.posix.join(root, 'log'), download: path.posix.join(root, 'download'), trash: path.posix.join(root, 'trash') };
    await ensureDirectory(root);
    for (const target of [result.desktop, result.log, result.download, result.trash]) {
      await validate(root);
      await ensureDirectory(target);
    }
    // Recheck all paths after initialization, including a parent replaced while
    // one of the child operations was pending. SFTP v3 has no mkdirat/O_NOFOLLOW
    // primitive; these checks cannot lock against hostile concurrent mutation.
    for (const target of Object.values(result)) await validate(target);
    assertActive();
    return result;
  };

  try { return await Promise.race([initialize(), aborted]); }
  finally {
    clearTimeout(timer);
    for (const [emitter, event, listener] of listeners) emitter.removeListener(event, listener);
  }
}

module.exports = { ensureRemoteStorage, DEFAULT_TIMEOUT_MS };
