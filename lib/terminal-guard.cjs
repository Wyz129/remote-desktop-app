'use strict';

// Text editing belongs to Monaco Editor. Closing a terminal closes its SSH
// channel without injecting editor commands or asking about saving.
class TerminalGuard {
  constructor({ getBackend, closed, onAction }) { this.getBackend = getBackend; this.closed = closed; this.onAction = onAction; this.requests = new Map(); }
  request(id, backend = this.getBackend()) {
    if (this.requests.has(id)) return this.requests.get(id);
    const request = Promise.resolve().then(() => {
      this.onAction?.({ type: 'terminal-close-command', terminalId: id, command: 'SSH channel close' }, backend);
      backend?.closeShell(id); this.closed(id); return true;
    }).finally(() => this.requests.delete(id));
    this.requests.set(id, request); return request;
  }
  async all() { const backend = this.getBackend(); for (const id of [...(backend?.terminalSessions.keys() || [])]) await this.request(id, backend); return true; }
}
module.exports = { TerminalGuard };
