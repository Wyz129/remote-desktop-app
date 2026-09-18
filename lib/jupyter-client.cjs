'use strict';
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const MAX_RESPONSE = 16 * 1024 * 1024;

// ssh2 channels are Duplex streams, but Node's HTTP/WebSocket client also
// expects these net.Socket methods. Each timeout belongs to this channel,
// never to the shared SSH transport used by the rest of the desktop.
function httpChannel(channel) {
  // Do not rely on ssh2's Channel.setTimeout implementation: it only emits a
  // channel timeout on some versions and Node's HTTP client expects the
  // socket callback semantics. Keep a small per-channel timer instead.
  let timer, timeout = 0;
  const refresh = () => { clearTimeout(timer); if (timeout) { timer = setTimeout(() => channel.emit('timeout'), timeout); timer.unref?.(); } };
  channel.setTimeout = (milliseconds, callback) => { timeout = milliseconds; if (callback) channel.once('timeout', callback); refresh(); return channel; };
  channel.setNoDelay = channel.setKeepAlive = channel.ref = channel.unref = () => channel;
  channel.on('data', refresh); channel.once('close', () => clearTimeout(timer));
  return channel;
}

function endpointUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Jupyter 地址须为 HTTP(S) 服务地址，不能包含用户名、密码或片段。');
  const token = url.searchParams.get('token') || '';
  url.search = ''; url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return { url, token };
}
class JupyterClient extends EventEmitter {
  constructor(sshClient, endpoint, token = '') {
    super(); const parsed = endpointUrl(endpoint);
    this.base = parsed.url; this.token = String(token || parsed.token); this.sshClient = sshClient;
    this.session = crypto.randomUUID(); this.kernelId = null; this.socket = null; this.pending = new Map(); this.closed = false;
    const Agent = this.base.protocol === 'https:' ? https.Agent : http.Agent;
    this.agent = new Agent({ keepAlive: true, maxSockets: 8 });
    this.agent.createConnection = (options, callback) => {
      if (this.closed) { callback(new Error('Jupyter 连接已关闭。')); return; }
      // The destination hostname is resolved by the SSH server, never locally.
      sshClient.forwardOut('127.0.0.1', 0, this.base.hostname.replace(/^\[|\]$/g, ''), Number(this.base.port) || (this.base.protocol === 'https:' ? 443 : 80), (error, channel) => {
        if (error) { callback(error); return; }
        if (this.base.protocol === 'http:') { callback(null, httpChannel(channel)); return; }
        const socket = tls.connect({ socket: channel, servername: this.base.hostname, rejectUnauthorized: true });
        let finished = false;
        socket.once('secureConnect', () => { finished = true; callback(null, socket); });
        socket.once('error', failure => { if (!finished) callback(failure); });
      });
    };
  }
  async request(method, resource, body) {
    if (this.closed) throw new Error('Jupyter 连接已关闭。');
    const url = new URL(resource, this.base), bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json', ...(this.token ? { Authorization: `token ${this.token}` } : {}) };
    if (bytes) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': bytes.length });
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, { method, agent: this.agent, headers }, response => {
        const chunks = []; let count = 0;
        response.on('data', chunk => { count += chunk.length; if (count > MAX_RESPONSE) response.destroy(new Error('Jupyter 响应超过 16 MiB。')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Jupyter HTTP ${response.statusCode}。请检查服务地址和 Token；登录页、重定向及 Cookie 登录不受此接口支持。`)); return;
          }
          try { resolve(text ? JSON.parse(text) : null); } catch { reject(new Error('Jupyter 返回了非 JSON 响应，请检查服务地址。')); }
        });
      });
      request.setTimeout(20000, () => request.destroy(new Error('Jupyter 请求超时。')));
      request.once('error', reject); if (bytes) request.write(bytes); request.end();
    });
  }
  async info() {
    const [specs, kernels] = await Promise.all([this.request('GET', 'api/kernelspecs'), this.request('GET', 'api/kernels')]);
    return { kernelspecs: Object.entries(specs.kernelspecs || {}).map(([name, value]) => ({ name, displayName: value.spec?.display_name || name, language: value.spec?.language || '' })), kernels: (kernels || []).map(item => ({ id: item.id, name: item.name, state: item.execution_state })), endpoint: this.base.href, kernelId: this.kernelId };
  }
  async start(name) {
    const kernel = await this.request('POST', 'api/kernels', { name: String(name) });
    await this.attach(kernel.id); return { id: kernel.id, name: kernel.name };
  }
  async attach(id) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(String(id))) throw new Error('无效的 Jupyter 内核 ID。');
    this.detach(); this.kernelId = id;
    const url = new URL(`api/kernels/${encodeURIComponent(id)}/channels`, this.base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('session_id', this.session);
    const socket = new WebSocket(url, { agent: this.agent, headers: this.token ? { Authorization: `token ${this.token}` } : {}, handshakeTimeout: 20000, maxPayload: MAX_RESPONSE });
    this.socket = socket;
    socket.on('message', (bytes, binary) => {
      if (this.socket !== socket) return;
      if (binary) { this.failPending(new Error('此内核返回了未支持的二进制 Jupyter 消息；请在浏览器中使用 Jupyter。')); return; }
      try { this.message(JSON.parse(bytes.toString())); } catch (error) { this.emit('notice', { error: error.message }); }
    });
    socket.on('error', error => { if (this.socket === socket) { this.failPending(error); this.emit('notice', { error: error.message }); } });
    socket.on('close', () => { if (this.socket === socket) { this.socket = null; this.failPending(new Error('Jupyter 内核通道已断开。')); this.emit('notice', { error: 'Jupyter 内核通道已断开，请重新连接内核。' }); } });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); socket.once('close', () => reject(new Error('Jupyter 内核通道连接失败。'))); });
    return { id };
  }
  execute(code, cellId) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('请先启动或连接 Jupyter 内核。');
    if (typeof code !== 'string' || Buffer.byteLength(code) > MAX_RESPONSE) throw new Error('单元格内容过大。');
    const id = crypto.randomUUID();
    const message = { header: { msg_id: id, username: 'remote-desktop', session: this.session, date: new Date().toISOString(), msg_type: 'execute_request', version: '5.3' }, parent_header: {}, metadata: {}, channel: 'shell', content: { code, silent: false, store_history: true, user_expressions: {}, allow_stdin: false, stop_on_error: true }, buffers: [] };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('单元格执行超过 10 分钟；可中断内核并检查服务器。')); }, 600000);
      this.pending.set(id, { resolve, reject, timer, cellId, idle: false, reply: null, outputBytes: 0 });
      this.socket.send(JSON.stringify(message), error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  message(message) {
    const task = this.pending.get(message.parent_header?.msg_id); if (!task) return;
    const type = message.msg_type || message.header?.msg_type;
    if (message.channel === 'iopub') {
      task.outputBytes += Buffer.byteLength(JSON.stringify(message.content || {}));
      if (task.outputBytes > MAX_RESPONSE) { clearTimeout(task.timer); this.pending.delete(message.parent_header.msg_id); task.reject(new Error('此单元格输出超过 16 MiB，已停止接收。服务器可能仍在执行，请按需中断内核。')); return; }
      if (['stream', 'display_data', 'update_display_data', 'execute_result', 'error', 'clear_output'].includes(type)) this.emit('output', { cellId: task.cellId, type, content: message.content || {} });
      if (type === 'status' && message.content?.execution_state === 'idle') task.idle = true;
    }
    if (type === 'execute_reply') task.reply = message.content || {};
    if (task.idle && task.reply) { clearTimeout(task.timer); this.pending.delete(message.parent_header.msg_id); task.resolve(task.reply); }
  }
  async interrupt() { this.requireKernel(); await this.request('POST', `api/kernels/${encodeURIComponent(this.kernelId)}/interrupt`, {}); }
  async restart() { this.requireKernel(); const id = this.kernelId; await this.request('POST', `api/kernels/${encodeURIComponent(id)}/restart`, {}); await this.attach(id); }
  async shutdown() { this.requireKernel(); await this.request('DELETE', `api/kernels/${encodeURIComponent(this.kernelId)}`); this.detach(); this.kernelId = null; }
  requireKernel() { if (!this.kernelId) throw new Error('尚未连接内核。'); }
  failPending(error) { for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); } this.pending.clear(); }
  detach() { const socket = this.socket; this.socket = null; this.failPending(new Error('Jupyter 内核连接已切换。')); if (socket) socket.terminate(); }
  close() { this.closed = true; this.detach(); this.agent.destroy(); this.token = ''; }
}
module.exports = { JupyterClient, endpointUrl };
