'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { X11DesktopManager, shellScript, stopScript } = require('../lib/x11-desktop.cjs');

function backend(remotePort = 14500) {
  const commands = [];
  const client = { forwardOut() {} };
  return { connected: true, client, home: '/home/tester', commands,
    async execText(command) { commands.push(command); return command.includes('remote-desktop-x11-v4') ? `ready\nport=${remotePort}\n` : 'stopped\n'; } };
}

test('X11 start script is user scoped and checks the three required components', async () => {
  const script = shellScript({ root: '/home/u/.rdesktop', run: '/home/u/.rdesktop/x11/run', log: '/home/u/.rdesktop/log/x11', display: ':99', port: 14500, width: 1280, height: 800, depth: 24 });
  assert.match(script, /PATH="\$root\/opt\/bin:\$validation\/xpra-root\/usr\/bin:\$validation\/root\/usr\/bin:\$PATH"/);
  assert.match(script, /PYTHONPATH="\$validation\/xpra-root\/usr\/lib\/python3\/dist-packages/);
  assert.match(script, /command -v Xvfb/);
  assert.match(script, /command -v xfce4-session/);
  assert.match(script, /command -v xpra/);
  assert.match(script, /--bind-tcp="127\.0\.0\.1:\$port"/);
  assert.match(script, /--html=on/);
  assert.match(script, /-nolisten tcp -ac/);
  assert.match(script, /port_open\(\)/);
  assert.match(script, /jquery\.js/);
  assert.match(script, /ready\\nport=%s/);
  assert.doesNotMatch(script, /apt(-get)? install|sudo\b|dpkg -i/);
  const stop = stopScript({ run: '/home/u/.rdesktop/x11/run', display: ':99' });
  assert.match(stop, /kill "\$pid"/);
  assert.match(stop, /\.X11-unix\/X\$\{display#:\}/);
});

test('X11 manager starts a single local loopback forward and stops remote session', async () => {
  const source = backend();
  const manager = new X11DesktopManager(source, { validateHtml: async () => ({ resources: [] }) });
  const state = await manager.start({ width: 1024, height: 768 });
  assert.equal(state.active, true);
  assert.equal(state.width, 1024);
  assert.ok(Number.isInteger(state.localPort) && state.localPort > 0);
  assert.equal(source.commands.length, 1);
  assert.match(source.commands[0], /remote-desktop-x11-v4/);
  assert.equal(state.port, 14500);
  assert.equal(manager.status().active, true);
  await manager.stop();
  assert.equal(manager.status().active, false);
  assert.equal(source.commands.length, 2);
  assert.match(source.commands[1], /remote-desktop-x11-stop-v1/);
});

test('X11 manager rejects missing SSH and normalizes unsafe display values', async () => {
  await assert.rejects(() => new X11DesktopManager({ connected: false }).start(), /SSH 尚未连接/);
  const source = backend();
  const manager = new X11DesktopManager(source, { validateHtml: async () => ({ resources: [] }) });
  const state = await manager.start({ display: ':99;rm' });
  assert.equal(state.display, ':99');
  await manager.stop();
});

test('X11 manager forwards the actual port returned by the remote readiness probe', async () => {
  const source = backend(14517);
  const destinations = [];
  source.client.forwardOut = (_host, _port, host, port, callback) => { destinations.push({ host, port }); callback(new Error('Fixture only records the target')); };
  const manager = new X11DesktopManager(source, { validateHtml: async () => ({ resources: [] }) });
  const state = await manager.start();
  assert.equal(state.port, 14517);
  await new Promise(resolve => { const socket = net.connect(state.localPort, '127.0.0.1'); socket.on('error', () => {}); socket.on('close', resolve); });
  assert.deepEqual(destinations, [{ host: '127.0.0.1', port: 14517 }]);
  await manager.stop();
});

test('missing HTML dependency closes the local forward and cleans up instead of reporting ready', async () => {
  const source = backend();
  let checkedUrl;
  const manager = new X11DesktopManager(source, { validateHtml: async url => { checkedUrl = url; throw new Error('jquery.js HTTP 404'); } });
  await assert.rejects(manager.start(), /jquery\.js HTTP 404/);
  assert.equal(manager.status().active, false);
  assert.equal(manager.forward, null);
  assert.match(source.commands.at(-1), /remote-desktop-x11-stop/);
  const port = Number(new URL(checkedUrl).port);
  await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); reject(new Error('Forward leaked')); });
    socket.once('error', error => { assert.equal(error.code, 'ECONNREFUSED'); resolve(); });
  });
});

test('missing reported remote port fails before forwarding', async () => {
  const source = backend();
  source.execText = async command => { source.commands.push(command); return 'ready\n'; };
  const manager = new X11DesktopManager(source);
  await assert.rejects(manager.start(), /无效转发端口/);
  assert.equal(manager.forward, null);
  assert.match(source.commands.at(-1), /remote-desktop-x11-stop/);
});
