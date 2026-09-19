'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const FINISHED = new Set(['complete', 'error', 'cancelled']);
class TransferCenter {
  constructor(onProgress, options = {}) { this.tasks = new Map(); this.removed = new Set(); this.cancellers = new Map(); this.onProgress = onProgress; this.historyFile = options.historyFile; this.persistQueue = Promise.resolve(); this.historyLimit = options.historyLimit || 500; }
  async load(historyFile = this.historyFile) {
    this.historyFile = historyFile;
    if (!historyFile) return;
    try {
      const stat = await fs.stat(historyFile); if (stat.size > 4 * 1024 * 1024) throw new Error('传输历史文件超过允许大小。');
      const records = JSON.parse(await fs.readFile(historyFile, 'utf8'));
      if (!Array.isArray(records)) throw new Error('传输历史格式无效。');
      for (const record of records.slice(-this.historyLimit)) {
        if (!record || typeof record.id !== 'string' || typeof record.status !== 'string') continue;
        const task = this._public(record);
        if (!FINISHED.has(task.status)) { task.status = 'error'; task.error = '应用上次退出时传输尚未完成，请检查目标后重试。'; }
        this.tasks.set(task.id, task);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  _public(task) {
    const strings = ['id', 'status', 'source', 'name', 'path', 'direction', 'destination', 'targetDirectory', 'targetSide', 'method', 'error', 'kind'];
    const value = Object.fromEntries(strings.filter(key => typeof task[key] === 'string').map(key => [key, task[key].slice(0, 32768)]));
    for (const key of ['done', 'total', 'createdAt', 'finishedAt']) if (Number.isFinite(task[key]) && task[key] >= 0) value[key] = task[key];
    const identity = task.serverIdentity;
    if (identity && ['host', 'username', 'fingerprint'].every(key => typeof identity[key] === 'string') && Number.isInteger(identity.port)) value.serverIdentity = { host: identity.host, username: identity.username, fingerprint: identity.fingerprint, port: identity.port };
    return value;
  }
  _persist() {
    if (!this.historyFile) return;
    const content = JSON.stringify(this.publicList().slice(-this.historyLimit));
    this.persistQueue = this.persistQueue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.historyFile), { recursive: true });
      const temporary = this.historyFile + '.tmp';
      await fs.writeFile(temporary, content, { mode: 0o600 }); await fs.rename(temporary, this.historyFile);
    });
    this.persistQueue.catch(error => this.onProgress?.({ type: 'history-error', error: `无法保存传输历史：${error.message}` }));
  }
  update(value) {
    if (!value || typeof value.id !== 'string' || this.removed.has(value.id)) return;
    const isNew = !this.tasks.has(value.id);
    const previous = this.tasks.get(value.id) || { id: value.id, status: 'running', done: 0, total: 0, createdAt: Date.now() };
    const task = { ...previous, ...value }; if (task.status === 'completed') task.status = 'complete';
    if (FINISHED.has(task.status)) task.finishedAt ||= Date.now();
    this.tasks.set(value.id, task);
    this.onProgress?.(this._public(task));
    while (this.tasks.size > this.historyLimit) { const oldest = [...this.tasks.values()].find(item => FINISHED.has(item.status)); if (!oldest) break; this._remove(oldest.id); }
    if (isNew || previous.status !== task.status || previous.targetDirectory !== task.targetDirectory || FINISHED.has(task.status)) this._persist();
    return task;
  }
  get(id) { return this.tasks.get(String(id)); }
  _remove(id) { this.tasks.delete(id); this.removed.add(id); if (this.removed.size > 10000) this.removed.delete(this.removed.values().next().value); this.onProgress?.({ type: 'removed', id }); }
  remove(id) { const task = this.get(id); if (!task) return false; if (!FINISHED.has(task.status)) throw new Error('请先完成或取消传输，再删除历史。'); this._remove(task.id); this._persist(); return true; }
  clearHistory() { const ids = [...this.tasks.values()].filter(task => FINISHED.has(task.status)).map(task => task.id); for (const id of ids) this._remove(id); this._persist(); return ids; }
  async flush() { await this.persistQueue; }
  list() { return [...this.tasks.values()]; }
  async run(info, action, cancel) {
    const id = String(info.id || crypto.randomUUID());
    if (this.tasks.has(id) || this.removed.has(id)) throw new Error('传输任务 ID 已存在。');
    this.update({ ...info, id, status: 'running' });
    this.cancellers.set(id, cancel);
    try { const result = await action(value => this.update({ ...value, id })); this.update({ ...result, id, status: 'complete' }); return result; }
    catch(error) { this.update({ id, status: error.code === 'ABORT_ERR' || /取消|abort|cancel/i.test(error.message) ? 'cancelled' : 'error', error: error.message }); throw error; }
    finally { this.cancellers.delete(id); }
  }
  cancel(id) { const task = this.tasks.get(String(id)); if (!task || task.status !== 'running') return false; this.cancellers.get(id)?.(); return true; }
  publicList() { return this.list().map(task => this._public(task)); }
}
module.exports = { TransferCenter, FINISHED };
