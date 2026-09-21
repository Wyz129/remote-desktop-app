'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { SshBackend } = require('../lib/ssh-backend.cjs');
const { InstanceBridge, listInstances, requestInstance } = require('../lib/instance-bridge.cjs');
const { openInteractiveShell } = require('../lib/interactive-shell.cjs');
const { launchLocalTerminal } = require('../lib/local-terminal.cjs');
const { runCli } = require('../scripts/cli.cjs');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');

async function setup(t) {
  const fixture = await createSshFixture(), backend = new SshBackend(), events = [];
  const bridge = new InstanceBridge({ userDataDir: path.join(fixture.root, 'shell-user'), onActivity: event => events.push(event), callbacks: {
    status: () => ({ connected: backend.connected }),
    shell: (args, context) => openInteractiveShell(backend, args, context)
  } });
  t.after(async () => { await bridge.close(); await backend.disconnect(); await fixture.close(); });
  await backend.connect(fixture.config); await bridge.start();
  return { fixture, backend, bridge, entry: (await listInstances(path.join(fixture.root, 'shell-user')))[0], events };
}
async function eventually(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.ok(predicate(), 'expected asynchronous terminal state');
}

test('local terminal uses authenticated instance and one SSH connection for duplex UTF8, resize, interrupt and detach', { timeout: 20000 }, async t => {
  const { fixture, backend, entry, events } = await setup(t);
  const authCount = fixture.calls.auth.length;
  let output = '', send;
  const pending = requestInstance(entry, 'shell', { cwd: fixture.home, cols: 93, rows: 29 }, {
    timeoutMs: 10000, onReady: write => { send = write; },
    onProgress: value => { if (value.kind === 'stdout') output += value.data; }
  });
  await eventually(() => send && output.includes('fixture-shell-ready'));
  send({ type: 'input', data: 'echo 中文🌏\r' });
  send({ type: 'resize', cols: 101, rows: 40 });
  send({ type: 'input', data: '\x03' });
  await eventually(() => output.includes('fixture-echo:echo 中文🌏\r') && output.includes('\x03') && fixture.calls.resize.some(item => item.cols === 101));
  send({ type: 'close' }); assert.equal((await pending).code, 0);
  assert.equal(backend.connected, true); assert.equal(backend.shells.size, 0);
  assert.equal(fixture.calls.auth.length, authCount, 'no additional SSH authentication');
  assert.ok(events.some(event => event.progress?.kind === 'command' && event.progress.data.includes('exec')));
  assert.ok(events.some(event => event.progress?.kind === 'terminal-input' && event.progress.data.includes('中文')));
  assert.ok(events.some(event => event.progress?.kind === 'stdout' && event.progress.data.includes('fixture-echo')));
  assert.equal(events.filter(event => event.type === 'finish').length, 1);
  assert.ok(!JSON.stringify(events).includes(entry.token));
});

test('invalid terminal frames and wrong tokens cannot send remote input; disconnect releases active shells', { timeout: 20000 }, async t => {
  const { fixture, backend, entry } = await setup(t);
  await assert.rejects(requestInstance({ ...entry, token: '0'.repeat(64) }, 'shell'), /认证失败/);
  for (const frame of [{ type: 'resize', cols: -1, rows: 20 }, { type: 'input', data: 'x'.repeat(65537) }, { type: 'exec', command: 'bad' }]) {
    await assert.rejects(requestInstance(entry, 'shell', {}, { timeoutMs: 3000, onReady: send => send(frame) }));
    await eventually(() => backend.shells.size === 0);
  }
  assert.equal(fixture.calls.shell.length, 0);
  const controller = new AbortController();
  await assert.rejects(requestInstance(entry, 'shell', {}, { signal: controller.signal, onReady: () => controller.abort() }), /取消/);
  await eventually(() => backend.shells.size === 0);
  const disconnected = requestInstance(entry, 'shell', {}, { timeoutMs: 3000, onReady: () => { void backend.disconnect(); } });
  await disconnected.catch(error => assert.match(error.message, /断开|中断|关闭/));
  await eventually(() => backend.shells.size === 0);
});

test('CLI shell preserves split UTF8 and raw-mode lifecycle, Ctrl+C and Ctrl+] semantics', async () => {
  const input = new EventEmitter(), output = new EventEmitter(); let received = '', written = '', resumed = false, paused = false;
  input.isTTY = true; input.isRaw = false; input.setRawMode = value => { input.isRaw = value; };
  input.resume = () => { resumed = true; }; input.pause = () => { paused = true; };
  output.write = value => { written += value; }; output.columns = 100; output.rows = 30;
  let size;
  const code = await runCli(['shell', '--instance', 'exact', '--cwd', '/home/a'], {
    stdin: input, stdout: output, stderr: { write() {} },
    listInstances: async () => [{ instanceId: 'exact', status: { connected: true } }],
    requestInstance: async (entry, action, args, options) => {
      assert.equal(entry.instanceId, 'exact'); assert.equal(action, 'shell'); assert.equal(args.cwd, '/home/a'); assert.equal(options.timeoutMs, 0);
      options.onReady(frame => { if (frame.type === 'input') received += frame.data; if (frame.type === 'resize') size = frame; if (frame.type === 'close') received += '[closed]'; });
      assert.equal(input.isRaw, true);
      for (const byte of Buffer.from('中文🌏')) input.emit('data', Buffer.from([byte]));
      input.emit('data', Buffer.from('\x03')); output.emit('resize'); options.onProgress({ kind: 'stdout', data: '回复' });
      input.emit('data', Buffer.from('\x1d'));
      return { code: 7 };
    }
  });
  assert.equal(code, 7); assert.equal(received, '中文🌏\x03[closed]'); assert.match(written, /回复/);
  assert.deepEqual(size, { type: 'resize', cols: 100, rows: 30 });
  assert.equal(input.isRaw, false); assert.ok(resumed && paused); assert.equal(input.listenerCount('data'), 0);
  assert.equal(output.listenerCount('resize'), 0);
  await assert.rejects(runCli(['shell'], { stdin: { isTTY: false }, listInstances: async () => [{ status: { connected: true } }] }), /交互终端/);
});

test('native launcher quotes literal PowerShell arguments and never passes authentication secrets', { skip: process.platform !== 'win32' }, async () => {
  let launched;
  const input = { executable: 'C:\\app dir\\Remote Desktop.exe', cliPath: 'C:\\app dir\\cli.cjs', userDataDir: 'C:\\users\\data', instanceId: 'instance-1', cwd: "/home/it' s/$(not-executed)", identity: 'identity' };
  const result = await launchLocalTerminal(input, (...args) => { launched = args; const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 0)); return child; });
  assert.equal(result.opened, true); assert.match(launched[0], /WindowsPowerShell.*powershell\.exe$/);
  assert.equal(launched[2].windowsHide, true); assert.equal(launched[2].env.ELECTRON_RUN_AS_NODE, '1');
  const launcher = Buffer.from(launched[1].at(-1), 'base64').toString('utf16le');
  assert.match(launcher, /Start-Process.*-WindowStyle Normal/);
  const script = Buffer.from(launcher.match(/'-EncodedCommand', '([A-Za-z0-9+/=]+)'/)[1], 'base64').toString('utf16le');
  assert.ok(script.includes('/home/it\'\' s/$(not-executed)')); assert.ok(script.includes('"shell" "--instance" "instance-1"'));
  assert.match(script, /-NoNewWindow -Wait/);
  assert.ok(!/password|passphrase|token/i.test(script));
  await assert.rejects(launchLocalTerminal(input, () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('cannot launch'))); return child; }), /cannot launch/);
});

test('Windows launcher allocates real native TTY handles (isolated hidden console)', { timeout: 20000, skip: process.platform !== 'win32' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rdesktop-native-console-'));
  t.after(async () => { if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('rdesktop-native-console-')) throw new Error('Unsafe cleanup'); await fs.rm(directory, { recursive: true, force: true }); });
  const probe = path.join(directory, 'probe file.cjs'), result = path.join(directory, 'result.json');
  const cwd = '/home/it\' s/$(literal)/"quoted"';
  const cli = process.env.REMOTE_DESKTOP_TEST_EXE ? path.join(path.dirname(process.env.REMOTE_DESKTOP_TEST_EXE), 'resources/cli/scripts/cli.cjs') : path.resolve(__dirname, '../scripts/cli.cjs');
  await fs.writeFile(probe, `const input=require(${JSON.stringify(cli)}).interactiveInput(process.stdin,process.stdout);input.setRawMode(true);require('node:fs').writeFileSync(${JSON.stringify(result)}, JSON.stringify({input:input.isTTY,output:process.stdout.isTTY,raw:typeof input.setRawMode,args:process.argv.slice(2)}));input.setRawMode(false);if(input!==process.stdin)input.destroy();`);
  await launchLocalTerminal({ executable: process.env.REMOTE_DESKTOP_TEST_EXE || process.execPath, cliPath: probe, userDataDir: directory, instanceId: 'test-console', cwd, identity: 'test' }, (command, args, options) => {
    // Keep production console allocation, only hide this diagnostic window and
    // close it after the probe. No SendKeys or existing user window is involved.
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le').replace("'-NoExit', ", '').replace('-WindowStyle Normal', '-WindowStyle Hidden -Wait');
    return spawn(command, [...args.slice(0, -1), Buffer.from(script, 'utf16le').toString('base64')], options);
  });
  const value = JSON.parse(await fs.readFile(result, 'utf8'));
  assert.equal(value.input, true); assert.equal(value.output, true); assert.equal(value.raw, 'function');
  assert.ok(value.args.includes('shell')); assert.ok(value.args.includes('test-console'));
  assert.equal(value.args[value.args.indexOf('--cwd') + 1], cwd);
});
