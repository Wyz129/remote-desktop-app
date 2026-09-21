'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const project = path.resolve(__dirname, '..');

test('program favorites and usage persist across isolated Electron restarts without SSH', { timeout: 90000 }, async t => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const userData = await fs.mkdtemp(path.join(temporaryRoot, 'remote-desktop-programs-test-'));
  const settingsPath = path.join(userData, 'settings.json');
  const initial = {
    downloadThreshold: 1048576, storageVersion: 2,
    host: '192.0.2.20', port: 2222, username: 'programs-test', alias: '离线测试服务器',
    knownHosts: { '192.0.2.20:2222': 'SHA256:isolated-test-fingerprint' },
    serverProfiles: [{ id: 'offline-profile', host: '192.0.2.20', port: 2222, username: 'programs-test', alias: '离线测试服务器', aliasAuto: false, privateKeyPath: '' }],
    selectedServerId: 'offline-profile'
  };
  await fs.writeFile(settingsPath, JSON.stringify(initial));
  let application;
  const closeApplication = async () => {
    if (!application || application.process().exitCode !== null) return;
    const isolatedProcess = application.process();
    const timer = setTimeout(() => {
      // Only terminate the process launched by this test, never a process found by name.
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(isolatedProcess.pid), '/T', '/F'], { windowsHide: true });
      else isolatedProcess.kill('SIGKILL');
    }, 5000);
    try { await application.close(); } finally { clearTimeout(timer); }
  };
  t.after(async () => {
    await closeApplication();
    const resolved = path.resolve(userData);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith('remote-desktop-programs-test-'));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.REMOTE_DESKTOP_TEST_EXE;
  const errors = [];
  const launch = async () => {
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [project]), '--smoke-test', `--user-data-dir=${userData}`], env });
    const page = await application.firstWindow(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#connectionDialog[open]').waitFor();
    await page.locator('#closeConnection').click();
    await page.locator('#connectionDialog').waitFor({ state: 'hidden' });
    return page;
  };
  const persisted = async () => JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  const withoutPrograms = ({ programPreferences, ...rest }) => rest;
  let page = await launch();
  const originalPublic = await page.evaluate(() => window.remoteDesktop.getSettings());
  assert.deepEqual(originalPublic.programPreferences, { favorites: [], usage: {} });
  assert.equal(await page.locator('#favoriteApps [data-favorite]').count(), 0);

  await page.evaluate(() => { window.preferenceEvents = []; window.remoteDesktop.onMessage(message => { if (message.type === 'programPreferences') window.preferenceEvents.push(message.preferences); }); });
  await page.locator('#applicationsButton').click();
  assert.equal(await page.locator('#applicationsGrid [data-application]').count(), 10);
  for (const id of ['browser', 'settings']) {
    // Browser is unavailable while offline, but its context menu must still work.
    const tile = page.locator(`#applicationsGrid [data-application=${id}]`);
    const bounds = await tile.boundingBox(); assert.ok(bounds);
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { button: 'right' });
    await page.locator('#programContext').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#toggleFavorite').textContent(), '添加到收藏夹');
    await page.locator('#toggleFavorite').click();
    await page.locator(`#favoriteApps [data-favorite=${id}]`).waitFor();
  }
  assert.deepEqual((await persisted()).programPreferences, { favorites: ['browser', 'settings'], usage: {} });
  assert.deepEqual(await page.evaluate(() => window.preferenceEvents.at(-1)), { favorites: ['browser', 'settings'], usage: {} });
  await page.locator('#closeApplications').click();
  await page.locator('#favoriteApps [data-favorite=settings]').click();
  await page.locator('#settingsDialog').waitFor({ state: 'visible' });
  await page.waitForFunction(async () => (await window.remoteDesktop.getSettings()).programPreferences.usage.settings === 1);
  assert.deepEqual((await persisted()).programPreferences, { favorites: ['browser', 'settings'], usage: { settings: 1 } });
  assert.deepEqual(withoutPrograms(await page.evaluate(() => window.remoteDesktop.getSettings())), withoutPrograms(originalPublic));
  const diskBeforeInvalid = await fs.readFile(settingsPath, 'utf8');
  for (const [action, id] of [['replace', 'browser'], ['add', 'unknown'], ['launch', '__proto__']]) {
    await assert.rejects(page.evaluate(([nextAction, nextId]) => window.remoteDesktop.updateProgramPreferences(nextAction, nextId), [action, id]), /操作无效|标识无效/);
  }
  assert.equal(await fs.readFile(settingsPath, 'utf8'), diskBeforeInvalid, 'invalid IPC requests must not change disk settings');
  await page.locator('#closeSettings').click();
  await closeApplication();

  page = await launch();
  await page.locator('#favoriteApps [data-favorite=settings]').waitFor();
  assert.deepEqual(await page.locator('#favoriteApps [data-favorite]').evaluateAll(buttons => buttons.map(button => button.dataset.favorite)), ['browser', 'settings']);
  await page.locator('#applicationsButton').click();
  await page.locator('#frequentApplications').click();
  assert.deepEqual(await page.locator('#applicationsGrid [data-application]:visible').evaluateAll(buttons => buttons.map(button => button.dataset.application)), ['settings']);
  await page.locator('#allApplications').click();
  assert.equal(await page.locator('#applicationsGrid [data-application]:visible').count(), 10);
  await fs.mkdir(path.join(project, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(project, 'artifacts', executablePath ? 'packaged-programs.png' : 'electron-programs.png') });
  await page.locator('#applicationsGrid [data-application=settings]').click({ button: 'right' });
  assert.equal(await page.locator('#toggleFavorite').textContent(), '从收藏夹移除');
  await page.locator('#toggleFavorite').click();
  await page.locator('#favoriteApps [data-favorite=settings]').waitFor({ state: 'detached' });
  assert.deepEqual((await persisted()).programPreferences, { favorites: ['browser'], usage: { settings: 1 } });
  await page.locator('#frequentApplications').click();
  assert.equal(await page.locator('#applicationsGrid [data-application=settings]').isVisible(), true, 'removing a favorite preserves launch history');
  assert.deepEqual(withoutPrograms(await page.evaluate(() => window.remoteDesktop.getSettings())), withoutPrograms(originalPublic));
  const saved = await persisted();
  for (const key of ['host', 'port', 'username', 'alias', 'knownHosts', 'serverProfiles', 'selectedServerId', 'downloadThreshold']) assert.deepEqual(saved[key], initial[key], key);
  assert.deepEqual(errors, []);
});
