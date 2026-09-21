'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
let browser, server, origin;
before(async () => {
  server = http.createServer((req, res) => {
    const file = req.url.split('?')[0];
    if (!/^\/(app|media)\/[\w./-]+$/.test(file) || file.includes('..')) return res.writeHead(404).end();
    const target = path.join(root, file);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return res.writeHead(404).end();
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });
async function scenario(t) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(7000);
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.addInitScript(() => {
    const profile = { id: 'fixture', host: '192.0.2.1', port: 22, username: 'tester', alias: 'Test Server' };
    window.settings = { downloadThreshold: 52428800, scriptEditor: 'monaco', serverProfiles: [profile], selectedServerId: profile.id, workspaceIdentity: 'fixture', workspacePreferences: {}, programPreferences: { favorites: ['settings', 'terminal'], usage: {} }, contextMenuPreferences: JSON.parse(localStorage.getItem('menu') || '{}') };
    window.localTerminalCalls = [];
    window.entries = [{ name: 'report.txt', path: '/home/tester/Desktop/report.txt', type: 'file' }, { name: 'project', path: '/home/tester/Desktop/project', type: 'folder' }];
    window.remoteDesktop = {
      onMessage(callback) { window.receive = callback; }, onBrowserEvent() {}, onActivityEvent() {}, onDownloadProgress() {},
      async getActivitySnapshot() { return { sessions: [], entries: [], connected: true }; },
      async getSettings() { return structuredClone(window.settings); },
      async listTransfers() { return []; }, async listDocuments() { return []; },
      async openLocalTerminal(cwd) { if (window.failLocalTerminal) throw new Error('Host terminal unavailable'); window.localTerminalCalls.push(cwd); return { opened: true }; },
      async saveContextMenuPreferences(value) { window.settings.contextMenuPreferences = value; localStorage.setItem('menu', JSON.stringify(value)); return structuredClone(window.settings); },
      async connect() { window.receive({ type: 'connectionInfo', profile: { ...profile, address: profile.host } }); window.receive({ type: 'remoteState', status: 'ready', rootPath: '/home/tester/Desktop', homePath: '/home/tester', entries: window.entries, config: { viewMode: 'details', pinnedApps: [{ id: 'legacy-shell', label: 'RTerminal', program: 'shell' }] } }); return profile; },
      send(message) { if (message.type === 'readDirectory') queueMicrotask(() => window.receive({ type: 'remoteDirectory', path: message.path, requestId: message.requestId, entries: window.entries })); },
      async updateProgramPreferences() { return window.settings.programPreferences; }
    };
  });
  await page.goto(origin + '/app/index.html');
  await page.locator('#sshPassword').fill('test'); await page.locator('#connectSubmit').click();
  await page.locator('#connectionDialog').waitFor({ state: 'hidden' });
  return page;
}
test('menus adapt to selected files, persist checkbox choices, and restore defaults', async t => {
  const page = await scenario(t);
  const visible = () => page.locator('#context [data-action]:visible').evaluateAll(nodes => nodes.map(node => node.dataset.action));
  await page.locator('#desktop').click({ button: 'right', position: { x: 900, y: 660 } });
  assert.deepEqual(await visible(), ['new-file', 'new-folder', 'terminal', 'local-terminal', 'refresh', 'arrange']);
  await page.locator('#desktop .icon').filter({ hasText: 'report.txt' }).click({ button: 'right' });
  assert.deepEqual(await visible(), ['open', 'workbench', 'rename', 'cut', 'copy', 'delete', 'shortcut', 'download', 'compress']);
  await page.keyboard.press('Escape'); await page.locator('#desktopSettings').click(); await page.locator('#contextMenuSettingsTab').click();
  await page.locator('#menu-delete').uncheck(); await page.locator('#menu-refresh').uncheck(); await page.locator('#menu-local-terminal').uncheck();
  await page.locator('#contextMenuPreferencesForm button[type=submit]').click();
  await page.waitForFunction(() => window.settings.contextMenuPreferences.hidden.includes('delete'));
  await page.screenshot({ path: path.join(root, 'artifacts', 'context-menu-settings-1.1.13.png') });
  await page.locator('#closeSettings').click();
  await page.locator('#desktop .icon').filter({ hasText: 'report.txt' }).click({ button: 'right' });
  assert.ok(!(await visible()).includes('delete'));
  await page.locator('#desktop').click({ button: 'right', position: { x: 900, y: 660 } });
  assert.ok(!(await visible()).includes('local-terminal'));
  await page.reload(); await page.locator('#sshPassword').fill('test'); await page.locator('#connectSubmit').click(); await page.locator('#connectionDialog').waitFor({ state: 'hidden' });
  await page.locator('#desktopSettings').click(); await page.locator('#contextMenuSettingsTab').click();
  assert.equal(await page.locator('#menu-delete').isChecked(), false);
  await page.locator('#resetContextMenu').click(); await page.locator('#contextMenuPreferencesForm button[type=submit]').click();
  await page.waitForFunction(() => window.settings.contextMenuPreferences.hidden.length === 0);
});
test('program names are English and only the non-button address hit area highlights', async t => {
  const page = await scenario(t);
  assert.equal(await page.locator('#dock').getAttribute('title'), null);
  await page.locator('#applicationsButton').click();
  assert.deepEqual(await page.locator('.application-label').allTextContents(), ['Browser', 'Transfer Center', 'Activity Monitor', 'htop', 'Monaco Editor', 'Image Viewer', 'Video Player', 'Home', 'Settings', 'RTerminal']);
  await page.locator('#closeApplications').click(); await page.locator('#homeShortcut').click();
  const box = page.locator('.explorer-window .address-box'), button = box.locator('[data-breadcrumb-path]').last();
  await button.hover(); const buttonBorder = await box.evaluate(node => getComputedStyle(node).borderColor);
  const bounds = await box.boundingBox(); await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
  const hitBorder = await box.evaluate(node => getComputedStyle(node).borderColor);
  assert.notEqual(hitBorder, buttonBorder); assert.equal(await box.evaluate(node => getComputedStyle(node).cursor), 'text');
  await page.screenshot({ path: path.join(root, 'artifacts', 'explorer-address-hover-1.1.13.png') });
});
test('local terminal menus forward the correct directory without opening a virtual terminal and handle errors', async t => {
  const page = await scenario(t);
  await page.locator('#favoriteApps [data-favorite=terminal]').click({ button: 'right' });
  await page.locator('#programLocalTerminal').click();
  assert.deepEqual(await page.evaluate(() => window.localTerminalCalls), ['/home/tester']);
  assert.equal(await page.locator('.terminal-window').count(), 0);
  await page.locator('#favoriteApps [data-favorite=terminal]').focus(); await page.keyboard.press('Shift+F10'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.localTerminalCalls.length), 2);
  await page.locator('#pinnedApps [data-app-id=legacy-shell]').click({ button: 'right' });
  await page.locator('#appLocalTerminal').click();
  assert.equal(await page.evaluate(() => window.localTerminalCalls.at(-1)), '/home/tester');
  await page.locator('#homeShortcut').click();
  await page.locator('.explorer-window .listing').click({ button: 'right', position: { x: 350, y: 300 } });
  await page.locator('#context [data-action=local-terminal]').click();
  assert.equal(await page.evaluate(() => window.localTerminalCalls.at(-1)), '/home/tester');
  await page.locator('.explorer-window .listing').click({ button: 'right', position: { x: 350, y: 300 } });
  await page.locator('#context [data-action=terminal]').click();
  await page.locator('.terminal-window').waitFor();
  await page.locator('#windowTabs .window-tab[title^="RTerminal"]').click({ button: 'right' });
  await page.locator('#appLocalTerminal').click();
  assert.equal(await page.evaluate(() => window.localTerminalCalls.at(-1)), '/home/tester');
  assert.equal(await page.locator('.terminal-window').count(), 1);
  await page.locator('#desktop').click({ button: 'right', position: { x: 1200, y: 780 } });
  await page.locator('#context [data-action=local-terminal]').click();
  assert.equal(await page.evaluate(() => window.localTerminalCalls.at(-1)), '/home/tester/Desktop');
  await page.evaluate(() => { window.failLocalTerminal = true; });
  await page.locator('#favoriteApps [data-favorite=settings]').click({ button: 'right' });
  await page.screenshot({ path: path.join(root, 'artifacts', 'local-terminal-menu-1.1.13.png') });
  await page.locator('#programLocalTerminal').click();
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('Host terminal unavailable'));
  await page.evaluate(() => window.receive({ type: 'remoteState', status: 'disconnected' }));
  await page.locator('#favoriteApps [data-favorite=terminal]').click({ button: 'right', force: true });
  assert.equal(await page.locator('#programLocalTerminal').isDisabled(), true);
});
