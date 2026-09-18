'use strict';
const path = require('node:path').posix;
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { readBuffer, closed } = require('./sftp-stream.cjs');
const { posixQuote, normalizeRemote } = require('./ssh-backend.cjs');
const CONFIG_LIMIT = 64 * 1024;
const SYSTEM_INFO_LIMIT = 32 * 1024;
const SYSTEM_INFO_TIMEOUT = 8000;
// These commands are fixed, read-only queries. No renderer-provided text is
// interpolated into the SSH command, and /etc/os-release is parsed as data.
const SYSTEM_INFO_QUERIES = Object.freeze({
  os: `if [ -r /etc/os-release ]; then awk -F= '$1 == "PRETTY_NAME" { sub(/^[^=]*=/, ""); gsub(/^"|"$/, ""); print; exit }' /etc/os-release; else uname -s; fi`,
  kernel: 'uname -r',
  architecture: 'uname -m',
  cpu: `if [ -r /proc/cpuinfo ]; then awk -F: '/^(model name|Hardware|Processor)[[:space:]]*:/ { sub(/^[^:]*:[[:space:]]*/, ""); print; exit }' /proc/cpuinfo; else getconf _NPROCESSORS_ONLN; fi`,
  hostname: 'hostname',
  username: 'id -un',
  disk: 'df -h -- "$HOME"',
  memory: `if command -v free >/dev/null 2>&1; then free -h; elif [ -r /proc/meminfo ]; then awk '/^(MemTotal|MemAvailable|MemFree|SwapTotal|SwapFree):/ { print }' /proc/meminfo; fi`,
  dateTime: "date '+%Y-%m-%d %H:%M:%S %Z'",
  timeZone: `if [ -s /etc/timezone ]; then cat /etc/timezone; elif command -v readlink >/dev/null 2>&1; then zone=$(readlink /etc/localtime); case "$zone" in */zoneinfo/*) printf '%s' "${'${zone#*/zoneinfo/}'}";; *) date +%Z;; esac; else date +%Z; fi`,
  locale: `if command -v locale >/dev/null 2>&1; then locale; else printf '%s' "${'${LANG:-}'}"; fi`,
  shell: 'printf \'%s\' "$SHELL"',
  network: 'hostname -I || ip -brief address',
});
const SYSTEM_INFO_COMMAND = '# remote-desktop-system-info-v1\n' + Object.entries(SYSTEM_INFO_QUERIES).map(([key, command]) => `printf '%s\\000' ${posixQuote(key)}; (${command}) 2>/dev/null; printf '\\000'`).join('\n');
const missing = error => error?.code === 2 || error?.code === 'ENOENT';
const inside = (root, value) => root === '/' || value === root || value.startsWith(`${root}/`);
const validName = value => {
  if (typeof value !== 'string' || !value.trim() || value === '.' || value === '..' || /[\\/\x00-\x1f]/.test(value)) throw new Error('名称无效。');
  return value;
};

class DesktopService {
  constructor(backend) { this.backend = backend; this.queue = Promise.resolve(); this.configPath = null; this.config = {}; }
  call(method, ...args) {
    const sftp = this.backend.sftp;
    if (!sftp || typeof sftp[method] !== 'function') throw new Error('SSH 尚未连接，或服务器不支持此操作。');
    return new Promise((resolve, reject) => sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)));
  }
  serialize(action) { const task = this.queue.then(action); this.queue = task.catch(() => {}); return task; }
  requirePath(value, mutable = false) {
    const target = normalizeRemote(value);
    if (!this.backend.home || !inside(this.backend.home, target)) throw new Error('文件操作仅允许在当前登录用户的主目录内进行。');
    if (mutable && [this.backend.home, this.backend.desktop, '/'].includes(target)) throw new Error('不能修改主目录或桌面根目录。');
    return target;
  }
  async checked(value, { parent = false, mutable = false } = {}) {
    const target = this.requirePath(value, mutable);
    const resolved = normalizeRemote(await this.call('realpath', parent ? path.dirname(target) : target));
    if (!inside(this.backend.home, resolved)) throw new Error('符号链接目标位于允许的主目录之外。');
    if (mutable && !parent && [this.backend.home, this.backend.desktop, '/'].includes(resolved)) throw new Error('不能修改主目录或桌面根目录。');
    return target;
  }
  async assertAbsent(target) {
    try { await this.call('lstat', target); } catch (error) { if (missing(error)) return; throw error; }
    throw new Error(`已存在同名项目：${path.basename(target)}`);
  }
  async entries(value) {
    const target = await this.checked(value);
    return (await this.backend.list(target)).map(entry => ({ ...entry, type: entry.type === 'directory' ? 'folder' : 'file', sizeBytes: entry.size, size: entry.type === 'directory' ? '' : formatSize(entry.size) }));
  }
  async readSmall(target) {
    const stats = await this.call('stat', target);
    if (!stats.isFile() || stats.size > CONFIG_LIMIT) throw new Error('配置必须是小于 64 KiB 的普通文件。');
    return (await readBuffer(this.backend.sftp, target, CONFIG_LIMIT)).toString('utf8').replace(/^\uFEFF/, '');
  }
  validateConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('桌面配置必须是 JSON 对象。');
    if (value.viewMode !== undefined && !['icons', 'details'].includes(value.viewMode)) throw new Error('无效的视图设置。');
    if (value.wallpaper !== undefined && !['teal', 'purple', 'slate'].includes(value.wallpaper)) throw new Error('无效的背景设置。');
    if (value.showHiddenFiles !== undefined && typeof value.showHiddenFiles !== 'boolean') throw new Error('无效的隐藏文件设置。');
    if (value.positions !== undefined && (!value.positions || typeof value.positions !== 'object' || Array.isArray(value.positions))) throw new Error('无效的图标位置。');
    if (value.pinnedApps !== undefined && (!Array.isArray(value.pinnedApps) || value.pinnedApps.length > 32 || value.pinnedApps.some(app => !app || !['vim', 'htop', 'shell'].includes(app.program) || typeof app.id !== 'string' || typeof app.label !== 'string'))) throw new Error('无效的固定应用。');
    return value;
  }
  async loadConfig() {
    const { home, desktop } = this.backend;
    if (!desktop) return {};
    const candidates = [`${desktop}/.remote-desktop.json`, `${desktop}/config.json`, `${home}/.config/remote-desktop/config.json`, `${home}/.remote-desktop.json`];
    this.configPath = candidates[0]; this.config = {}; this.configError = null;
    for (const target of candidates) {
      try { await this.checked(target); this.config = this.validateConfig(JSON.parse(await this.readSmall(target))); this.configPath = target; break; }
      catch (error) { if (missing(error)) continue; this.configPath = target; this.configError = `无法载入桌面配置 ${target}：${error.message}`; break; }
    }
    return this.config;
  }
  async saveConfig(patch) {
    return this.serialize(async () => {
      if (!this.configPath) throw new Error('桌面尚未就绪。');
      await this.checked(this.configPath, { parent: true });
      let existing = {}; let exists = false;
      try { await this.checked(this.configPath); existing = this.validateConfig(JSON.parse(await this.readSmall(this.configPath))); exists = true; }
      catch (error) { if (!missing(error)) throw error; }
      const incoming = typeof patch === 'function' ? patch(existing) : patch;
      const allowed = Object.fromEntries(Object.entries(incoming || {}).filter(([key]) => ['positions', 'viewMode', 'wallpaper', 'showHiddenFiles', 'pinnedApps'].includes(key)));
      const next = this.validateConfig({ ...existing, ...allowed });
      const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
      if (bytes.length > CONFIG_LIMIT) throw new Error('配置超过 64 KiB。');
      const temp = `${this.configPath}.tmp-${crypto.randomUUID()}`;
      try {
        await this.call('writeFile', temp, bytes, { flag: 'wx', mode: 0o600 });
        if (exists) await this.call('ext_openssh_rename', temp, this.configPath);
        else await this.call('rename', temp, this.configPath);
        this.config = next; this.configError = null; return next;
      } finally { try { await this.call('unlink', temp); } catch (error) { if (!missing(error)) this.cleanupWarning = error.message; } }
    });
  }
  updatePinned(appEntry, removeId) {
    if (appEntry && (!['shell', 'vim', 'htop'].includes(appEntry.program) || typeof appEntry.label !== 'string' || !appEntry.label.trim() || appEntry.label.length > 120)) throw new Error('无效的固定程序。');
    return this.saveConfig(current => {
      const entries = current.pinnedApps || [];
      return { pinnedApps: appEntry ? [...entries.filter(item => item.program !== appEntry.program && item.id !== `pinned-${appEntry.program}`), { id: `pinned-${appEntry.program}`, program: appEntry.program, label: appEntry.label }] : entries.filter(item => item.id !== removeId) };
    });
  }
  async inspect(create = false) {
    const result = await this.backend.discoverDesktop(create);
    if (!result.found) return { type: 'remoteState', status: 'missing', homePath: this.backend.home, message: `未在 ${this.backend.home} 找到 Desktop、desktop 或 桌面目录。` };
    return { type: 'remoteState', status: 'ready', homePath: this.backend.home, rootPath: result.path, folder: result.path, entries: await this.entries(result.path), config: result.config, configError: result.configError };
  }
  async remove(target) {
    const stats = await this.call('lstat', target);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      for (const entry of await this.call('readdir', target)) await this.remove(path.join(target, validName(entry.filename)));
      await this.call('rmdir', target);
    } else await this.call('unlink', target);
  }
  async copy(source, destination) {
    const stats = await this.call('lstat', source);
    if (stats.isSymbolicLink()) { await this.call('symlink', await this.call('readlink', source), destination); return; }
    if (stats.isDirectory()) {
      await this.call('mkdir', destination);
      for (const entry of await this.call('readdir', source)) { const name = validName(entry.filename); await this.copy(path.join(source, name), path.join(destination, name)); }
    } else {
      if (!stats.isFile()) throw new Error('仅支持普通文件、目录及符号链接。');
      const input = this.backend.sftp.createReadStream(source);
      const output = this.backend.sftp.createWriteStream(destination, { flags: 'wx', mode: stats.mode & 0o777 });
      const closures = [closed(input), closed(output)];
      const outcomes = await Promise.allSettled([pipeline(input, output), ...closures]);
      const failed = outcomes.find(value => value.status === 'rejected');
      if (failed) throw failed.reason;
    }
  }
  async unusedName(parent, name, directory = false) {
    const ext = directory ? '' : path.extname(name); const stem = ext ? name.slice(0, -ext.length) : name;
    for (let index = 0; index < 10000; index++) {
      const target = path.join(parent, index ? `${stem} (${index + 1})${ext}` : name);
      try { await this.call('lstat', target); } catch (error) { if (missing(error)) return target; throw error; }
    }
    throw new Error('同名项目过多。');
  }
  async operate(message, confirmDelete) {
    return this.serialize(async () => {
      const created = [], affected = new Set([this.backend.desktop]);
      const operation = message.operation;
      const paths = [...new Set(message.paths || message.clipboard?.paths || [])];
      if (paths.length > 1000) throw new Error('单次最多操作 1000 项。');
      if (['new-file', 'new-folder'].includes(operation)) {
        const parent = await this.checked(message.parent); const target = path.join(parent, validName(message.name)); await this.assertAbsent(target);
        if (operation === 'new-file') await this.call('writeFile', target, Buffer.alloc(0), { flag: 'wx', mode: 0o600 }); else await this.call('mkdir', target);
        created.push(target); affected.add(parent);
      } else if (operation === 'delete') {
        for (const source of paths) await this.checked(source, { mutable: true, parent: true });
        if (!paths.length || !await confirmDelete(paths)) return { success: false, cancelled: true, affectedPaths: [] };
        for (const source of paths) { await this.remove(source); affected.add(path.dirname(source)); }
      } else if (operation === 'rename') {
        if (paths.length !== 1) throw new Error('重命名需要选择一个项目。');
        const source = await this.checked(paths[0], { mutable: true, parent: true }); const target = path.join(path.dirname(source), validName(message.name));
        if (source !== target) { await this.assertAbsent(target); await this.call('rename', source, target); }
        created.push(target); affected.add(path.dirname(source));
      } else if (operation === 'paste' || operation === 'shortcut') {
        const parent = await this.checked(operation === 'shortcut' ? this.backend.desktop : message.parent);
        const move = message.clipboard?.mode === 'move' || message.clipboard?.mode === 'cut';
        for (const sourceValue of paths) {
          const source = await this.checked(sourceValue, { parent: true, mutable: move });
          const stats = await this.call('lstat', source);
          if (stats.isDirectory() && inside(source, parent)) throw new Error('不能复制或移动目录到自身内部。');
          const destination = (operation === 'shortcut' || !move) ? await this.unusedName(parent, path.basename(source), stats.isDirectory()) : path.join(parent, path.basename(source));
          await this.assertAbsent(destination);
          if (operation === 'shortcut') await this.call('symlink', source, destination);
          else if (move) await this.call('rename', source, destination);
          else await this.copy(source, destination);
          created.push(destination); affected.add(path.dirname(source));
        }
        affected.add(parent);
      } else throw new Error('不支持的文件操作。');
      return { success: true, ok: true, paths: created, affectedPaths: [...affected] };
    });
  }
  async serverInfo() {
    const text = await this.backend.execText("id -un; hostname; date -u +%s");
    const [username, hostname, epoch] = text.trim().split(/\r?\n/);
    return { type: 'serverInfo', remote: true, username, hostname, epochMs: Number(epoch) * 1000, timeZone: 'UTC' };
  }
  async systemInfo() {
    if (!this.backend.home) throw new Error('尚未连接 SSH。');
    const home = this.backend.home;
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { reject(new Error('读取系统信息超时，请重试。')); controller.abort(); }, SYSTEM_INFO_TIMEOUT);
    });
    const query = (async () => {
      const { stream, completion } = await this.backend._execStream(SYSTEM_INFO_COMMAND, controller.signal);
      const chunks = []; let size = 0;
      const reading = (async () => {
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > SYSTEM_INFO_LIMIT) throw new Error('系统信息输出超过 32 KiB 安全上限。');
          chunks.push(Buffer.from(chunk));
        }
      })();
      await Promise.all([reading, completion]);
      const parts = Buffer.concat(chunks).toString('utf8').split('\0');
      const keys = Object.keys(SYSTEM_INFO_QUERIES);
      if (parts.length !== keys.length * 2 + 1 || parts.at(-1) !== '' || keys.some((key, index) => parts[index * 2] !== key)) throw new Error('服务器返回的系统信息格式无效。');
      return { home, ...Object.fromEntries(keys.map((key, index) => [key, parts[index * 2 + 1].replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim() || '未提供'])) };
    })();
    try { return await Promise.race([query, timeout]); }
    catch (error) { controller.abort(); throw error; }
    finally { clearTimeout(timer); }
  }
}
function formatSize(bytes) { if (bytes < 1024) return `${bytes || 0} B`; const units = ['KiB', 'MiB', 'GiB', 'TiB']; let size = bytes / 1024; let i = 0; while (size >= 1024 && i < 3) { size /= 1024; i++; } return `${size.toFixed(1)} ${units[i]}`; }
module.exports = { DesktopService, inside, validName, formatSize };
