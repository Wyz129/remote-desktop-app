'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { listInstances, defaultUserDataDir } = require('../lib/instance-bridge.cjs');
const project = path.resolve(__dirname, '..');

test('CLI default matches GUI app identity and launcher discovers an isolated Windows instance', { timeout: 90000, skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdesktop-cli-default-test-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.REMOTE_DESKTOP_TEST_EXE;
  let application;
  const close = async () => {
    if (!application || application.process().exitCode !== null) return;
    const processId = application.process().pid;
    const timer = setTimeout(() => spawnSync('taskkill', ['/pid', String(processId), '/T', '/F'], { windowsHide: true }), 5000);
    try { await application.close(); } finally { clearTimeout(timer); application = null; }
  };
  t.after(async () => {
    await close();
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('rdesktop-cli-default-test-')) throw new Error('Unsafe cleanup');
    await fs.rm(root, { recursive: true, force: true });
  });
  // Electron obtains Windows appData through a system API and ignores an
  // APPDATA override. Always use explicit isolated userData; derive its default
  // from real application metadata instead of opening the user's configuration.
  const userData = path.join(root, 'isolated');
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [project]), '--smoke-test', `--user-data-dir=${userData}`], env });
  await application.firstWindow();
  const probe = await application.evaluate(({ app }) => ({ name: app.getName(), appData: app.getPath('appData'), userData: app.getPath('userData') }));
  assert.equal(probe.name, 'remote-desktop-app', 'GUI app name must match CLI defaultUserDataDir');
  assert.equal(path.resolve(defaultUserDataDir()).toLowerCase(), path.join(probe.appData, probe.name).toLowerCase());
  assert.equal(path.resolve(probe.userData).toLowerCase(), userData.toLowerCase());
  let instances = [];
  for (let attempt = 0; attempt < 50 && !instances.length; attempt++) { instances = await listInstances(userData); if (!instances.length) await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(instances.length, 1);
  const launcher = executablePath ? path.join(path.dirname(executablePath), 'resources/cli/scripts/rdesktop.cmd') : path.join(project, 'scripts/rdesktop.cmd');
  const result = await new Promise((resolve, reject) => {
    const cliEnv = { ...env };
    // A packaged launcher must work when a separate node.exe cannot be found.
    if (executablePath) cliEnv.PATH = [path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(path.delimiter);
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${launcher}" --user-data-dir "${userData}" status"`], { windowsHide: true, windowsVerbatimArguments: true, env: cliEnv });
    let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).connected, false);
});
