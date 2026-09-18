'use strict';

// All intentional close paths share this guard, including reconnect and the
// native application close button. Transport loss remains a separate failure.
class TerminalGuard {
  constructor({ getBackend, ask, report, closed }) {
    this.getBackend = getBackend; this.ask = ask; this.report = report; this.closed = closed;
    this.requests = new Map();
  }
  request(id) {
    if (this.requests.has(id)) return this.requests.get(id);
    const request = this.close(id).finally(() => this.requests.delete(id));
    this.requests.set(id, request); return request;
  }
  async close(id) {
    const backend = this.getBackend(), session = backend?.terminalSessions.get(id);
    if (!session) { this.closed(id); return true; }
    if (!backend.shells.has(id)) { backend.closeShell(id); this.closed(id); return true; }
    const vim = session.program === 'vim';
    const answer = await this.ask(vim ? {
      type: 'question', title: '关闭 Vim', message: '是否保存修改并关闭 Vim？',
      detail: `${session.filePath || 'Vim 编辑器'}\n“保存并关闭”会保存此 Vim 中所有已修改的文件。“不保存关闭”会丢弃尚未保存的修改。`,
      buttons: ['保存并关闭', '不保存关闭', '取消'], defaultId: 0, cancelId: 2, noLink: true
    } : {
      type: 'warning', title: '关闭终端', message: '确认关闭终端？',
      detail: '若在 Shell 中手动启动了 Vim 或其他编辑器，请先取消，在编辑器内保存并正常退出。直接关闭可能丢失未保存内容并留下恢复文件。',
      buttons: ['返回终端', '关闭终端'], defaultId: 0, cancelId: 0, noLink: true
    });
    if ((vim && ![0, 1].includes(answer.response)) || (!vim && answer.response !== 1)) return false;
    if (this.getBackend() !== backend) return false;
    try {
      if (vim) await backend.closeVim(id, answer.response === 0);
      else backend.closeShell(id);
      this.closed(id); return true;
    } catch (error) {
      await this.report({ type: 'warning', title: '终端未关闭', message: '尚未完成关闭，终端已保留。', detail: error.message, buttons: ['返回终端'] });
      return false;
    }
  }
  async all() {
    for (const id of [...(this.getBackend()?.terminalSessions.keys() || [])]) if (!await this.request(id)) return false;
    return true;
  }
}
module.exports = { TerminalGuard };
