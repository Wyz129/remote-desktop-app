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
  // Native save-dialog confirmation must never bypass the exclusive final write.
  await application.evaluate(() => [...browserManager.windows.values()][0].view.webContents.executeJavaScript('document.getElementById("download").click()', true));
  await waitFor(application, () => browserFixture.transfers.some(value => value.status === 'error' && /未覆盖/.test(value.error)));
  assert.equal(await fs.readFile(path.join(userData, 'result.txt'), 'utf8'), 'authenticated:GET:');
  await browser.evaluate(() => window.serverBrowser.call('destination', { destination: 'server', serverDirectory: '/srv/downloads' }));
  await application.evaluate(() => [...browserManager.windows.values()][0].view.webContents.executeJavaScript('document.getElementById("post").click()', true));
  await waitFor(application, () => browserFixture.uploaded.length === 1);
  assert.deepEqual(await application.evaluate(() => browserFixture.uploaded[0]), { content: 'authenticated:POST:payload=private', directory: '/srv/downloads' });
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

