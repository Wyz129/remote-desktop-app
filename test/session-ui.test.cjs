'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const project = path.resolve(__dirname, '..');
let browser, server, origin;
before(async () => {
  server = http.createServer((req, res) => {
    const file = req.url.split('?')[0];
    if (!/^\/(app|media)\/[\w./-]+$/.test(file) || file.includes('..')) return res.writeHead(404).end();
    const target = path.join(project, file);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return res.writeHead(404).end();
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });
async function scenario(t, saved = false) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(6000);
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.addInitScript(savedProfile => {
    const profile = { id: 'saved-server', host: '192.0.2.10', port: 2222, username: 'tester', alias: 'Ubuntu 24.04 User', aliasAuto: true, privateKeyPath: '' };
    window.calls = [];
    window.settings = { downloadThreshold: 52428800, scriptEditor: 'monaco', serverProfiles: savedProfile ? [profile] : [], selectedServerId: savedProfile ? profile.id : '', workspaceIdentity: 'fixture-identity', workspacePreferences: {}, shellPreferences: {}, programPreferences: { favorites: [], usage: {} } };
    const saveProfile = input => {
      const next = { ...input, id: input.id || 'new-server', alias: input.alias || 'Unknown Server', aliasAuto: !input.alias || input.aliasAuto === true };
      delete next.password; delete next.passphrase; delete next.profileId;
      window.settings.serverProfiles = [next]; window.settings.selectedServerId = next.id; return next;
    };
    window.remoteDesktop = {
      onMessage(callback) { window.receive = callback; }, onBrowserEvent() {}, onActivityEvent() {}, onDownloadProgress() {},
      async getActivitySnapshot() { return { sessions: [], entries: [], connected: false }; },
      async getSettings() { return structuredClone(window.settings); },
      async saveServer(input) { window.calls.push({ type: 'save', input }); saveProfile(input); return structuredClone(window.settings); },
      async saveConnectionPort(port, identity) {
        window.calls.push({ type: 'savePort', port, identity });
        if (window.failPort) throw new Error('连接已改变，请重新打开设置。');
        const next = saveProfile({ ...window.settings.serverProfiles[0], port });
        return { settings: structuredClone(window.settings), profile: next };
      },
      async connect(input) {
        window.calls.push({ type: 'connect', input }); const current = saveProfile(input);
        window.receive({ type: 'connectionInfo', profile: { ...current, address: current.host } });
        window.receive({ type: 'remoteState', status: 'ready', rootPath: '/home/tester/.rdesktop/desktop', homePath: '/home/tester', entries: [], config: { viewMode: 'details' } });
        return current;
      },
      async disconnect() { window.receive({ type: 'remoteState', status: 'disconnected' }); },
      async quit() { window.calls.push({ type: 'quit' }); }, async choosePrivateKey() { return 'C:\\keys\\id'; },
      async listTransfers() { return []; }, async listDocuments() { return []; },
      send(message) { window.calls.push({ type: 'message', message }); }
    };
  }, saved);
  await page.goto(origin + '/app/index.html');
  await page.locator('#switchAccountButton:not([disabled])').waitFor(); return page;
}
test('empty login hides credentials and saving a new server creates the automatic alias without secrets', async t => {
  const page = await scenario(t);
  assert.equal(await page.locator('#connectionDialog input:visible').count(), 0);
  assert.equal(await page.locator('.login-avatar svg ellipse').count(), 1);
  await page.locator('#switchAccountButton').click();
  const fields = await page.locator('#connectionAdvanced input').evaluateAll(nodes => nodes.map(node => node.id));
  assert.ok(fields.indexOf('sshAlias') < fields.indexOf('sshHost'));
  await page.locator('#sshHost').fill('192.0.2.20'); await page.locator('#sshUsername').fill('test-user'); await page.locator('#sshPassword').fill('memory-only');
  await page.locator('#saveServer').click();
  await page.waitForFunction(() => document.getElementById('connectionDialog').dataset.mode === 'login');
  assert.equal(await page.locator('#connectionDialog input:visible').count(), 2);
  assert.equal(await page.locator('#serverDisplayName').textContent(), 'Unknown Server');
  assert.equal(await page.locator('#sshPassword').inputValue(), '');
  assert.equal(await page.evaluate(() => window.settings.serverProfiles[0].password), undefined);
  assert.equal(await page.evaluate(() => window.settings.serverProfiles[0].aliasAuto), true);
  await page.screenshot({ path: path.join(project, 'artifacts', 'session-login-1.1.12.png') });
});
test('connected account card contains only alias and endpoint, with inline reconnect and safe exit actions', async t => {
  const page = await scenario(t, true);
  await page.locator('#sshPassword').fill('memory-only'); await page.locator('#connectSubmit').click();
  await page.locator('#connectionDialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#connection').textContent(), 'tester');
  assert.equal(await page.locator('#connectionIndicator.connected').count(), 1);
  const fonts = await page.evaluate(() => [getComputedStyle(document.getElementById('connection')).font, getComputedStyle(document.getElementById('serverClock')).font]);
  assert.equal(fonts[0], fonts[1]);
  await page.locator('#connectButton').click();
  assert.equal(await page.locator('#connectionDialog input:visible').count(), 0);
  assert.equal(await page.locator('#connectedAddress').textContent(), 'tester@192.0.2.10:2222');
  assert.equal(await page.locator('#connectionDialog #disconnectButton').count(), 0);
  assert.equal(await page.locator('#serverDisplayAddress').isVisible(), false);
  assert.equal(await page.locator('.server-name-row #reconnectButton').isVisible(), true);
  assert.deepEqual(await page.locator('.server-name-row').locator('button:visible').evaluateAll(buttons => buttons.map(button => button.id)), ['reconnectButton', 'connectionExitButton']);
  await page.screenshot({ path: path.join(project, 'artifacts', 'session-connected-1.1.12.png') });
  await page.locator('#reconnectButton').click();
  assert.equal(await page.locator('#sshPassword').inputValue(), '');
  assert.equal(await page.locator('#sshUsername').getAttribute('readonly'), '');
  await page.locator('#closeConnection').click(); await page.locator('#connectButton').click();
  await page.locator('#connectionExitButton').click();
  assert.equal(await page.evaluate(() => window.calls.some(call => call.type === 'quit')), true);
  await page.evaluate(() => window.remoteDesktop.disconnect());
  assert.equal(await page.locator('#connectionIndicator.connected').count(), 0);
  assert.equal(await page.locator('#connection').textContent(), 'tester');
});
test('connection settings validate the port and begin reauthentication without reusing a password', async t => {
  const page = await scenario(t, true);
  await page.locator('#sshPassword').fill('memory-only'); await page.locator('#connectSubmit').click();
  await page.locator('#connectionDialog').waitFor({ state: 'hidden' });
  await page.locator('#desktopSettings').click(); await page.locator('#connectionSettingsTab').click();
  await page.locator('#settingsConnectionPort').fill('65536'); await page.locator('#saveConnectionPort').click();
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.type === 'savePort').length), 0);
  await page.locator('#settingsConnectionPort').fill('2200');
  await page.evaluate(() => { window.failPort = true; }); await page.locator('#saveConnectionPort').click();
  await page.locator('#connectionPortError').filter({ hasText: '连接已改变' }).waitFor();
  assert.equal(await page.locator('#settingsDialog').isVisible(), true);
  await page.evaluate(() => { window.failPort = false; }); await page.locator('#saveConnectionPort').click();
  await page.waitForFunction(() => document.getElementById('connectionDialog').dataset.mode === 'reconnect');
  assert.equal(await page.locator('#sshPort').inputValue(), '2200');
  assert.equal(await page.locator('#sshPassword').inputValue(), '');
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.type === 'connect').length), 1);
  await page.locator('#sshPassword').fill('new-memory-only'); await page.locator('#connectSubmit').click();
  await page.locator('#connectionDialog').waitFor({ state: 'hidden' });
  const last = await page.evaluate(() => window.calls.filter(call => call.type === 'connect').at(-1));
  assert.equal(last.input.port, 2200); assert.equal(last.input.password, 'new-memory-only');
});
