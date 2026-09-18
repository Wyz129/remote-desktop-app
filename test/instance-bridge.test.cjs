'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');
const { InstanceBridge, listInstances, requestInstance, executeRemote } = require('../lib/instance-bridge.cjs');
const { runCli, parseArgs, readPassword, launchInstance } = require('../scripts/cli.cjs');
const { SshBackend } = require('../lib/ssh-backend.cjs');
const { createUploadFixture } = require('./helpers/upload-ssh-fixture.cjs');
const options = { timeout: 30000 };
async function bridge(t, callbacks) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rdesktop-bridge-test-'));
  const server = new InstanceBridge({ userDataDir: directory, callbacks: { status: async () => ({ connected: true, host: 'fixture' }), ...callbacks } });
  t.after(async () => { await server.close(); if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('rdesktop-bridge-test-')) throw new Error('Unsafe cleanup'); await fs.rm(directory, { recursive: true, force: true }); });
  await server.start(); return { server, directory, entry: (await listInstances(directory))[0] };
}
function capture() { let text = ''; return { write(value) { text += value; }, get text() { return text; } }; }

test('authenticated named pipe/socket bridge discovers instance and rejects wrong tokens', options, async t => {
  const { server, entry, directory } = await bridge(t);
  assert.equal(entry.status.host, 'fixture'); assert.equal(entry.instanceId, server.instanceId);
  await assert.rejects(requestInstance({ ...entry, token: '0'.repeat(64) }, 'status'), /认证失败/);
  await assert.rejects(requestInstance(entry, 'unknown'), /不支持/);
  const registry = await fs.readFile(server.registryPath, 'utf8'); assert.ok(!registry.includes('password'));
  await server.close(); assert.deepEqual(await listInstances(directory), []);
});

test('bridge forwards progress and disconnect aborts long operation', options, async t => {
  let observedAbort = false;
  const { entry } = await bridge(t, { upload: (_args, context) => new Promise((resolve, reject) => {
    context.onProgress({ done: 2, total: 10 });
    context.signal.addEventListener('abort', () => { observedAbort = true; reject(new Error('cancelled')); }, { once: true });
  }) });
  const controller = new AbortController();
  await assert.rejects(requestInstance(entry, 'upload', {}, { signal: controller.signal, onProgress: value => { assert.equal(value.done, 2); controller.abort(); } }), error => error.code === 'ABORT_ERR');
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(observedAbort, true);
});

test('CLI selects instances, forwards upload/exec and never prints auth token', options, async t => {
  const calls = [], { entry, directory } = await bridge(t, {
    upload: async args => { calls.push(args); return { path: '/uploads/test.txt', total: 5 }; },
    exec: async args => { calls.push(args); return { stdout: 'result\n', stderr: 'warning\n', code: 7 }; }
  });
  let stdout = capture(), stderr = capture();
  await runCli(['--user-data-dir', directory, 'list'], { stdout, stderr });
  assert.ok(stdout.text.includes(entry.instanceId)); assert.ok(!stdout.text.includes(entry.token));
  stdout = capture(); await runCli(['--user-data-dir', directory, 'upload', './a.txt', '/uploads'], { stdout, stderr });
  assert.equal(calls[0].localPath, path.resolve('a.txt')); assert.equal(calls[0].remoteDirectory, '/uploads');
  stdout = capture(); stderr = capture();
  assert.equal(await runCli(['--user-data-dir', directory, 'exec', '--cwd', '/uploads', '--', 'printf test'], { stdout, stderr }), 7);
  assert.equal(stdout.text, 'result\n'); assert.equal(stderr.text, 'warning\n'); assert.equal(calls[1].cwd, '/uploads');
});

test('CLI uses hidden password callback, rejects secrets in arguments, and requires instance disambiguation', options, async () => {
  const entry = { instanceId: 'one', token: 'secret', status: {} }; let seen;
  const deps = { stdout: capture(), stderr: capture(), listInstances: async () => [entry], readPassword: async (_input, _out, prompt, stdin) => { assert.match(prompt, /密码/); assert.equal(stdin, false); return 'sensitive'; }, requestInstance: async (_entry, action, args) => { seen = { action, args: { ...args } }; return { connected: true }; } };
  await runCli(['connect', '--host', 'server', '--username', 'alice'], deps);
  assert.equal(seen.args.password, 'sensitive'); assert.equal(seen.action, 'connect'); assert.ok(!deps.stdout.text.includes('sensitive'));
  assert.throws(() => parseArgs(['connect', '--password', 'do-not-log']), /不能写入命令行/);
  assert.throws(() => parseArgs(['connect', '--password=do-not-log']), error => !error.message.includes('do-not-log'));
  await assert.rejects(runCli(['status'], { ...deps, listInstances: async () => [entry, { ...entry, instanceId: 'two' }] }), /多个/);
  await runCli(['status', '--instance', 'two'], { ...deps, listInstances: async () => [entry, { ...entry, instanceId: 'two' }] });
});

test('explicit password-stdin consumes a line without echo', options, async () => {
  const input = new PassThrough(), output = capture();
  const result = readPassword(input, output, 'Password:', true); input.end('secret password\n');
  assert.equal(await result, 'secret password'); assert.equal(output.text, '');
  await assert.rejects(readPassword(new PassThrough(), output, 'Password:'), /交互终端/);
});

test('CLI reuses a bound key only for the same account and password-stdin overrides it', options, async () => {
  const entry = { instanceId: 'one', status: { host: 'server', username: 'alice', port: 2222, privateKeyPath: path.resolve('bound key') } };
  let seen, passwordCalls = [];
  const dependencies = { stdout: capture(), stderr: capture(), listInstances: async () => [entry],
    readPassword: async (_input, _out, prompt, stdin = false) => { passwordCalls.push({ prompt, stdin }); return 'sensitive'; },
    requestInstance: async (_entry, action, args) => { seen = { action, args: { ...args } }; return { connected: true }; } };
  await runCli(['connect'], dependencies);
  assert.equal(seen.args.privateKeyPath, entry.status.privateKeyPath); assert.equal(seen.args.password, undefined); assert.equal(passwordCalls.length, 0);
  await runCli(['connect', '--ask-passphrase'], dependencies);
  assert.equal(seen.args.passphrase, 'sensitive'); assert.match(passwordCalls[0].prompt, /私钥口令/); assert.equal(passwordCalls[0].stdin, false);
  passwordCalls = [];
  await runCli(['connect', '--password-stdin'], dependencies);
  assert.equal(seen.args.privateKeyPath, undefined); assert.equal(seen.args.password, 'sensitive'); assert.equal(passwordCalls[0].stdin, true);
  for (const argument of [['--host', 'another'], ['--username', 'bob'], ['--port', '22']]) {
    passwordCalls = []; await runCli(['connect', ...argument], dependencies);
    assert.equal(seen.args.privateKeyPath, undefined); assert.equal(seen.args.password, 'sensitive'); assert.equal(passwordCalls[0].stdin, false);
  }
  await runCli(['connect', '--key', './explicit key'], dependencies);
  assert.equal(seen.args.privateKeyPath, path.resolve('explicit key'));
  await assert.rejects(runCli(['connect', '--key', './explicit key', '--password-stdin'], dependencies), /不能同时/);
  await assert.rejects(runCli(['connect', '--host', 'another', '--ask-passphrase'], dependencies), /需要 --key/);
});

test('bounded remote exec uses SSH, keeps stderr/exit code, and enforces timeout/output/cancel', options, async t => {
  const fixture = await createUploadFixture(), backend = new SshBackend();
  t.after(async () => { await backend.disconnect(); await fixture.close(); }); await backend.connect(fixture.config);
  const result = await executeRemote(backend, { command: 'test-success', cwd: '/uploads' });
  assert.deepEqual(result, { stdout: '你好 output\n', stderr: 'warning\n', code: 0, signal: null });
  assert.equal((await executeRemote(backend, { command: 'test-failure' })).code, 17);
  await assert.rejects(executeRemote(backend, { command: 'test-timeout', timeoutMs: 100 }), error => error.code === 'ETIMEDOUT');
  await assert.rejects(executeRemote(backend, { command: 'test-large-output', maxBytes: 512 }), error => error.code === 'OUTPUT_LIMIT');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executeRemote(backend, { command: 'test-success' }, { signal: controller.signal }), error => error.code === 'ABORT_ERR');
});

test('CLI launch passes user data as an argument and does not invoke a shell', options, async () => {
  const { EventEmitter } = require('node:events'); let seen;
  const instances = await launchInstance({ exe: process.execPath, 'user-data-dir': path.join(os.tmpdir(), 'chosen instance') }, {
    spawn: (executable, args, settings) => { seen = { executable, args, settings }; const child = new EventEmitter(); child.unref = () => {}; process.nextTick(() => child.emit('spawn')); return child; },
    listInstances: async () => [{ instanceId: 'ready' }]
  });
  assert.equal(instances[0].instanceId, 'ready'); assert.equal(seen.settings.shell, false); assert.equal(seen.settings.windowsHide, true);
  assert.ok(seen.args.some(value => value.startsWith('--user-data-dir='))); assert.equal(seen.settings.env.ELECTRON_RUN_AS_NODE, undefined);
});

test('packaged CLI launch locates the sibling executable without requiring Node or Electron packages', options, async t => {
  const { EventEmitter } = require('node:events'); let seen;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rdesktop-packaged-cli-test-'));
  t.after(async () => { if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('rdesktop-packaged-cli-test-')) throw new Error('Unsafe cleanup'); await fs.rm(directory, { recursive: true, force: true }); });
  const executable = path.join(directory, 'Remote Desktop.exe'); await fs.writeFile(executable, 'fixture');
  const previous = process.env.ELECTRON_RUN_AS_NODE; process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const instances = await launchInstance({ 'user-data-dir': path.join(directory, 'userdata') }, {
      scriptDirectory: path.join(directory, 'resources', 'cli', 'scripts'),
      spawn: (file, args, settings) => { seen = { file, args, settings }; const child = new EventEmitter(); child.unref = () => {}; process.nextTick(() => child.emit('spawn')); return child; },
      listInstances: async () => [{ instanceId: 'ready' }]
    });
    assert.equal(instances[0].instanceId, 'ready'); assert.equal(seen.file, executable);
    assert.deepEqual(seen.args, [`--user-data-dir=${path.join(directory, 'userdata')}`]);
    assert.equal(seen.settings.env.ELECTRON_RUN_AS_NODE, undefined); assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(seen.settings.shell, false);
  } finally { if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = previous; }
});
