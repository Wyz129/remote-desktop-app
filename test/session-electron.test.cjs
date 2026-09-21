'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');
const project = path.resolve(__dirname, '..');

test('real SSH login derives automatic aliases and changing port reauthenticates with the selected endpoint', { timeout: 120000 }, async t => {
  const first = await createSshFixture({ desktop: false }), second = await createSshFixture({ desktop: false });
  let application;
  t.after(async () => {
    if (application && application.process().exitCode === null) {
      const timer = setTimeout(() => spawnSync('taskkill', ['/pid', String(application.process().pid), '/T', '/F'], { windowsHide: true }), 5000);
      try { await application.close(); } finally { clearTimeout(timer); }
    }
    await first.close(); await second.close();
  });
  const userData = path.join(first.root, 'session-app'); await fs.mkdir(userData);
  const settingsPath = path.join(userData, 'settings.json');
  await fs.writeFile(settingsPath, JSON.stringify({ knownHosts: {
    [`${first.config.host}:${first.config.port}`]: first.fingerprint,
    [`${second.config.host}:${second.config.port}`]: second.fingerprint
  } }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.REMOTE_DESKTOP_TEST_EXE;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [project]), '--smoke-test', `--user-data-dir=${userData}`], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('#switchAccountButton:not([disabled])').waitFor();
  assert.equal(await page.locator('#connectionDialog input:visible').count(), 0);
  await page.locator('#switchAccountButton').click();
  await page.locator('#sshHost').fill(first.config.host); await page.locator('#sshPort').fill(String(first.config.port));
  await page.locator('#sshUsername').fill(first.config.username); await page.locator('#sshPassword').fill(first.config.password);
  await page.locator('#advancedConnectSubmit').click(); await page.locator('#connectionDialog').waitFor({ state: 'hidden' });
  const saved = await page.evaluate(() => window.remoteDesktop.getSettings());
  const profile = saved.serverProfiles.find(item => item.id === saved.selectedServerId);
  assert.equal(profile.alias, 'Ubuntu 24.04 LTS (fixture) User'); assert.equal(profile.aliasAuto, true);
  assert.equal(profile.password, undefined); assert.equal(profile.passphrase, undefined);
  assert.match(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), /Ubuntu 24.04 LTS \(fixture\) User$/);
  assert.equal(await page.locator('#connection').textContent(), first.config.username);
  assert.equal(await page.locator('#connectionIndicator.connected').count(), 1);
  await page.waitForFunction(() => Boolean(document.getElementById('serverClock').getAttribute('datetime')));
  const clockQueries = () => first.calls.exec.filter(command => command.startsWith('# remote-desktop-server-clock-v1\n')).length;
  assert.equal(clockQueries(), 1);
  await page.evaluate(() => new Promise(resolve => {
    let replies = 0;
    const unsubscribe = window.remoteDesktop.onMessage(value => { if (value.type === 'serverInfo' && ++replies === 2) { unsubscribe(); resolve(); } });
    window.remoteDesktop.send({ type: 'getServerInfo' });
    window.remoteDesktop.send({ type: 'getServerInfo' });
  }));
  assert.equal(clockQueries(), 1, 'repeated clock reads reuse the initial connection calibration');
  const before = await fs.readFile(settingsPath, 'utf8');
  await assert.rejects(page.evaluate(([port, identity]) => window.remoteDesktop.saveConnectionPort(port, identity), [second.config.port, 'wrong']), /连接已改变/);
  await assert.rejects(page.evaluate(identity => window.remoteDesktop.saveConnectionPort(65536, identity), saved.workspaceIdentity), /端口/);
  await assert.rejects(page.evaluate(identity => window.remoteDesktop.saveConnectionPort(undefined, identity), saved.workspaceIdentity), /端口/);
  assert.equal(await fs.readFile(settingsPath, 'utf8'), before);
  await page.locator('#desktopSettings').click(); await page.locator('#connectionSettingsTab').click();
  await page.locator('#settingsConnectionPort').fill(String(second.config.port)); await page.locator('#saveConnectionPort').click();
  await page.locator('#connectionDialog[data-mode="reconnect"]').waitFor();
  assert.equal(await page.locator('#sshPassword').inputValue(), '');
  assert.equal(await page.locator('#sshPort').inputValue(), String(second.config.port));
  assert.equal(second.calls.auth.length, 0, 'the next server is not contacted before its password is supplied');
  assert.equal((await page.evaluate(() => window.remoteDesktop.getSettings())).workspaceIdentity, saved.workspaceIdentity, 'the active session remains usable until reauthentication');
  await page.locator('#sshPassword').fill(second.config.password); await page.locator('#connectSubmit').click();
  await page.locator('#connectionDialog').waitFor({ state: 'hidden' });
  const changed = await page.evaluate(() => window.remoteDesktop.getSettings());
  assert.notEqual(changed.workspaceIdentity, saved.workspaceIdentity);
  assert.equal(changed.selectedServerId, saved.selectedServerId);
  assert.equal(changed.serverProfiles.find(item => item.id === changed.selectedServerId).port, second.config.port);
  const disk = await fs.readFile(settingsPath, 'utf8');
  assert.ok(!disk.includes(first.config.password) && !disk.includes(second.config.password));
  await page.locator('#connectButton').click();
  assert.equal(await page.locator('#connectedAddress').textContent(), `${second.config.username}@${second.config.host}:${second.config.port}`);
  assert.equal(await page.locator('#connectionDialog input:visible').count(), 0);
  await page.locator('#closeConnection').click();
  await page.evaluate(input => window.remoteDesktop.connect(input), { ...second.config, profileId: changed.selectedServerId, alias: 'My Cluster', aliasAuto: false });
  const manual = await page.evaluate(() => window.remoteDesktop.getSettings());
  assert.equal(manual.serverProfiles.find(item => item.id === manual.selectedServerId).alias, 'My Cluster');
  assert.equal(manual.serverProfiles.find(item => item.id === manual.selectedServerId).aliasAuto, false);
  assert.match(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), /My Cluster$/);
  assert.deepEqual(errors, []);
});
