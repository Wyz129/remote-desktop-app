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
async function scenario(t) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(6000);
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.addInitScript(() => {
    window.calls = []; window.settings = { downloadThreshold: 52428800, downloadsPath: 'C:\\Downloads', defaultUploadDirectory: '/home/tester/.rdesktop/download', workspaceIdentity: 'fixture-A', workspacePreferences: {}, programPreferences: { favorites: [], usage: {} } };
    window.remoteDesktop = {
      onMessage(callback) { window.receive = callback; }, onBrowserEvent(callback) { window.browserEvent = callback; }, onActivityEvent() {}, onDownloadProgress(callback) { window.progress = callback; },
      async getActivitySnapshot() { return { sessions: [], entries: [], connected: false }; },
      async getSettings() { return structuredClone(window.settings); }, async listTransfers() { return []; }, async listDocuments() { return []; },
      async saveSettings(patch) { window.calls.push({ type: 'save', patch }); if (window.saveFailure) throw new Error('Permission denied'); Object.assign(window.settings, patch); return structuredClone(window.settings); },
      async chooseDefaultDownloadDirectory() { window.calls.push({ type: 'browseLocal' }); return window.deferLocal ? new Promise(resolve => { window.resolveLocal = resolve; }) : 'D:\\Saved'; },
      async chooseDownloadDirectory() { window.calls.push({ type: 'chooseDownload' }); return window.settings.defaultDownloadDirectory || window.settings.downloadsPath; },
      async acceptDroppedFiles(files) { return files.map(file => 'C:\\Input\\' + file.name); },
      async upload(localPath, remoteDirectory, id) { window.calls.push({ type: 'upload', localPath, remoteDirectory }); return { id, path: remoteDirectory + '/code.py', total: 5, done: 5 }; },
      async download(remotePath, id, destination) { window.calls.push({ type: 'download', remotePath, destination }); return { id, path: destination + '\\data.txt', total: 5, done: 5 }; },
      async list(target) { if (target === '/denied') throw new Error('Permission denied'); return []; },
      async openBrowser() { return { id: 41, embedded: true }; },
      async layoutBrowser(id, bounds, hidden, snapshot) { window.calls.push({ type: 'browserLayout', bounds, hidden, snapshot }); },
      async clearTransferHistory() { return true; },
      send(message) { if (message.type === 'readDirectory') queueMicrotask(() => window.receive({ type: 'remoteDirectory', path: message.path, requestId: message.requestId, entries: [] })); }
    };
  });
  await page.goto(origin + '/app/index.html'); await page.locator('#switchAccountButton:not([disabled])').waitFor();
  await page.evaluate(() => {
    document.getElementById('connectionDialog').close();
    window.receive({ type: 'remoteState', status: 'ready', rootPath: '/home/tester/.rdesktop/desktop', homePath: '/home/tester', entries: [], config: {} });
    window.receive({ type: 'interfacePreferences', settings: window.settings });
  });
  await page.locator('#downloadsButton').click(); return page;
}

test('Transfer Center has one movable desktop window with shared minimize, maximize, restore and close lifecycle', async t => {
  const page = await scenario(t), win = page.locator('#windows #downloadsPanel');
  assert.equal(await win.locator('.window-title').textContent(), 'Transfer Center');
  assert.equal(await page.locator('#transferUpload, #transferDownload').count(), 0);
  await page.locator('#downloadsButton').click(); assert.equal(await page.locator('#windowTabs [data-window-id="transfer-window"]').count(), 1);
  const before = await win.boundingBox(); const title = await win.locator('.titlebar').boundingBox();
  await page.mouse.move(title.x + 35, title.y + 20); await page.mouse.down(); await page.mouse.move(title.x + 110, title.y + 65); await page.mouse.up();
  const moved = await win.boundingBox(); assert.ok(moved.x > before.x + 50 && moved.y > before.y + 20);
  const resize = await win.locator('[data-resize="se"]').boundingBox();
  await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2); await page.mouse.down(); await page.mouse.move(resize.x - 70, resize.y - 60); await page.mouse.up();
  assert.ok((await win.boundingBox()).width < moved.width - 50);
  await win.locator('[data-window-action="maximize"]').click();
  const maximum = await win.boundingBox(), desktop = await page.locator('#windows').boundingBox();
  assert.deepEqual(maximum, desktop); assert.equal(await win.evaluate(node => getComputedStyle(node).borderRadius), '0px');
  await win.locator('[data-window-action="maximize"]').click(); await win.locator('[data-window-action="minimize"]').click();
  assert.equal(await win.isVisible(), false); await page.locator('#windowTabs [data-window-id="transfer-window"]').click(); assert.equal(await win.isVisible(), true);
  await page.evaluate(() => window.progress({ id: 'running', source: '/tmp/source', status: 'running', total: 100, done: 1 }));
  await page.locator('#closeDownloads').click(); assert.equal(await page.locator('#windowTabs [data-window-id="transfer-window"]').count(), 0);
  await page.locator('#downloadsButton').click(); assert.equal(await win.locator('[data-download-id="running"]').isVisible(), true);
  await page.screenshot({ path: path.join(project, 'artifacts/transfer-window-1.1.13.png') });
});

test('editable directories browse real picker surfaces, save together and reject errors or stale selections', async t => {
  const page = await scenario(t);
  assert.equal(await page.locator('#transferServerDirectory').inputValue(), '/home/tester/.rdesktop/download');
  assert.equal(await page.locator('#transferLocalDirectory').inputValue(), 'C:\\Downloads');
  await page.locator('#browseTransferServerDirectory').click();
  const picker = page.locator('.server-picker-window'); await picker.locator('.window-picker-path').fill('/srv/uploads'); await picker.locator('[data-window-action="pick"]').click();
  assert.equal(await page.locator('#transferServerDirectory').inputValue(), '/srv/uploads');
  await page.locator('#browseTransferLocalDirectory').click(); assert.equal(await page.locator('#transferLocalDirectory').inputValue(), 'D:\\Saved');
  await page.locator('#saveTransferDirectories').click(); await page.locator('#transferDirectoryStatus').filter({ hasText: '目录已保存' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls.find(call => call.type === 'save').patch), { downloadThreshold: 52428800, defaultDownloadDirectory: 'D:\\Saved', defaultUploadDirectory: '/srv/uploads', workspaceIdentity: 'fixture-A' });
  await page.evaluate(() => { window.saveFailure = true; }); await page.locator('#transferServerDirectory').fill('/denied'); await page.locator('#saveTransferDirectories').click();
  await page.locator('#transferError').filter({ hasText: 'Permission denied' }).waitFor();
  assert.equal(await page.evaluate(() => window.settings.defaultUploadDirectory), '/srv/uploads');
  await page.evaluate(() => { window.deferLocal = true; }); await page.locator('#browseTransferLocalDirectory').click();
  await page.evaluate(() => { window.settings = { ...window.settings, workspaceIdentity: 'fixture-B', defaultUploadDirectory: '/other/download' }; window.receive({ type: 'interfacePreferences', settings: window.settings }); window.resolveLocal('Z:\\stale'); });
  assert.equal(await page.locator('#transferServerDirectory').inputValue(), '/other/download'); assert.equal(await page.locator('#transferLocalDirectory').inputValue(), 'D:\\Saved');
});

test('Transfer Center drag uploads use the server default and remote drops download locally with completed history', async t => {
  const page = await scenario(t);
  await page.evaluate(() => { const data = new DataTransfer(); data.items.add(new File(['print(1)'], 'code.py')); document.getElementById('downloadsPanel').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data })); });
  const picker = page.locator('.server-picker-window'); await picker.waitFor();
  assert.equal(await picker.locator('.window-picker-path').inputValue(), '/home/tester/.rdesktop/download');
  await picker.locator('[data-window-action="pick"]').click(); await page.waitForFunction(() => window.calls.some(call => call.type === 'upload'));
  assert.equal(await page.evaluate(() => window.calls.find(call => call.type === 'upload').remoteDirectory), '/home/tester/.rdesktop/download');
  await page.evaluate(() => { const data = new DataTransfer(); data.setData('application/x-remote-desktop', JSON.stringify({ paths: ['/srv/data.txt'] })); document.getElementById('downloadsPanel').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data })); });
  await page.waitForFunction(() => window.calls.some(call => call.type === 'download'));
  assert.equal(await page.evaluate(() => window.calls.find(call => call.type === 'download').destination), 'C:\\Downloads');
  await page.locator('#transferHistoryTab').click(); assert.equal(await page.locator('#transferHistoryItems .download-item').count(), 2);
  assert.equal(await page.locator('#transferHistoryItems progress:visible, #transferHistoryItems .transfer-cancel:visible').count(), 0);
});

test('Transfer Center occludes native browser only when its higher window overlaps', async t => {
  const page = await scenario(t);
  await page.evaluate(() => { void openServerBrowser(); }); await page.locator('.browser-window').waitFor();
  await page.evaluate(() => { const win = state.windows.find(item => item.kind === 'browser'); win.position = { x: 0, y: 0 }; win.size = { width: 450, height: 300 }; positionWindow(win); const transfer = state.windows.find(item => item.kind === 'transfer'); transfer.position = { x: 650, y: 10 }; transfer.size = { width: 450, height: 500 }; positionWindow(transfer); focusWindow(transfer.id); });
  await page.waitForFunction(() => window.calls.filter(call => call.type === 'browserLayout').at(-1)?.hidden === false);
  assert.equal(await page.locator('#downloadsPanel').isVisible(), true);
  await page.evaluate(() => { const win = state.windows.find(item => item.kind === 'transfer'); win.position = { x: 50, y: 20 }; positionWindow(win); });
  await page.waitForFunction(() => window.calls.filter(call => call.type === 'browserLayout').at(-1)?.hidden === true);
  await page.locator('#downloadsPanel [data-window-action="minimize"]').click();
  await page.waitForFunction(() => window.calls.filter(call => call.type === 'browserLayout').at(-1)?.hidden === false);
});
