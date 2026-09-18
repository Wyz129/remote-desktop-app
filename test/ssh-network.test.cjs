'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { forward, createSshProxy, sshAgent } = require('../lib/ssh-network.cjs');
const { SshBackend } = require('../lib/ssh-backend.cjs');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');

async function fixture(t) {
  const calls = [], sockets = new Set();
  const server = http.createServer((request, response) => { response.setHeader('Content-Type', 'text/plain'); response.end(`remote:${request.headers.host}${request.url}`); });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const backend = { connected: true, client: { forwardOut(_source, _sourcePort, host, port, callback) { calls.push({ host, port }); const socket = net.connect(server.address().port, '127.0.0.1'); socket.once('connect', () => callback(null, socket)); socket.once('error', callback); } } };
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { backend, calls };
}
function reader(socket) { let pending = Buffer.alloc(0), waiter; socket.on('data', data => { pending = Buffer.concat([pending, data]); waiter?.(); }); return async count => { while (pending.length < count) await new Promise(resolve => { waiter = resolve; }); const value = pending.subarray(0, count); pending = pending.subarray(count); waiter = null; return value; }; }

test('HTTP agent passes the original hostname and port to SSH without local DNS', async t => {
  const { backend, calls } = await fixture(t), agent = sshAgent(backend);
  t.after(() => agent.destroy());
  const body = await new Promise((resolve, reject) => { http.get('http://only-on-server.invalid:8765/report?q=1', { agent }, response => { const chunks = []; response.on('data', data => chunks.push(data)); response.on('end', () => resolve(Buffer.concat(chunks).toString())); }).on('error', reject); });
  assert.equal(body, 'remote:only-on-server.invalid:8765/report?q=1');
  assert.deepEqual(calls, [{ host: 'only-on-server.invalid', port: 8765 }]);
});
test('SOCKS5 domain request supports fragmented greeting and forwards early payload through SSH', async t => {
  const { backend, calls } = await fixture(t), proxy = await createSshProxy(backend);
  t.after(() => proxy.close());
  const socket = net.connect(proxy.port, '127.0.0.1'), read = reader(socket); t.after(() => socket.destroy()); await once(socket, 'connect');
  socket.write(Buffer.from([5])); socket.write(Buffer.from([1, 0])); assert.deepEqual(await read(2), Buffer.from([5, 0]));
  const host = Buffer.from('server-dns-only.invalid'), port = Buffer.from([0x1f, 0x90]);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, port, Buffer.from('GET /ssh HTTP/1.1\r\nHost: server-dns-only.invalid\r\nConnection: close\r\n\r\n')]));
  assert.equal((await read(10))[1], 0);
  assert.equal((await read(12)).toString(), 'HTTP/1.1 200');
  assert.deepEqual(calls, [{ host: 'server-dns-only.invalid', port: 8080 }]);
});
test('SOCKS denies unsupported authentication and UDP instead of sending direct traffic', async t => {
  const { backend, calls } = await fixture(t), proxy = await createSshProxy(backend); t.after(() => proxy.close());
  const socket = net.connect(proxy.port, '127.0.0.1'), read = reader(socket); t.after(() => socket.destroy()); await once(socket, 'connect');
  socket.write(Buffer.from([5, 1, 2])); assert.deepEqual(await read(2), Buffer.from([5, 255]));
  const socket2 = net.connect(proxy.port, '127.0.0.1'), read2 = reader(socket2); t.after(() => socket2.destroy()); await once(socket2, 'connect');
  socket2.write(Buffer.from([5, 1, 0])); await read2(2); socket2.write(Buffer.from([5, 3, 0, 1, 127, 0, 0, 1, 0, 53]));
  assert.equal((await read2(10))[1], 1); assert.deepEqual(calls, []);
});
test('cancelled and replaced SSH channels destroy late streams', async () => {
  let callback; const backend = { connected: true, client: { forwardOut(...args) { callback = args.at(-1); } } };
  const controller = new AbortController(); const pending = forward(backend, 'localhost', 80, controller.signal); controller.abort(); await assert.rejects(pending, /取消/);
  const stream = new PassThrough(); callback(null, stream); assert.equal(stream.destroyed, true);
  const pending2 = forward(backend, 'localhost', 80); backend.client = {}; const stream2 = new PassThrough(); callback(null, stream2); await assert.rejects(pending2, /改变/); assert.equal(stream2.destroyed, true);
  await assert.rejects(forward(backend, 'bad\nhost', 80), /地址无效/);
});

test('HTTP agent uses a real SSH channel and supports Node request inactivity timeout', { timeout: 15000 }, async t => {
  const server = http.createServer((request, response) => { if (request.url !== '/hang') response.end('real SSH agent'); });
  const sockets = new Set(); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = await createSshFixture({ forwardTargets: { 'agent-only.invalid:8765': server.address().port } });
  const backend = new SshBackend(); let agent;
  t.after(async () => { agent?.destroy(); await backend.disconnect(); await endpoint.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await backend.connect(endpoint.config); agent = sshAgent(backend);
  const body = await new Promise((resolve, reject) => { const req = http.get('http://agent-only.invalid:8765/', { agent }, response => { const chunks = []; response.on('data', data => chunks.push(data)); response.on('end', () => resolve(Buffer.concat(chunks).toString())); }); req.setTimeout(2000, () => req.destroy(new Error('unexpected timeout'))); req.on('error', reject); });
  assert.equal(body, 'real SSH agent');
  await assert.rejects(new Promise((resolve, reject) => { const req = http.get('http://agent-only.invalid:8765/hang', { agent }, resolve); req.setTimeout(100, () => req.destroy(new Error('inactivity timeout'))); req.on('error', reject); }), /inactivity timeout/);
  assert.ok(endpoint.calls.forwards.every(value => value.destIP === 'agent-only.invalid' && value.destPort === 8765));
});
