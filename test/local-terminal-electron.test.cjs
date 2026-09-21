'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');
const { listInstances, requestInstance } = require('../lib/instance-bridge.cjs');
const project = path.resolve(__dirname, '..');

test('native terminal menu uses exact instance, streams through SSH and writes independent third-party log', { timeout: 90000 }, async t => {
  const fixture = await createSshFixture({ desktop: false }); let application;
  t.after(async () => {
    if (application?.process().exitCode === null) {
      const timer = setTimeout(() => spawnSync('taskkill', ['/pid', String(application.process().pid), '/T', '/F'], { windowsHide: true }), 5000);
      try { await application.close(); } finally { clearTimeout(timer); }
    }
    await fixture.close();
  });
  const userData = path.join(fixture.root, 'native-terminal-app'); await fs.mkdir(userData);
  await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ programPreferences: { favorites: ['terminal'] }, knownHosts: { [`${fixture.config.host}:${fixture.config.port}`]: fixture.fingerprint } }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; const executablePath = process.env.REMOTE_DESKTOP_TEST_EXE;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [project]), '--smoke-test', `--user-data-dir=${userData}`], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  await page.locator('#switchAccountButton:not([disabled])').waitFor();
  await assert.rejects(page.evaluate(() => window.remoteDesktop.openLocalTerminal('/')), /尚未连接/);
  // Capture only the Windows terminal launch. Real bridge, SSH PTY and logs run
  // below; tests never steal focus or type into a user's native console.
  await application.evaluate(() => {
    const childProcess = process.getBuiltinModule('child_process'), { EventEmitter } = process.getBuiltinModule('events');
    globalThis.originalSpawn = childProcess.spawn;
    childProcess.spawn = (...args) => {
      if (!args[1]?.includes('-EncodedCommand')) return globalThis.originalSpawn(...args);
      globalThis.localTerminalLaunch = { command: args[0], args: args[1], options: { detached: args[2].detached, windowsHide: args[2].windowsHide } };
      const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 0)); return child;
    };
  });
  await page.locator('#switchAccountButton').click(); await page.locator('#sshHost').fill(fixture.config.host);
  await page.locator('#sshPort').fill(String(fixture.config.port)); await page.locator('#sshUsername').fill(fixture.username); await page.locator('#sshPassword').fill(fixture.password);
  await page.locator('#advancedConnectSubmit').click(); await page.locator('#connectionDialog').waitFor({ state: 'hidden' });
  const authCount = fixture.calls.auth.length;
  await page.locator('#favoriteApps [data-favorite=terminal]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '打开本机终端', exact: true }).click();
  const launch = await application.evaluate(() => globalThis.localTerminalLaunch);
  assert.ok(launch); assert.equal(launch.options.windowsHide, true);
  const launcher = Buffer.from(launch.args.at(-1), 'base64').toString('utf16le');
  assert.match(launcher, /-WindowStyle Normal/);
  const script = Buffer.from(launcher.match(/'-EncodedCommand', '([A-Za-z0-9+/=]+)'/)[1], 'base64').toString('utf16le');
  const entry = (await listInstances(userData))[0];
  assert.ok(script.includes(entry.instanceId)); assert.ok(script.includes('"shell"')); assert.ok(!script.includes(entry.token)); assert.ok(!script.includes(fixture.password));
  const settings = await page.evaluate(() => window.remoteDesktop.getSettings());
  await assert.rejects(requestInstance(entry, 'shell', { identity: 'stale-identity' }), /SSH 连接已改变/);
  let output = '', send;
  const pending = requestInstance(entry, 'shell', { cwd: fixture.home, identity: settings.workspaceIdentity, cols: 100, rows: 32 }, {
    timeoutMs: 20000, onReady: write => { send = write; write({ type: 'input', data: 'echo native-forward-test\r' }); },
    onProgress: value => { if (value.kind === 'stdout') output += value.data; }
  });
  await eventually(() => output.includes('fixture-echo:echo native-forward-test'));
  send({ type: 'close' }); await pending;
  await page.waitForFunction(async () => (await window.remoteDesktop.getActivitySnapshot()).entries.some(entry => entry.type === 'terminal-input' && entry.data?.includes('native-forward-test')));
  const snapshot = await page.evaluate(() => window.remoteDesktop.getActivitySnapshot());
  const input = snapshot.entries.find(entry => entry.type === 'terminal-input' && entry.data?.includes('native-forward-test'));
  assert.notEqual(input.scope, 'system'); const session = snapshot.sessions.find(session => session.id === input.sessionId); assert.ok(session?.logPath);
  assert.equal(fixture.calls.auth.length, authCount);
  await page.evaluate(() => window.remoteDesktop.disconnect());
  const log = await fs.readFile(fixture.mapPath(session.logPath), 'utf8'); assert.match(log, /native-forward-test/); assert.match(log, /fixture-echo/);
  const system = await fs.readFile(fixture.mapPath(snapshot.systemLogPath), 'utf8'); assert.ok(!system.includes('native-forward-test')); assert.ok(system.includes(session.logPath));
});
async function eventually(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.ok(predicate());
}
