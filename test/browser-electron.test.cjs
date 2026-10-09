'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const project = path.resolve(__dirname, '..');
async function waitFor(application, check, timeout = 12000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await application.evaluate(check); if (value) return value; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error(`Browser fixture condition timed out: ${check}\n${JSON.stringify(await application.evaluate(() => ({transfers:browserFixture.transfers,logs:browserFixture.logs})))}`); }
async function waitAbsent(value, timeout = 3000) { const end = Date.now() + timeout; while (Date.now() < end) { try { await fs.access(value); } catch { return; } await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error(`Expected temporary path to be removed: ${value}`); }
async function browserLaunch(userData, env) {
  const harness = path.join(project, 'test/helpers/browser-harness.cjs');
  const executable = process.env.REMOTE_DESKTOP_TEST_EXE;
  if (!executable) return { args: [harness, '--smoke-test', `--user-data-dir=${userData}`], env };
  const { createPackage } = require('@electron/asar');
  // Packaged applications always load their own app.asar. Give the exact shipped
  // runtime an isolated harness entry, while requiring the original shipped
  // modules/preloads/UI directly from app.asar (never an extracted source copy).
  const distribution = path.dirname(path.resolve(executable)), runtime = path.join(userData, 'runtime');
  // Keep the packaged executable and native resources intact. Swap only the
  // temporary app.asar for a harness that imports the shipped app.asar files.
  await fs.cp(distribution, runtime, { recursive: true });
  const application = path.join(userData, 'packaged-browser-harness');
  await fs.mkdir(path.join(application, 'test/helpers'), { recursive: true });
  for (const name of ['browser-harness.cjs', 'ssh-fixture.cjs']) await fs.copyFile(path.join(project, 'test/helpers', name), path.join(application, 'test/helpers', name));
  await fs.writeFile(path.join(application, 'package.json'), JSON.stringify({ name: 'isolated-packaged-browser-test', main: 'main.cjs' }));
  const shippedNodeModules = path.join(distribution, 'resources', 'app.asar', 'node_modules');
  await fs.writeFile(path.join(application, 'main.cjs'), `const Module = require('node:module'); process.env.NODE_PATH = ${JSON.stringify(shippedNodeModules)}; Module._initPaths(); require('./test/helpers/browser-harness.cjs');\n`);
  const testAsar = path.join(userData, 'browser-harness.asar');
  await createPackage(application, testAsar);
  await fs.copyFile(testAsar, path.join(runtime, 'resources/app.asar'));
  return { executablePath: path.join(runtime, path.basename(executable)), args: ['--smoke-test', `--user-data-dir=${userData}`], env: { ...env, REMOTE_DESKTOP_BROWSER_MODULE_ROOT: path.join(distribution, 'resources/app.asar') } };
}

test('real isolated Electron browser uses SSH DNS, isolates APIs and preserves cookies/POST/blob downloads with local/server destinations', { timeout: 120000 }, async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-browser-electron-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = await browserLaunch(userData, env);
  const application = await electron.launch(launch);
  const processErrors = []; application.process().stderr?.on('data', chunk => processErrors.push(chunk.toString()));
  t.after(async () => { const timer = setTimeout(() => { if (application.process().exitCode === null) spawnSync('taskkill', ['/PID', String(application.process().pid), '/T', '/F'], { windowsHide: true }); }, 10000); try { await application.evaluate(() => closeBrowserFixture()).catch(() => {}); await application.close(); } finally { clearTimeout(timer); } await fs.rm(userData, { recursive: true, force: true }); });
  try { await application.firstWindow(); } catch (error) { throw new Error(`${error.message}\nPackaged Electron stderr:\n${processErrors.join('').slice(-8000)}`); }
  await waitFor(application, () => Boolean(globalThis.browserManager));
  await application.evaluate(() => browserManager.open('http://remote-only.invalid:8765/'));
  await waitFor(application, () => [...browserManager.windows.values()][0]?.view.webContents.getTitle() === 'Remote fixture');
  await application.evaluate(() => {const state=[...browserManager.windows.values()][0];state.view.webContents.on('console-message',(_event,...details)=>browserFixture.logs.push(details));});
  const browser = application.windows().find(page => page.url().endsWith('/app/browser.html')); assert.ok(browser);
  if (process.env.REMOTE_DESKTOP_TEST_EXE) {
    assert.match(await application.evaluate(() => browserFixture.moduleRoot), /app\.asar$/);
    assert.match(browser.url(), /app\.asar\/app\/browser\.html$/);
  }
  const security = await application.evaluate(async () => {
    const state = [...browserManager.windows.values()][0]; const preferences = state.view.webContents.getLastWebPreferences();
    return { node: preferences.nodeIntegration, sandbox: preferences.sandbox, isolation: preferences.contextIsolation, preload: preferences.preload, proxy: await state.context.partition.resolveProxy('http://localhost:8765/'), apis: await state.view.webContents.executeJavaScript('JSON.stringify({node:typeof require,desktop:typeof window.remoteDesktop,browser:typeof window.serverBrowser,workbench:typeof window.workbench})') };
  });
  assert.equal(security.node, false); assert.equal(security.sandbox, true); assert.equal(security.isolation, true); assert.ok(!security.preload); assert.match(security.proxy, /SOCKS5/); assert.deepEqual(JSON.parse(security.apis), { node: 'undefined', desktop: 'undefined', browser: 'undefined', workbench: 'undefined' });
  assert.ok(await application.evaluate(() => browserFixture.forwards.some(value => value.destIP === 'remote-only.invalid' && value.destPort === 8765)));
  await application.evaluate(() => [...browserManager.windows.values()][0].view.webContents.executeJavaScript('document.getElementById("download").click()', true));
  await waitFor(application, () => browserFixture.transfers.some(value => value.status === 'completed'));
  assert.equal(await fs.readFile(path.join(userData, 'result.txt'), 'utf8'), 'authenticated:GET:');
  assert.deepEqual(await application.evaluate(() => { const task = browserFixture.transfers.findLast(value => value.status === 'completed'); return { side: task.targetSide, directory: task.targetDirectory }; }), { side: 'local', directory: userData });
  // Native save-dialog confirmation must never bypass the exclusive final write.
  await application.evaluate(() => [...browserManager.windows.values()][0].view.webContents.executeJavaScript('document.getElementById("download").click()', true));
  await waitFor(application, () => browserFixture.transfers.some(value => value.status === 'error' && /未覆盖/.test(value.error)));
  assert.equal(await fs.readFile(path.join(userData, 'result.txt'), 'utf8'), 'authenticated:GET:');
  await browser.evaluate(() => window.serverBrowser.call('destination', { destination: 'server', serverDirectory: '/srv/downloads' }));
  await application.evaluate(() => [...browserManager.windows.values()][0].view.webContents.executeJavaScript('document.getElementById("post").click()', true));
  await waitFor(application, () => browserFixture.uploaded.length === 1);
  assert.deepEqual(await application.evaluate(() => browserFixture.uploaded[0]), { content: 'authenticated:POST:payload=private', directory: '/srv/downloads' });
  await waitFor(application, () => browserFixture.transfers.some(value => value.status === 'completed' && value.targetSide === 'remote'));
  assert.equal(await application.evaluate(() => browserFixture.transfers.findLast(value => value.status === 'completed').targetDirectory), '/srv/downloads');
  await application.evaluate(() => [...browserManager.windows.values()][0].view.webContents.executeJavaScript('document.getElementById("blob").click()', true));
  await waitFor(application, () => browserFixture.uploaded.length === 2);
  assert.equal(await application.evaluate(() => browserFixture.uploaded[1].content), 'blob-content');
  await application.evaluate(() => [...browserManager.windows.values()][0].view.webContents.executeJavaScript('document.getElementById("slow").click()', true));
  await waitFor(application, () => browserFixture.transfers.findLast(value => value.name === 'slow.bin' && value.status === 'running'));
  assert.equal(await application.evaluate(() => browserManager.cancel(browserFixture.transfers.findLast(value => value.name === 'slow.bin').id)), true);
  await waitFor(application, () => browserFixture.transfers.some(value => value.name === 'slow.bin' && value.status === 'cancelled'));
  await application.evaluate(() => [...browserManager.windows.values()][0].view.webContents.executeJavaScript('document.getElementById("broken").click()', true));
  await waitFor(application, () => browserFixture.transfers.some(value => value.name === 'broken.bin' && value.status === 'error'), 20000);
  assert.equal(await application.evaluate(() => browserFixture.uploaded.length), 2);
  const blocked = await browser.evaluate(async () => { try { await window.serverBrowser.call('navigate', { url: 'file:///C:/Windows/win.ini' }); return false; } catch { return true; } }); assert.equal(blocked, true);
  await browser.evaluate(() => window.serverBrowser.call('navigate', { url: 'http://localhost:8765/localhost-check' }));
  await waitFor(application, () => browserFixture.requests.some(value => value.host === 'localhost:8765' && value.url === '/localhost-check'));
  assert.ok(await application.evaluate(() => browserFixture.forwards.some(value => value.destIP === 'localhost' && value.destPort === 8765)));
  await waitFor(application, () => [...browserManager.windows.values()][0].view.webContents.getURL() === 'http://localhost:8765/localhost-check' && ![...browserManager.windows.values()][0].view.webContents.isLoading());
  assert.ok((await application.evaluate(() => browserManager.context.partition.cookies.get({}))).length > 0);
  await browser.evaluate(() => window.serverBrowser.call('clearSession'));
  assert.equal((await application.evaluate(() => browserManager.context.partition.cookies.get({}))).length, 0);
  await application.evaluate(async () => { globalThis.previousBrowserContext = browserManager.context; await previousBrowserContext.partition.cookies.set({ url: 'http://localhost:8765', name: 'session', value: 'fixture' }); });
  await application.evaluate(() => [...browserManager.windows.values()][0].view.webContents.executeJavaScript('document.getElementById("slow").click()', true));
  await waitFor(application, () => [...browserManager.transfers.values()].some(value => value.info.name === 'slow.bin' && value.info.status === 'running'));
  const temporaryPaths = await application.evaluate(() => [...browserManager.transfers.values()].map(value => value.staging));
  await application.evaluate(() => browserManager.disconnect());
  assert.equal(await application.evaluate(() => browserManager.windows.size), 0);
  assert.equal(await application.evaluate(() => browserManager.transfers.size), 0);
  assert.equal((await application.evaluate(() => previousBrowserContext.partition.cookies.get({}))).length, 0);
  assert.equal(await application.evaluate(() => browserFixture.transfers.findLast(value => value.name === 'slow.bin').status), 'cancelled');
  for (const directory of temporaryPaths) await waitAbsent(directory);
  assert.equal(await application.evaluate(() => browserManager.context), null);
});

test('embedded browser uses desktop child views, opens popup links and POST in focused tabs, and closes without destroying desktop', { timeout: 60000 }, async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-browser-embedded-'));
  const env = { ...process.env, REMOTE_DESKTOP_BROWSER_EMBEDDED: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch(await browserLaunch(userData, env));
  const processErrors = []; application.process().stderr?.on('data', chunk => processErrors.push(chunk.toString()));
  t.after(() => { if (processErrors.length) console.error(processErrors.join('')); });
  t.after(async () => { const timer = setTimeout(() => { if (application.process().exitCode === null) spawnSync('taskkill', ['/PID', String(application.process().pid), '/T', '/F'], { windowsHide: true }); }, 10000); try { await application.evaluate(() => closeBrowserFixture()).catch(() => {}); await application.close(); } finally { clearTimeout(timer); } await fs.rm(userData, { recursive: true, force: true }); });
  await application.firstWindow(); await waitFor(application, () => Boolean(globalThis.browserManager));
  const opened = await application.evaluate(() => browserManager.open('http://remote-only.invalid:8765/'));
  assert.equal(opened.embedded, true);
  await waitFor(application, () => [...browserManager.windows.values()][0].view.webContents.getTitle() === 'Remote fixture');
  const initial = await application.evaluate(({ BrowserWindow }) => {
    const [id, state] = [...browserManager.windows][0]; globalThis.firstBrowserTab = state.activeTabId;
    browserManager.setLayout(id, { x: 40, y: 50, width: 600, height: 450 }, false);
    return { count: BrowserWindow.getAllWindows().length, embedded: state.embedded, view: state.view.getBounds(), toolbar: state.toolbar.getBounds(), children: state.window.contentView.children.length, visible: state.view.getVisible(), sameSession: state.toolbar.webContents.session === state.context.partition };
  });
  assert.equal(initial.count, 1); assert.equal(initial.embedded, true); assert.equal(initial.children, 2); assert.equal(initial.visible, true); assert.equal(initial.sameSession, false);
  assert.deepEqual(initial.toolbar, { x: 40, y: 50, width: 600, height: 81 }); assert.deepEqual(initial.view, { x: 40, y: 131, width: 600, height: 369 });
  const compactChrome = JSON.parse(await application.evaluate(() => [...browserManager.windows.values()][0].toolbar.webContents.executeJavaScript(`JSON.stringify({ detailsHidden: document.getElementById('browserDetails').hidden, statusHidden: document.getElementById('status').hidden, expanded: document.getElementById('toggleDetails').getAttribute('aria-expanded'), tabsAboveAddress: document.querySelector('.tab-strip').getBoundingClientRect().bottom <= document.getElementById('navigation').getBoundingClientRect().top })`)));
  assert.deepEqual(compactChrome, { detailsHidden: true, statusHidden: true, expanded: 'false', tabsAboveAddress: true });
  const symbolGeometry = JSON.parse(await application.evaluate(() => [...browserManager.windows.values()][0].toolbar.webContents.executeJavaScript(`JSON.stringify((() => {
    const center = selector => { const box = document.querySelector(selector).getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
    return { add: center('#newTab'), addIcon: center('#newTab svg'), close: center('.tab-close'), closeIcon: center('.tab-close svg'), options: center('#toggleDetails'), triangle: center('#toggleDetails svg') };
  })())`)));
  for (const [button, icon] of [['add', 'addIcon'], ['close', 'closeIcon'], ['options', 'triangle']]) {
    assert.ok(Math.abs(symbolGeometry[button].x - symbolGeometry[icon].x) < 1 && Math.abs(symbolGeometry[button].y - symbolGeometry[icon].y) < 1, `${button} symbol is centered`);
  }
  assert.ok(Math.abs(symbolGeometry.add.y - symbolGeometry.close.y) < 1, 'new-tab and tab-close centers share one horizontal line');
  await application.evaluate(() => [...browserManager.windows.values()][0].toolbar.webContents.executeJavaScript(`document.getElementById('toggleDetails').click()`));
  await waitFor(application, () => [...browserManager.windows.values()][0].toolbarHeight > 81);
  const expandedChrome = await application.evaluate(() => { const state = [...browserManager.windows.values()][0]; return { height: state.toolbarHeight, toolbar: state.toolbar.getBounds(), view: state.view.getBounds() }; });
  assert.equal(expandedChrome.toolbar.height, expandedChrome.height);
  assert.equal(expandedChrome.view.y, 50 + expandedChrome.height);
  assert.equal(expandedChrome.view.height + expandedChrome.height, 450);
  // Expanding server options can add another row; the page must move with it.
  await application.evaluate(() => [...browserManager.windows.values()][0].toolbar.webContents.executeJavaScript(`const destination=document.getElementById('destination'); destination.value='server'; destination.dispatchEvent(new Event('change')); document.getElementById('serverDirectory').value='/srv/chrome-test'; document.getElementById('serverDirectory').dispatchEvent(new Event('change'));`));
  await waitFor(application, () => { const state = [...browserManager.windows.values()][0]; return state.serverDirectory === '/srv/chrome-test' && state.toolbarHeight > 150; });
  const screenshots = path.join(project, 'artifacts/browser-1.1.10'); await fs.mkdir(screenshots, { recursive: true });
  await fs.writeFile(path.join(screenshots, 'expanded.png'), Buffer.from(await application.evaluate(async () => (await [...browserManager.windows.values()][0].toolbar.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')), 'base64'));
  await application.evaluate(() => [...browserManager.windows.values()][0].toolbar.webContents.executeJavaScript(`document.getElementById('toggleDetails').click()`));
  await waitFor(application, () => [...browserManager.windows.values()][0].toolbarHeight === 81);
  assert.deepEqual(await application.evaluate(() => { const state = [...browserManager.windows.values()][0]; return { destination: state.downloadDestination, directory: state.serverDirectory, view: state.view.getBounds() }; }), { destination: 'server', directory: '/srv/chrome-test', view: { x: 40, y: 131, width: 600, height: 369 } });
  await fs.writeFile(path.join(screenshots, 'collapsed.png'), Buffer.from(await application.evaluate(async () => (await [...browserManager.windows.values()][0].toolbar.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')), 'base64'));
  // Navigation errors stay visible even while options are collapsed.
  await application.evaluate(() => [...browserManager.windows.values()][0].toolbar.webContents.executeJavaScript(`document.getElementById('address').value='file:///C:/Windows/win.ini'; document.getElementById('navigation').requestSubmit();`));
  await waitFor(application, () => [...browserManager.windows.values()][0].toolbarHeight > 81);
  assert.equal(await application.evaluate(() => [...browserManager.windows.values()][0].toolbar.webContents.executeJavaScript(`!document.getElementById('status').hidden && document.getElementById('status').classList.contains('error')`)), true);
  await application.evaluate(() => { const state = [...browserManager.windows.values()][0]; state.downloadDestination = 'local'; browserManager.status(state); });
  await waitFor(application, () => [...browserManager.windows.values()][0].toolbarHeight === 81);
  assert.equal(await application.evaluate(() => [...browserManager.windows.values()][0].toolbar.webContents.executeJavaScript(`window.serverBrowser.call('toolbarLayout', { height: 10000 }).then(() => false, () => true)`)), true);
  assert.equal((await application.evaluate(() => browserManager.open())).id, opened.id);
  await application.evaluate(() => { const state = [...browserManager.windows.values()][0]; return state.view.webContents.executeJavaScript(`const link=document.createElement('a');link.href='/popup-link';link.target='_blank';document.body.append(link);link.click()`, true); });
  await waitFor(application, () => [...browserManager.windows.values()][0].tabs.size === 2 && [...browserManager.windows.values()][0].view.webContents.getURL().endsWith('/popup-link'));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.equal(await application.evaluate(() => [...browserManager.windows.values()][0].activeTabId !== firstBrowserTab), true);
  assert.equal(await application.evaluate(() => browserFixture.windowEvents.findLast(value => value.type === 'focus')?.type), 'focus');
  const popupSecurity = JSON.parse(await application.evaluate(() => [...browserManager.windows.values()][0].view.webContents.executeJavaScript('JSON.stringify({node:typeof require,desktop:typeof window.remoteDesktop,browser:typeof window.serverBrowser})')));
  assert.deepEqual(popupSecurity, { node: 'undefined', desktop: 'undefined', browser: 'undefined' });
  assert.deepEqual(await application.evaluate(() => { const state = [...browserManager.windows.values()][0], prefs = state.view.webContents.getLastWebPreferences(); return { node: prefs.nodeIntegration, sandbox: prefs.sandbox, isolation: prefs.contextIsolation, session: state.view.webContents.session === state.context.partition, preload: Boolean(prefs.preload) }; }), { node: false, sandbox: true, isolation: true, session: true, preload: false });
  await application.evaluate(() => [...browserManager.windows.values()][0].view.webContents.executeJavaScript(`const form=document.createElement('form');form.action='/popup-post';form.target='_blank';form.method='POST';const value=document.createElement('input');value.name='secret';value.value='roundtrip';form.append(value);document.body.append(form);form.submit()`, true));
  await waitFor(application, () => [...browserManager.windows.values()][0].tabs.size === 3 && [...browserManager.windows.values()][0].view.webContents.getTitle() === 'Popup POST');
  assert.equal(await application.evaluate(() => [...browserManager.windows.values()][0].view.webContents.executeJavaScript('document.body.textContent')), 'secret=roundtrip');
  assert.ok(await application.evaluate(() => browserFixture.requests.some(value => value.url === '/popup-post' && value.method === 'POST' && value.cookie === 'session=fixture')));
  // Download initiated by an inactive tab still belongs to the same browser.
  await application.evaluate(() => { const state = [...browserManager.windows.values()][0]; return state.tabs.get(firstBrowserTab).view.webContents.executeJavaScript('document.getElementById("download").click()', true); });
  await waitFor(application, () => browserFixture.transfers.some(value => value.status === 'completed'));
  assert.equal(await fs.readFile(path.join(userData, 'result.txt'), 'utf8'), 'authenticated:GET:');
  await application.evaluate(() => [...browserManager.windows.values()][0].view.webContents.executeJavaScript('window.open("file:///C:/Windows/win.ini")', true));
  assert.equal(await application.evaluate(() => [...browserManager.windows.values()][0].tabs.size), 3);
  const visibility = await application.evaluate(() => { const [id, state] = [...browserManager.windows][0]; browserManager.setLayout(id, null, true); const hidden = [...state.tabs.values()].every(tab => !tab.view.getVisible()) && !state.toolbar.getVisible(); browserManager.setLayout(id, null, false); return { hidden, active: state.view.getVisible(), visibleTabs: [...state.tabs.values()].filter(tab => tab.view.getVisible()).length }; });
  assert.deepEqual(visibility, { hidden: true, active: true, visibleTabs: 1 });
  await application.evaluate(async () => {
    const [id, state] = [...browserManager.windows][0];
    await state.view.webContents.executeJavaScript('document.body.style.cssText="margin:0;min-height:100vh;background:rgb(224,16,32)";document.body.textContent=""');
    globalThis.snapshotStart = Date.now(); browserManager.setLayout(id, null, true, true);
  });
  await waitFor(application, ({ nativeImage }) => {
    const snapshot = browserFixture.windowEvents.findLast(value => value.type === 'snapshot' && value.capturedAt >= snapshotStart);
    if (!snapshot) return false; const pixel = nativeImage.createFromDataURL(snapshot.page).resize({ width: 1, height: 1 }).toBitmap(); return pixel[2] > 180 && pixel[1] < 60;
  });
  const firstSnapshot = await application.evaluate(({ nativeImage }) => {
    const state = [...browserManager.windows.values()][0], snapshot = browserFixture.windowEvents.findLast(value => value.type === 'snapshot');
    const pixel = nativeImage.createFromDataURL(snapshot.page).resize({ width: 1, height: 1 }).toBitmap();
    return { pixel: [...pixel], toolbarHeight: snapshot.toolbarHeight, width: snapshot.width, height: snapshot.height, toolbar: snapshot.toolbar.startsWith('data:image/png;base64,'), nativeVisible: state.view.getVisible(), timer: Boolean(state.captureTimer) };
  });
  assert.ok(firstSnapshot.pixel[2] > 180 && firstSnapshot.pixel[1] < 60, `Expected red background: ${firstSnapshot.pixel}`);
  assert.deepEqual({ ...firstSnapshot, pixel: undefined }, { pixel: undefined, toolbarHeight: 81, width: 600, height: 450, toolbar: true, nativeVisible: false, timer: true });
  await application.evaluate(async () => { const state = [...browserManager.windows.values()][0]; await state.view.webContents.executeJavaScript('document.body.style.background="rgb(16,192,48)"'); globalThis.snapshotGreenStart = Date.now(); });
  await waitFor(application, ({ nativeImage }) => {
    const snapshot = browserFixture.windowEvents.findLast(value => value.type === 'snapshot' && value.capturedAt > snapshotGreenStart);
    if (!snapshot) return false; const pixel = nativeImage.createFromDataURL(snapshot.page).resize({ width: 1, height: 1 }).toBitmap(); return pixel[1] > 150 && pixel[2] < 60;
  });
  assert.equal(await application.evaluate(() => { const [id, state] = [...browserManager.windows][0]; browserManager.setLayout(id, null, false); return state.captureTimer === null && state.view.getVisible(); }), true);
  const toolbarState = await application.evaluate(() => [...browserManager.windows.values()][0].toolbar.webContents.executeJavaScript('JSON.stringify({tabs:document.querySelectorAll(".browser-tab").length,active:document.querySelectorAll(".browser-tab.active").length})'));
  assert.deepEqual(JSON.parse(toolbarState), { tabs: 3, active: 1 });
  await application.evaluate(() => [...browserManager.windows.values()][0].toolbar.webContents.executeJavaScript('document.querySelector(".browser-tab.active .tab-close").click()'));
  await waitFor(application, () => [...browserManager.windows.values()][0].tabs.size === 2);
  const closed = await application.evaluate(({ BrowserWindow }) => { const [id, state] = [...browserManager.windows][0]; const parent = state.window; browserManager.setLayout(id, null, true, true); browserManager.close(id); return { parentDestroyed: parent.isDestroyed(), timer: state.captureTimer, count: BrowserWindow.getAllWindows().length, children: parent.contentView.children.length, browsers: browserManager.windows.size, event: browserFixture.windowEvents.at(-1) }; });
  assert.equal(closed.timer, null);
  assert.equal(closed.parentDestroyed, false); assert.equal(closed.count, 1); assert.equal(closed.children, 0); assert.equal(closed.browsers, 0); assert.equal(closed.event.type, 'closed');
  await application.evaluate(() => browserManager.open('http://remote-only.invalid:8765/'));
  await application.evaluate(() => { const state = [...browserManager.windows.values()][0]; return browserManager.action(state, 'closeTab', { id: state.activeTabId }); });
  await waitFor(application, () => browserManager.windows.size === 0);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await application.evaluate(() => browserManager.open('http://remote-only.invalid:8765/'));
  await application.evaluate(() => browserManager.disconnect());
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
});

test('server HTML and PDF files render in isolated browser tabs and expire when closed', { timeout: 60000 }, async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-browser-files-'));
  const env = { ...process.env, REMOTE_DESKTOP_BROWSER_EMBEDDED: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch(await browserLaunch(userData, env));
  t.after(async () => { await application.evaluate(() => closeBrowserFixture()).catch(() => {}); await application.close(); await fs.rm(userData, { recursive: true, force: true }); });
  await application.firstWindow(); await waitFor(application, () => Boolean(globalThis.browserManager));
  const files = await application.evaluate(() => prepareBrowserFileFixture());
  await application.evaluate(() => browserManager.open('http://remote-only.invalid:8765/'));
  await waitFor(application, () => [...browserManager.windows.values()][0].view.webContents.getTitle() === 'Remote fixture');
  const html = await application.evaluate((_, file) => browserManager.openFile(file), files.html);
  await waitFor(application, () => [...browserManager.windows.values()][0].view.webContents.getTitle() === 'Remote HTML');
  assert.deepEqual(JSON.parse(await application.evaluate(() => [...browserManager.windows.values()][0].view.webContents.executeJavaScript('JSON.stringify({text:document.getElementById("ready").textContent,script:document.getElementById("ready").dataset.script,color:getComputedStyle(document.getElementById("ready")).color,api:typeof window.remoteDesktop,node:typeof require})'))), { text: 'HTML preview', script: 'loaded', color: 'rgb(0, 128, 0)', api: 'undefined', node: 'undefined' });
  await assert.rejects(application.evaluate(() => { const state = [...browserManager.windows.values()][0]; return browserManager.action(state, 'navigate', { url: 'http://127.0.0.1:1/private' }); }), /仅允许/);
  await assert.rejects(application.evaluate(() => browserManager.openFile('file:///C:/Windows/win.ini')), /路径无效/);
  const pdf = await application.evaluate((_, file) => browserManager.openFile(file), files.pdf);
  await application.evaluate(() => { const [id] = browserManager.windows.keys(); browserManager.setLayout(id, { x: 0, y: 0, width: 900, height: 700 }, false); });
  await waitFor(application, () => [...browserManager.windows.values()][0].view.webContents.mainFrame.frames.some(frame => frame.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')));
  const pdfFrames = await application.evaluate(() => [...browserManager.windows.values()][0].view.webContents.mainFrame.frames.map(frame => ({url:frame.url,name:frame.name})));
  assert.ok(pdfFrames.some(frame => frame.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')));
  await application.evaluate((_, id) => { const state = [...browserManager.windows.values()][0]; return browserManager.action(state, 'closeTab', { id }); }, pdf.id);
  await application.evaluate((_, id) => { const state = [...browserManager.windows.values()][0]; return browserManager.action(state, 'closeTab', { id }); }, html.id);
  await waitFor(application, () => browserManager.previews.size === 0);
  await waitFor(application, () => [...browserManager.windows.values()][0].view.webContents.getTitle() === 'Remote fixture');
});

