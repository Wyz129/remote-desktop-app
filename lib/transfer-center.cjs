'use strict';
const crypto = require('node:crypto');
class TransferCenter {
  constructor(onProgress) { this.tasks = new Map(); this.cancellers = new Map(); this.onProgress = onProgress; }
  update(value) {
    if (!value || typeof value.id !== 'string') return;
    const previous = this.tasks.get(value.id) || { id: value.id, status: 'running', done: 0, total: 0, createdAt: Date.now() };
    const task = { ...previous, ...value }; this.tasks.set(value.id, task); this.onProgress?.(task); return task;
  }
  list() { return [...this.tasks.values()]; }
  async run(info, action, cancel) {
    const id = String(info.id || crypto.randomUUID());
    if (this.tasks.has(id)) throw new Error('传输任务 ID 已存在。');
    this.update({ ...info, id, status: 'running' });
    this.cancellers.set(id, cancel);
    try { const result = await action(value => this.update({ ...value, id })); this.update({ ...result, id, status: 'complete' }); return result; }
    catch(error) { this.update({ id, status: error.code === 'ABORT_ERR' || /取消|abort|cancel/i.test(error.message) ? 'cancelled' : 'error', error: error.message }); throw error; }
    finally { this.cancellers.delete(id); }
  }
  cancel(id) { const task = this.tasks.get(String(id)); if (!task || task.status !== 'running') return false; this.cancellers.get(id)?.(); return true; }
  publicList() { return this.list().map(({ cancel, ...task }) => task); }
}
module.exports = { TransferCenter };
