'use strict';
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { Duplex } = require('node:stream');

function forward(backend, host, port, signal) {
  return new Promise((resolve, reject) => {
    if (!backend?.connected) return reject(new Error('SSH 尚未连接。'));
    if (typeof host !== 'string' || !host || host.length > 255 || /[\x00-\x20\x7f]/.test(host) || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) return reject(new Error('SSH 网络目标地址无效。'));
    const client = backend.client;
    const timer = setTimeout(() => finish(new Error('SSH 网络通道连接超时。')), 15000);
    let settled = false;
    const abort = () => finish(new Error('SSH 网络请求已取消。'));
    function finish(error, stream) {
      if (settled) { stream?.destroy(); return; }
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(stream);
    }
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    // Passing the hostname untouched delegates DNS resolution to sshd.
    try {
      client.forwardOut('127.0.0.1', 0, host, Number(port), (error, stream) => {
        if (!backend.connected || backend.client !== client) { stream?.destroy(); return finish(new Error('SSH 连接已改变。')); }
        finish(error, stream);
      });
    } catch (error) { finish(error); }
  });
}

async function createSshProxy(backend) {
  const connection = backend.client;
  const sockets = new Set();
  let closed = false;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(15000, () => socket.destroy());
    let buffer = Buffer.alloc(0), phase = 'greeting';
    const fail = () => { phase = 'failed'; socket.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])); };
    const receive = data => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 65536) return socket.destroy();
      if (phase === 'greeting') {
        if (buffer.length < 2) return;
        const length = 2 + buffer[1]; if (buffer.length < length) return;
        if (buffer[0] !== 5 || !buffer.subarray(2, length).includes(0)) { phase = 'failed'; socket.end(Buffer.from([5, 255])); return; }
        buffer = buffer.subarray(length); phase = 'request'; socket.write(Buffer.from([5, 0]));
      }
      if (phase !== 'request' || buffer.length < 5) return;
      if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0) return fail();
      let host, end;
      if (buffer[3] === 3) { end = 5 + buffer[4]; if (buffer.length < end + 2) return; host = buffer.subarray(5, end).toString('utf8'); }
      else if (buffer[3] === 1) { end = 8; if (buffer.length < 10) return; host = [...buffer.subarray(4, 8)].join('.'); }
      else if (buffer[3] === 4) { end = 20; if (buffer.length < 22) return; host = Array.from({length:8}, (_, i) => buffer.readUInt16BE(4 + i * 2).toString(16)).join(':'); }
      else return fail();
      if (!host || /[\x00-\x20]/.test(host)) return fail();
      const port = buffer.readUInt16BE(end), pending = buffer.subarray(end + 2);
      if (!port) return fail();
      if (closed || backend.client !== connection || !backend.connected) return fail();
      phase = 'connecting'; socket.pause(); socket.removeListener('data', receive);
      void forward(backend, host, port).then(remote => {
        if (closed || socket.destroyed) { remote.destroy(); return; }
        sockets.add(remote); remote.on('error', () => socket.destroy()); remote.on('close', () => { sockets.delete(remote); socket.destroy(); });
        socket.on('close', () => remote.destroy()); socket.setTimeout(0);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        if (pending.length) remote.write(pending);
        socket.pipe(remote); remote.pipe(socket); socket.resume();
      }, fail);
    };
    socket.on('data', receive);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, url: `socks5://127.0.0.1:${server.address().port}`, close: async () => { if (closed) return; closed = true; for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

// ssh2 Channel.destroy() ignores an Error argument. Use a Node Duplex wrapper so
// HTTP/WebSocket cancellation preserves the original error and closes cleanly.
// The wrapper supplies socket methods without opening a local network socket.
function asSocket(channel) {
  let timer, timeout = 0;
  const reset = () => { clearTimeout(timer); if (timeout > 0 && !socket.destroyed) { timer = setTimeout(() => socket.emit('timeout'), timeout); timer.unref?.(); } };
  const socket = new Duplex({
    allowHalfOpen: false,
    read() { channel.resume(); },
    write(data, encoding, callback) { reset(); channel.write(data, encoding, callback); },
    final(callback) { channel.end(callback); },
    destroy(error, callback) { clearTimeout(timer); channel.destroy(); callback(error); }
  });
  channel.on('data', data => { reset(); if (!socket.push(data)) channel.pause(); });
  channel.once('end', () => socket.push(null));
  channel.once('error', error => socket.destroy(error));
  channel.once('close', () => socket.destroy());
  socket.setTimeout = (value, callback) => { timeout = Math.max(0, Number(value) || 0); if (callback) socket.once('timeout', callback); reset(); return socket; };
  socket.setNoDelay = socket.setKeepAlive = () => socket;
  socket.ref = socket.unref = () => socket;
  socket.connecting = false;
  return socket;
}

function sshAgent(backend, secure = false) {
  const agent = secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
  agent.createConnection = (options, callback) => {
    const host = options.hostname || options.host;
    forward(backend, host, options.port || (secure ? 443 : 80)).then(rawStream => {
      const stream = asSocket(rawStream);
      if (!secure) { callback(null, stream); return; }
      let called = false;
      const finish = (error, value) => { if (called) return; called = true; callback(error, value); };
      const socket = tls.connect({ socket: stream, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true });
      socket.once('secureConnect', () => finish(null, socket)); socket.once('error', error => finish(error));
    }, callback);
  };
  return agent;
}
module.exports = { forward, createSshProxy, sshAgent };
