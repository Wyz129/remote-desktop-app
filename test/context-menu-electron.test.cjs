'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const project = path.resolve(__dirname, '..');
test('context menu preferences persist through real IPC and reject unsupported actions', { timeout: 45000 }, async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'rdesktop-context-menu-'));
  let application;
  t.after(async () => { await application?.close(); await fs.rm(userData, { recursive: true, force: true }); });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.REMOTE_DESKTOP_TEST_EXE;
  const launch = async () => {
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [project]), '--smoke-test', `--user-data-dir=${userData}`], env });
    const page = await application.firstWindow(); await page.locator('#switchAccountButton:not([disabled])').waitFor(); return page;
  };
  let page = await launch();
  const saved = await page.evaluate(() => window.remoteDesktop.saveContextMenuPreferences({ hidden: ['delete', 'refresh'] }));
  assert.deepEqual(saved.contextMenuPreferences, { hidden: ['delete', 'refresh'] });
  const settingsPath = path.join(userData, 'settings.json'), original = await fs.readFile(settingsPath, 'utf8');
  await assert.rejects(page.evaluate(() => window.remoteDesktop.saveContextMenuPreferences({ hidden: ['exec'] })), /内建/);
  assert.equal(await fs.readFile(settingsPath, 'utf8'), original);
  await application.close(); application = null; page = await launch();
  assert.deepEqual((await page.evaluate(() => window.remoteDesktop.getSettings())).contextMenuPreferences, { hidden: ['delete', 'refresh'] });
});
