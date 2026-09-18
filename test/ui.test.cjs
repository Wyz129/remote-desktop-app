'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
const remoteRoot = '/home/tester/Desktop';
const results = [];
let browser;
let server;
let origin;

function entry(parent, name, type = 'file', extra = {}) {
  const resourcePath = `${parent}/${name}`;
  return { name, type, path: resourcePath, uri: `vscode-remote://ssh-remote+test${resourcePath}`, size: type === 'folder' ? '' : '12 B', ...extra };
}
function fixture(config = {}) {
  return {
    rootPath: remoteRoot,
    homePath: '/home/tester',
    config: { viewMode: 'details', positions: {}, shortcuts: [], ...config },
    directories: {
      '/home/tester': [entry('/home/tester', 'Desktop', 'folder')],
      [remoteRoot]: [entry(remoteRoot, 'projects', 'folder'), entry(remoteRoot, 'results', 'folder'), entry(remoteRoot, 'notes.txt'), entry(remoteRoot, 'run.sh'), entry(remoteRoot, 'notes-link.txt', 'file', { isSymbolicLink: true }), entry(remoteRoot, 'project-link', 'folder', { isSymbolicLink: true })],
      [`${remoteRoot}/projects`]: [entry(`${remoteRoot}/projects`, 'nested', 'folder'), entry(`${remoteRoot}/projects`, 'source.txt')],
      [`${remoteRoot}/projects/nested`]: [entry(`${remoteRoot}/projects/nested`, 'deep.txt')],
      [`${remoteRoot}/results`]: [],
      [`${remoteRoot}/project-link`]: [entry(`${remoteRoot}/project-link`, 'source.txt')]
    }
  };
}
before(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  server = http.createServer((req, res) => {
    const file = req.url === '/' ? 'desktop.html' : req.url.slice(1);
    if (!['desktop.html', 'desktop.css', 'desktop.js', 'lucide.js', 'xterm.js', 'xterm.css', 'xterm-addon-fit.js'].includes(file)) return res.writeHead(404).end();
    const replacements = { cspSource: origin, nonce: 'ui-test', styleUri: `${origin}/desktop.css`, scriptUri: `${origin}/desktop.js`, iconsUri: `${origin}/lucide.js`, terminalStyleUri: `${origin}/xterm.css`, terminalScriptUri: `${origin}/xterm.js`, terminalFitUri: `${origin}/xterm-addon-fit.js` };
    const source = fs.readFileSync(path.join(root, 'media', file), 'utf8').replace(/\{\{(cspSource|nonce|styleUri|scriptUri|iconsUri|terminalStyleUri|terminalScriptUri|terminalFitUri)\}\}/g, (_, key) => replacements[key]);
    res.writeHead(200, { 'Content-Type': `${file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'application/javascript'}; charset=utf-8` });
    res.end(source);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
  fs.writeFileSync(path.join(artifacts, 'ui-smoke.json'), JSON.stringify({ results, passed: results.length > 0 && results.every(result => result.passed) }, null, 2));
});

async function scenario(name, fn, { config = {}, viewport = { width: 1440, height: 900 }, remote = true, clock = false } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { errors.push(`Unexpected browser ${dialog.type()} dialog: ${dialog.message()}`); await dialog.dismiss(); });
  await page.addInitScript(({ data, useRemote }) => {
    window.demoMessages = [];
    window.mockRemote = data;
    window.mockRemoteEnabled = useRemote;
    window.mockRemotePaused = false;
    window.mockExtensionSettings = { settings: { openOnStartup: false, remoteRoot: '/home/demo', remoteHome: '', scriptEditor: 'vscode' }, hasWorkspace: true, target: 'workspace', reopenRequired: false };
    window.prompt = () => { throw new Error('window.prompt is unavailable in VS Code webviews'); };
    window.receiveHostMessage = message => window.dispatchEvent(new MessageEvent('message', { data: message }));
    window.sendRemoteState = (refresh = false) => window.receiveHostMessage({ type: 'remoteState', status: 'ready', rootPath: window.mockRemote.rootPath, homePath: window.mockRemote.homePath, folder: window.mockRemote.rootPath, entries: window.mockRemote.directories[window.mockRemote.rootPath], config: window.mockRemote.config, refresh });
    window.acquireVsCodeApi = () => ({
      postMessage: message => {
        window.demoMessages.push(message);
        if (message.type === 'ready' || message.type === 'getExtensionSettings') queueMicrotask(() => {
          window.receiveHostMessage({ type: 'extensionSettings', ...window.mockExtensionSettings, requestId: message.requestId });
        });
        if (message.type === 'saveExtensionSettings') queueMicrotask(() => {
          if (!window.extensionSettingsSaveError) Object.assign(window.mockExtensionSettings.settings, message.settings);
          window.receiveHostMessage({ type: 'extensionSettingsSaved', ...window.mockExtensionSettings, requestId: message.requestId, ok: !window.extensionSettingsSaveError, error: window.extensionSettingsSaveError });
        });
        if (!window.mockRemoteEnabled || window.mockRemotePaused) return;
        // Keep the extension boundary asynchronous, as it is in a real webview.
        queueMicrotask(() => {
          if (message.type === 'ready') window.sendRemoteState();
          if (message.type === 'refreshRemote') window.sendRemoteState(true);
          if (message.type === 'readDirectory') {
            const entries = window.mockRemote.directories[message.path];
            window.receiveHostMessage({ type: 'remoteDirectory', path: message.path, ...(entries ? { entries } : { error: 'Directory does not exist' }), requestId: message.requestId, windowId: message.windowId });
          }
        });
      },
      getState: () => JSON.parse(localStorage.getItem('demo-state') || 'null'),
      setState: state => (localStorage.setItem('demo-state', JSON.stringify(state)), state)
    });
  }, { data: fixture(config), useRemote: remote });
  try {
    if (clock) await page.clock.install();
    await page.goto(origin);
    await page.waitForFunction(() => window.demoMessages.some(message => message.type === 'ready'));
    if (remote) await desktopIcon(page, 'projects').waitFor();
    await fn(page);
    assert.deepEqual(errors, [], 'The webview must run without script errors or browser dialogs');
    results.push({ name, passed: true });
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, `failed-${name}.png`), fullPage: true }).catch(() => {});
    results.push({ name, passed: false, error: error.message });
    throw error;
  } finally { await context.close(); }
}
const desktopIcon = (page, name) => page.locator(`#icons .icon[data-path="${remoteRoot}/${name}"]`);
const windowAction = (win, action) => win.locator(`[data-window-action="${action}"]`);
const windowEntry = (win, folder, name) => win.locator(`.entry[data-path="${folder}/${name}"]`);
const messages = (page, type) => page.evaluate(messageType => window.demoMessages.filter(message => message.type === messageType), type);
const clearMessages = page => page.evaluate(() => { window.demoMessages = []; });
const receive = (page, message) => page.evaluate(data => window.receiveHostMessage(data), message);
async function waitForMessage(page, type, operation) {
  await page.waitForFunction(({ messageType, action }) => window.demoMessages.some(message => message.type === messageType && (!action || message.operation === action)), { messageType: type, action: operation });
  return (await messages(page, type)).filter(message => !operation || message.operation === operation).at(-1);
}
async function openDesktopFolder(page, name) {
  await desktopIcon(page, name).dblclick();
  const win = page.locator('.window[data-window-id]:visible').last();
  await win.waitFor();
  await page.waitForFunction(folder => [...document.querySelectorAll('.window:not([hidden]) .window-path')].some(element => element.value === folder), `${remoteRoot}/${name}`);
  const id = await win.getAttribute('data-window-id');
  return page.locator(`.window[data-window-id="${id}"]`);
}

test('Desktop settings wait for save acknowledgement, then apply views, wallpaper and hidden entries', () => scenario('settings-save-006', async page => {
  const win = await openDesktopFolder(page, 'projects');
  await page.evaluate(() => {
    const root = window.mockRemote.rootPath;
    window.mockRemote.directories[root].push({ name: '.hidden', type: 'file', path: `${root}/.hidden` });
    window.mockRemote.directories[`${root}/projects`].push({ name: '.secret', type: 'file', path: `${root}/projects/.secret` });
    window.sendRemoteState(true);
  });
  await receive(page, { type: 'remoteDirectory', path: `${remoteRoot}/projects`, entries: [entry(`${remoteRoot}/projects`, 'source.txt'), entry(`${remoteRoot}/projects`, '.secret')] });
  await desktopIcon(page, '.hidden').waitFor();
  await page.locator('#desktopSettings').click();
  await page.locator('#settingsViewMode').selectOption('icons');
  await page.locator('#settingsWallpaper').selectOption('purple');
  await page.locator('#settingsHidden').uncheck();
  await page.locator('#applySettings').click();
  const request = await waitForMessage(page, 'saveDesktopConfig');
  assert.ok(request.requestId.startsWith('settings-'));
  assert.equal(await page.locator('#desktop').getAttribute('data-wallpaper'), 'teal');
  assert.equal(await page.locator('#applySettings').isDisabled(), true);
  await receive(page, { type: 'configSaved', requestId: 'unrelated', ok: true });
  assert.ok(await page.locator('#settingsDialog').isVisible());
  await receive(page, { type: 'configSaved', requestId: request.requestId, ok: true, config: request.config });
  assert.equal(await page.locator('#settingsDialog').isVisible(), false);
  assert.equal(await page.locator('#desktop').getAttribute('data-wallpaper'), 'purple');
  assert.equal(await desktopIcon(page, '.hidden').count(), 0);
  assert.equal(await windowEntry(win, `${remoteRoot}/projects`, '.secret').count(), 0);
  assert.equal(await win.locator('.listing.icon-view').count(), 1);
  await page.locator('#desktopSettings').click();
  assert.equal(await page.locator('#settingsWallpaper').inputValue(), 'purple');
  assert.equal(await page.locator('#settingsHidden').isChecked(), false);
  await page.screenshot({ path: path.join(artifacts, 'settings-006.png'), fullPage: true });
}));

test('New English filenames resolve collisions in desktop and explorer without creating before confirmation', () => scenario('english-defaults-007', async page => {
  await page.evaluate(() => {
    const root = window.mockRemote.rootPath;
    window.mockRemote.directories[root].push({ name: 'New Folder', type: 'folder', path: `${root}/New Folder` });
    window.mockRemote.directories[`${root}/projects`].push({ name: 'New File.txt', type: 'file', path: `${root}/projects/New File.txt` });
    window.sendRemoteState(true);
  });
  await desktopAction(page, 'new-folder');
  assert.equal(await page.locator('input.name-editor').inputValue(), 'New Folder (2)');
  await page.locator('input.name-editor').press('Escape');
  const win = await openDesktopFolder(page, 'projects');
  await listingMenu(win); await page.locator('#context [data-action="new-file"]').click();
  assert.equal(await page.locator('input.name-editor').inputValue(), 'New File (2).txt');
  assert.equal((await messages(page, 'fileOperation')).length, 0);
  await page.locator('input.name-editor').press('Enter');
  const request = await waitForMessage(page, 'fileOperation', 'new-file');
  assert.equal(request.name, 'New File (2).txt');
}));

test('Desktop settings expose every extension preference and save only edited VS Code fields', () => scenario('extension-settings-007', async page => {
  await page.evaluate(() => { window.mockExtensionSettings.settings.remoteHome = '/home/tester'; });
  await page.locator('#desktopSettings').click();
  await page.waitForFunction(() => !document.querySelector('#settingsScriptEditor').disabled);
  assert.equal(await page.locator('#settingsOpenOnStartup').isChecked(), false);
  assert.equal(await page.locator('#settingsRemoteHome').inputValue(), '/home/tester');
  assert.equal(await page.locator('#settingsRemoteRoot').inputValue(), '/home/demo');
  await page.locator('#settingsScriptEditor').selectOption('vim');
  await clearMessages(page); await page.locator('#saveExtensionSettings').click();
  const request = await waitForMessage(page, 'saveExtensionSettings');
  assert.deepEqual(request.settings, { scriptEditor: 'vim' }); assert.equal(request.target, 'workspace');
  assert.equal((await messages(page, 'saveDesktopConfig')).length, 0);
  await page.waitForFunction(() => document.querySelector('#extensionSettingsStatus').textContent.includes('已保存'));
  await page.locator('#settingsOpenOnStartup').check(); await page.locator('#settingsRemoteRoot').fill('/home/sample');
  await page.locator('#settingsRemoteHome').fill('/home/tester/new'); await page.locator('#extensionSettingsTarget').selectOption('user');
  await page.evaluate(() => { window.mockExtensionSettings.reopenRequired = true; });
  await clearMessages(page); await page.locator('#saveExtensionSettings').click();
  const paths = await waitForMessage(page, 'saveExtensionSettings');
  assert.deepEqual(paths.settings, { openOnStartup: true, remoteRoot: '/home/sample', remoteHome: '/home/tester/new' });
  assert.equal(paths.target, 'user');
  await page.waitForFunction(() => document.querySelector('#extensionSettingsStatus').textContent.includes('重新打开'));
  await page.screenshot({ path: path.join(artifacts, 'settings-007.png'), fullPage: true });
}));

test('Editing one preference preserves an unrelated external VS Code settings change', () => scenario('extension-settings-external-007', async page => {
  await page.locator('#desktopSettings').click();
  await page.waitForFunction(() => !document.querySelector('#settingsScriptEditor').disabled);
  await page.evaluate(() => { window.mockExtensionSettings.settings.scriptEditor = 'vim'; });
  await receive(page, { type: 'extensionSettings', settings: { openOnStartup: false, remoteRoot: '/home/demo', remoteHome: '', scriptEditor: 'vim' }, hasWorkspace: true });
  await page.locator('#settingsOpenOnStartup').check();
  await clearMessages(page); await page.locator('#saveExtensionSettings').click();
  const request = await waitForMessage(page, 'saveExtensionSettings');
  assert.deepEqual(request.settings, { openOnStartup: true });
  await page.waitForFunction(() => document.querySelector('#extensionSettingsStatus').textContent.includes('已保存'));
  assert.equal(await page.locator('#settingsScriptEditor').inputValue(), 'vim');
}));

test('Local demo uses the session root and retains it until reopening after a settings change', () => scenario('local-root-007', async page => {
  await receive(page, { type: 'remoteState', status: 'local', rootPath: '/custom/root' });
  assert.equal(await page.locator('#desktopPath').textContent(), '/custom/root');
  await page.locator('#icons .icon[data-path="/custom/root/README.md"]').dblclick();
  assert.equal((await waitForMessage(page, 'openResource')).path, '/custom/root/README.md');
  await receive(page, { type: 'extensionSettings', settings: { openOnStartup: false, remoteRoot: '/another/root', remoteHome: '', scriptEditor: 'vscode' }, hasWorkspace: true, reopenRequired: true });
  await page.keyboard.press('Control+Alt+t');
  assert.equal((await waitForMessage(page, 'openTerminal')).path, '/custom/root');
  await page.reload();
  await receive(page, { type: 'remoteState', status: 'local', rootPath: '/another/root' });
  assert.equal(await page.locator('#icons .icon[data-path="/another/root/projects"]').count(), 1);
  await page.locator('#icons .icon[data-path="/another/root/projects"]').dblclick();
  assert.equal(await page.locator('.window-path').inputValue(), '/another/root/projects');
  assert.equal(await page.locator('.entry[data-path="/another/root/projects/train.py"]').count(), 1);
}, { remote: false }));

test('Extension settings failure preserves the active editor and cancellation makes no changes', () => scenario('extension-settings-errors-007', async page => {
  await page.locator('#desktopSettings').click();
  await page.waitForFunction(() => !document.querySelector('#settingsScriptEditor').disabled);
  await page.locator('#settingsScriptEditor').selectOption('vim');
  await page.evaluate(() => { window.extensionSettingsSaveError = 'Settings file is read-only'; });
  await page.locator('#saveExtensionSettings').click();
  await page.waitForFunction(() => document.querySelector('#extensionSettingsError').textContent.includes('read-only'));
  await page.locator('#closeSettings').click();
  await desktopIcon(page, 'run.sh').dblclick();
  assert.equal((await waitForMessage(page, 'openResource')).path, `${remoteRoot}/run.sh`);
  assert.equal((await messages(page, 'openTerminal')).length, 0);
  await page.locator('#desktopSettings').click();
  await page.waitForFunction(() => !document.querySelector('#settingsScriptEditor').disabled);
  assert.equal(await page.locator('#settingsScriptEditor').inputValue(), 'vscode');
  await page.locator('#settingsScriptEditor').selectOption('vim'); await clearMessages(page);
  await page.locator('#cancelSettings').click();
  assert.equal((await messages(page, 'saveExtensionSettings')).length, 0);
}));

test('Script editor opens Vim with the script path in a desktop window while ordinary files stay in VS Code', () => scenario('script-vim-007', async page => {
  const settings = { openOnStartup: false, remoteRoot: '/home/demo', remoteHome: '', scriptEditor: 'vim' };
  await receive(page, { type: 'extensionSettings', settings, hasWorkspace: true });
  await desktopIcon(page, 'run.sh').dblclick();
  const terminal = await waitForMessage(page, 'openTerminal');
  assert.equal(terminal.program, 'vim'); assert.equal(terminal.path, remoteRoot); assert.equal(terminal.filePath, `${remoteRoot}/run.sh`);
  assert.equal((await messages(page, 'openResource')).length, 0);
  const vim = page.locator(`.terminal-window[data-window-id="${terminal.id}"]`);
  assert.equal(await vim.locator('.window-title').textContent(), 'Vim — run.sh');
  await receive(page, { type: 'terminalError', id: terminal.id, error: '服务器未安装 vim' });
  assert.match(await vim.locator('.terminal-status').textContent(), /未安装 vim/);
  await windowAction(vim, 'close').click();
  await desktopIcon(page, 'notes.txt').dblclick();
  assert.equal((await waitForMessage(page, 'openResource')).path, `${remoteRoot}/notes.txt`);
  await page.evaluate(() => { const root = window.mockRemote.rootPath; window.mockRemote.directories[`${root}/projects`].push({name: "space 中文'job.PY", type:'file', path:`${root}/projects/space 中文'job.PY`}); });
  const win = await openDesktopFolder(page, 'projects'); await clearMessages(page);
  await win.locator('.entry').filter({hasText:"space 中文'job.PY"}).dblclick();
  const file = await waitForMessage(page, 'openTerminal');
  assert.equal(file.filePath, `${remoteRoot}/projects/space 中文'job.PY`); assert.equal(file.path, `${remoteRoot}/projects`);
}));

test('Ctrl Alt T opens one desktop terminal in the focused directory and never sends the chord to xterm', () => scenario('terminal-shortcut-007', async page => {
  await page.keyboard.press('Control+Alt+t');
  const first = await waitForMessage(page, 'openTerminal'); assert.equal(first.program, 'shell'); assert.equal(first.path, remoteRoot);
  const terminal = page.locator(`.terminal-window[data-window-id="${first.id}"]`);
  await receive(page, { type: 'terminalOpened', id: first.id, program: 'shell', cwd: remoteRoot });
  await terminal.locator('.xterm-helper-textarea').focus(); await clearMessages(page);
  await page.keyboard.press('Control+Alt+t');
  assert.equal((await messages(page, 'openTerminal')).length, 1);
  assert.equal((await messages(page, 'terminalInput')).length, 0);
  while (await page.locator('.terminal-window').count()) await windowAction(page.locator('.terminal-window').last(), 'close').click();
  const explorer = await openDesktopFolder(page, 'projects');
  await explorer.locator('.window-path').focus(); await clearMessages(page);
  await page.keyboard.press('Control+Alt+t');
  assert.equal((await waitForMessage(page, 'openTerminal')).path, `${remoteRoot}/projects`);
  await page.locator('#desktopSettings').click(); await clearMessages(page);
  await page.keyboard.press('Control+Alt+t');
  assert.equal((await messages(page, 'openTerminal')).length, 0);
}));

test('Settings cancel and failed save leave the desktop unchanged and permit retry', () => scenario('settings-failure-006', async page => {
  await page.locator('#desktopSettings').click();
  await page.locator('#settingsWallpaper').selectOption('slate');
  await page.locator('#cancelSettings').click();
  assert.equal((await messages(page, 'saveDesktopConfig')).length, 0);
  assert.equal(await page.locator('#desktop').getAttribute('data-wallpaper'), 'teal');
  await page.locator('#desktopSettings').click();
  assert.equal(await page.locator('#settingsWallpaper').inputValue(), 'teal');
  await page.locator('#settingsWallpaper').selectOption('slate');
  await page.locator('#applySettings').click();
  const failed = await waitForMessage(page, 'saveDesktopConfig');
  await receive(page, { type: 'configSaved', requestId: failed.requestId, ok: false, error: 'Permission denied' });
  assert.equal(await page.locator('#settingsError').textContent(), 'Permission denied');
  assert.equal(await page.locator('#desktop').getAttribute('data-wallpaper'), 'teal');
  assert.equal(await page.locator('#applySettings').isDisabled(), false);
  await clearMessages(page); await page.locator('#applySettings').click();
  const retry = await waitForMessage(page, 'saveDesktopConfig');
  assert.notEqual(retry.requestId, failed.requestId);
  await receive(page, { type: 'configSaved', requestId: failed.requestId, ok: true });
  assert.ok(await page.locator('#settingsDialog').isVisible());
  await receive(page, { type: 'configSaved', requestId: retry.requestId, ok: true });
  assert.equal(await page.locator('#desktop').getAttribute('data-wallpaper'), 'slate');
}));

test('Refreshed hidden-file preferences clear invisible selections and removed fields restore defaults', () => scenario('settings-hidden-selection-006', async page => {
  await page.evaluate(() => {
    const root = window.mockRemote.rootPath;
    window.mockRemote.directories[root].push({ name: '.hidden', type: 'file', path: `${root}/.hidden` });
    window.sendRemoteState(true);
  });
  await desktopIcon(page, '.hidden').click();
  await page.evaluate(() => {
    window.mockRemote.config.showHiddenFiles = false;
    window.mockRemote.config.wallpaper = 'purple';
    window.sendRemoteState(true);
  });
  assert.equal(await desktopIcon(page, '.hidden').count(), 0);
  await clearMessages(page); await page.keyboard.press('Delete');
  await desktopMenu(page);
  assert.equal(await page.locator('#context [data-action="delete"]').isDisabled(), true);
  assert.equal((await messages(page, 'fileOperation')).length, 0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { delete window.mockRemote.config.wallpaper; delete window.mockRemote.config.showHiddenFiles; window.sendRemoteState(true); });
  await desktopIcon(page, '.hidden').waitFor();
  assert.equal(await page.locator('#desktop').getAttribute('data-wallpaper'), 'teal');
}));

test('Settings retry retains pending icon positions without applying failed preferences on cancel', () => scenario('settings-retry-layout-006', async page => {
  // Freeze the 220ms layout debounce so a real drag and settings submit share
  // one request, matching a user opening settings immediately after a drag.
  await page.clock.pauseAt(new Date());
  const icon = desktopIcon(page, 'notes.txt'); const box = await icon.boundingBox();
  await page.mouse.move(box.x + 40, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + 152, box.y + 142, { steps: 6 }); await page.mouse.up();
  await page.locator('#desktopSettings').click(); await page.locator('#settingsWallpaper').selectOption('purple');
  await page.locator('#applySettings').click();
  const failed = await waitForMessage(page, 'saveDesktopConfig');
  assert.ok(failed.config.positions?.[`${remoteRoot}/notes.txt`]);
  await receive(page, { type: 'configSaved', requestId: failed.requestId, ok: false, error: 'Permission denied' });
  await page.locator('#cancelSettings').click();
  assert.equal(await page.locator('#desktop').getAttribute('data-wallpaper'), 'teal');
  await page.locator('#desktopSettings').click();
  assert.equal(await page.locator('#settingsWallpaper').inputValue(), 'teal');
  await clearMessages(page); await page.locator('#applySettings').click();
  const retry = await waitForMessage(page, 'saveDesktopConfig');
  assert.deepEqual(retry.config.positions, failed.config.positions);
  assert.equal(retry.config.wallpaper, 'teal');
  await receive(page, { type: 'configSaved', requestId: retry.requestId, ok: true });
}, { clock: true }));

test('Remote preferences override cached local values on reopening and local demo preferences survive reload', async () => {
  await scenario('settings-remote-reload-006', async page => {
    await page.evaluate(() => localStorage.setItem('demo-state', JSON.stringify({ wallpaper: 'slate', showHiddenFiles: true, viewMode: 'details' })));
    await page.reload(); await desktopIcon(page, 'projects').waitFor();
    await page.locator('#desktopSettings').click();
    assert.equal(await page.locator('#settingsWallpaper').inputValue(), 'purple');
    assert.equal(await page.locator('#settingsHidden').isChecked(), false);
    assert.equal(await page.locator('#settingsViewMode').inputValue(), 'icons');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settingsDialog').isVisible(), false);
  }, { config: { wallpaper: 'purple', showHiddenFiles: false, viewMode: 'icons' } });
  await scenario('settings-local-reload-006', async page => {
    await receive(page, { type: 'remoteState', status: 'local' });
    await page.locator('#desktopSettings').click();
    await page.locator('#settingsWallpaper').selectOption('slate');
    await page.locator('#settingsHidden').uncheck(); await page.locator('#applySettings').click();
    assert.equal((await messages(page, 'saveDesktopConfig')).length, 0);
    await page.reload(); await receive(page, { type: 'remoteState', status: 'local' });
    await page.locator('#desktopSettings').click();
    assert.equal(await page.locator('#settingsWallpaper').inputValue(), 'slate');
    assert.equal(await page.locator('#settingsHidden').isChecked(), false);
  }, { remote: false });
});

test('Fullscreen errors reenable the icon and container changes relayout maximized windows', () => scenario('fullscreen-fit-006', async page => {
  const win = await openDesktopFolder(page, 'projects');
  await windowAction(win, 'maximize').click();
  await page.locator('#fullscreen').click(); await waitForMessage(page, 'toggleFullscreen');
  await receive(page, { type: 'fullscreenResult', ok: false, message: 'Command failed' });
  assert.equal(await page.locator('#fullscreen').isDisabled(), false);
  assert.equal(await page.locator('#notice').textContent(), 'Command failed');
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 700, height: 500 }]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => Math.abs(document.querySelector('.window.maximized').clientWidth + 10 - document.querySelector('#windows').clientWidth) < 2);
    const desktop = await page.locator('#desktop').boundingBox();
    const box = await win.boundingBox();
    assert.ok(Math.abs(desktop.x + desktop.width - viewport.width) <= 1);
    assert.ok(Math.abs(desktop.height + 32 - viewport.height) <= 1);
    assert.ok(box.x >= desktop.x && box.x + box.width <= viewport.width);
  }
  // A VS Code dock/side panel can change the container without window.resize.
  await page.locator('#dock').evaluate(element => { element.style.width = '120px'; });
  await page.waitForFunction(() => Math.abs(document.querySelector('.window.maximized').offsetWidth + 8 - document.querySelector('#windows').clientWidth) < 2);
}));
async function desktopMenu(page) {
  const box = await page.locator('#desktop').boundingBox();
  await page.locator('#desktop').click({ button: 'right', position: { x: box.width - 16, y: box.height - 64 } });
  await page.locator('#context').waitFor();
}
async function desktopAction(page, action) {
  await desktopMenu(page);
  await page.locator(`#context [data-action="${action}"]`).click();
}
async function listingMenu(win) {
  const listing = win.locator('.listing');
  const box = await listing.boundingBox();
  await listing.click({ button: 'right', position: { x: box.width - 12, y: box.height - 12 } });
}
async function assertNoViewportOverflow(page) {
  const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, windows: [...document.querySelectorAll('.window:not([hidden])')].map(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; }) }));
  assert.ok(layout.documentWidth <= layout.width + 1, 'The page must not overflow horizontally');
  for (const rect of layout.windows) {
    assert.ok(rect.left >= 0 && rect.right <= layout.width + 1, 'Window controls must remain within the viewport');
    assert.ok(rect.top >= 0 && rect.bottom <= layout.height + 1, 'Window content must remain within the viewport');
  }
}

test('Remote state replaces demo files and identifies filesystem symlinks', () => scenario('remote-desktop', async page => {
  assert.equal(await page.locator('.dock').count(), 1);
  assert.equal(await page.locator('.tree').count(), 0);
  assert.equal(await page.locator('#icons .icon').count(), 6);
  assert.equal(await page.locator('#icons [data-path^="/home/demo/"]').count(), 0);
  assert.match(await page.locator('#connection').innerText(), /Remote-SSH/);
  assert.equal(await desktopIcon(page, 'notes-link.txt').locator('.shortcut-mark').count(), 1);
  assert.equal(await desktopIcon(page, 'project-link').locator('.shortcut-mark').count(), 1);
  await assertNoViewportOverflow(page);
  await page.screenshot({ path: path.join(artifacts, 'feedback-desktop.png'), fullPage: true });
}));
test('F5 reloads the remote desktop and open directory without reopening the panel', () => scenario('remote-refresh', async page => {
  const win = await openDesktopFolder(page, 'projects');
  await clearMessages(page);
  await page.evaluate(({ rootEntry, childEntry }) => { window.mockRemote.directories[window.mockRemote.rootPath].push(rootEntry); window.mockRemote.directories[`${window.mockRemote.rootPath}/projects`].push(childEntry); }, { rootEntry: entry(remoteRoot, 'created-in-terminal.txt'), childEntry: entry(`${remoteRoot}/projects`, 'also-new.txt') });
  await page.locator('#desktop').click({ position: { x: 1100, y: 740 } });
  await page.keyboard.press('F5');
  await waitForMessage(page, 'refreshRemote');
  await desktopIcon(page, 'created-in-terminal.txt').waitFor();
  await windowEntry(win, `${remoteRoot}/projects`, 'also-new.txt').waitFor();
  assert.ok((await messages(page, 'readDirectory')).some(message => message.path === `${remoteRoot}/projects`));
  assert.equal(await page.locator('.window:visible').count(), 1);
}));
test('Remote view configuration is applied on load and refresh with real icon geometry', () => scenario('configured-view', async page => {
  const win = await openDesktopFolder(page, 'projects');
  const item = windowEntry(win, `${remoteRoot}/projects`, 'source.txt');
  assert.equal(await win.locator('.listing.icon-view').count(), 1);
  const iconSize = await item.locator('.glyph').boundingBox();
  assert.equal(await item.locator('.entry-type').isVisible(), false);
  await page.evaluate(() => { window.mockRemote.config.viewMode = 'details'; });
  await desktopAction(page, 'refresh');
  await page.waitForFunction(() => !document.querySelector('.window .listing.icon-view'));
  const detailSize = await item.locator('.glyph').boundingBox();
  assert.ok(iconSize.width >= detailSize.width * 1.5, 'Icon view must use visibly larger file icons');
  assert.ok(await item.locator('.entry-type').isVisible());
  assert.ok(await item.locator('.entry-size').isVisible());
  const name = await item.locator('.entry-name').boundingBox(), type = await item.locator('.entry-type').boundingBox(), size = await item.locator('.entry-size').boundingBox();
  assert.ok(name.x < type.x && type.x < size.x, 'Details must have separate name, type and size columns');
  await windowAction(win, 'icons').click();
  await waitForMessage(page, 'saveDesktopConfig');
  assert.equal((await messages(page, 'saveDesktopConfig')).at(-1).config.viewMode, 'icons');
  await windowAction(win, 'details').click();
  assert.equal(await win.locator('.listing.icon-view').count(), 0);
}, { config: { viewMode: 'icons' } }));
test('Folder navigation stays in its virtual window and files open through VS Code', () => scenario('folder-navigation', async page => {
  const win = await openDesktopFolder(page, 'projects');
  await windowEntry(win, `${remoteRoot}/projects`, 'nested').dblclick();
  await windowEntry(win, `${remoteRoot}/projects/nested`, 'deep.txt').waitFor();
  assert.equal(await page.locator('.window:visible').count(), 1);
  assert.equal((await messages(page, 'openResource')).length, 0);
  await windowEntry(win, `${remoteRoot}/projects/nested`, 'deep.txt').dblclick();
  const request = await waitForMessage(page, 'openResource');
  assert.equal(request.path, `${remoteRoot}/projects/nested/deep.txt`);
  assert.equal(request.kind, 'file');
  assert.match(request.uri, /^vscode-remote:\/\/ssh-remote\+test\//);
  await windowAction(win, 'up').click();
  await windowEntry(win, `${remoteRoot}/projects`, 'nested').waitFor();
  await windowAction(win, 'back').click();
  await windowEntry(win, `${remoteRoot}/projects/nested`, 'deep.txt').waitFor();
  await windowAction(win, 'forward').click();
  await windowEntry(win, `${remoteRoot}/projects`, 'source.txt').waitFor();
}));
test('Desktop creates a named folder only after Enter and reloads after host success', () => scenario('inline-create-desktop', async page => {
  await openDesktopFolder(page, 'projects');
  await desktopMenu(page);
  await page.locator('#context [data-action="new-folder"]').click();
  const editor = page.locator('#icons input.name-editor');
  await editor.waitFor();
  assert.equal(await editor.inputValue(), 'New Folder');
  assert.equal((await messages(page, 'fileOperation')).length, 0);
  await editor.fill('new remote folder');
  assert.equal((await messages(page, 'fileOperation')).length, 0);
  await editor.press('Enter');
  const request = await waitForMessage(page, 'fileOperation', 'new-folder');
  assert.equal(request.name, 'new remote folder');
  assert.equal(request.parent, remoteRoot);
  assert.ok(request.requestId);
  await page.evaluate(item => window.mockRemote.directories[window.mockRemote.rootPath].push(item), entry(remoteRoot, 'new remote folder', 'folder'));
  await receive(page, { type: 'operationResult', success: true, requestId: request.requestId, affectedPaths: [remoteRoot] });
  await desktopIcon(page, 'new remote folder').waitFor();
  assert.ok((await messages(page, 'readDirectory')).some(message => message.path === remoteRoot));
  assert.equal((await messages(page, 'refreshRemote')).length, 0, 'File creation must not reload view configuration');
  assert.equal(await page.locator('input.name-editor').count(), 0);
  await clearMessages(page);
  await desktopMenu(page);
  await page.locator('#context [data-action="new-file"]').click();
  assert.equal(await page.locator('input.name-editor').inputValue(), 'New File.txt');
  await page.locator('input.name-editor').fill('cancelled.txt');
  await page.locator('input.name-editor').press('Escape');
  assert.equal((await messages(page, 'fileOperation')).length, 0);
  assert.equal(await page.locator('input.name-editor').count(), 0);
}));
test('Explorer shares the context menu and uses its own directory for inline creation and rename', () => scenario('inline-create-explorer', async page => {
  await desktopMenu(page);
  const desktopActions = await page.locator('#context [data-action]').evaluateAll(elements => elements.map(element => element.dataset.action));
  await page.keyboard.press('Escape');
  const win = await openDesktopFolder(page, 'projects');
  await listingMenu(win);
  assert.deepEqual(await page.locator('#context [data-action]').evaluateAll(elements => elements.map(element => element.dataset.action)), desktopActions);
  for (const action of ['new-file', 'new-folder', 'rename', 'copy', 'paste', 'delete', 'shortcut', 'command-shortcut']) assert.ok(desktopActions.includes(action));
  await page.locator('#context [data-action="new-file"]').click();
  const editor = win.locator('input.name-editor');
  await editor.fill('new-file.txt');
  assert.equal((await messages(page, 'fileOperation')).length, 0);
  await editor.press('Enter');
  const created = await waitForMessage(page, 'fileOperation', 'new-file');
  assert.equal(created.parent, `${remoteRoot}/projects`);
  await page.evaluate(item => window.mockRemote.directories[`${window.mockRemote.rootPath}/projects`].push(item), entry(`${remoteRoot}/projects`, 'new-file.txt'));
  await receive(page, { type: 'operationResult', requestId: created.requestId, success: true, affectedPaths: [`${remoteRoot}/projects`] });
  await windowEntry(win, `${remoteRoot}/projects`, 'new-file.txt').waitFor();
  await clearMessages(page);
  await windowEntry(win, `${remoteRoot}/projects`, 'new-file.txt').click({ button: 'right' });
  await page.locator('#context [data-action="rename"]').click();
  await win.locator('input.name-editor').fill('renamed.txt');
  assert.equal((await messages(page, 'fileOperation')).length, 0);
  await win.locator('input.name-editor').press('Enter');
  const renamed = await waitForMessage(page, 'fileOperation', 'rename');
  assert.equal(renamed.name, 'renamed.txt');
  assert.deepEqual(renamed.paths, [`${remoteRoot}/projects/new-file.txt`]);
}));
test('Multi-select copy and paste sends both source paths to the destination directory', () => scenario('multi-copy', async page => {
  await desktopIcon(page, 'notes.txt').click();
  await desktopIcon(page, 'run.sh').click({ modifiers: ['Control'] });
  await desktopIcon(page, 'run.sh').click({ button: 'right' });
  await page.locator('#context [data-action="copy"]').click();
  const win = await openDesktopFolder(page, 'results');
  await listingMenu(win);
  await page.locator('#context [data-action="paste"]').click();
  const request = await waitForMessage(page, 'fileOperation', 'paste');
  assert.equal(request.parent, `${remoteRoot}/results`);
  assert.equal(request.clipboard.mode, 'copy');
  assert.deepEqual(request.clipboard.paths.sort(), [`${remoteRoot}/notes.txt`, `${remoteRoot}/run.sh`]);
  await page.evaluate(entries => { window.mockRemote.directories[`${window.mockRemote.rootPath}/results`] = entries; }, [entry(`${remoteRoot}/results`, 'notes.txt'), entry(`${remoteRoot}/results`, 'run.sh')]);
  await receive(page, { type: 'operationResult', requestId: request.requestId, success: true, affectedPaths: [`${remoteRoot}/results`] });
  await windowEntry(win, `${remoteRoot}/results`, 'notes.txt').waitFor();
  await windowEntry(win, `${remoteRoot}/results`, 'run.sh').waitFor();
  assert.equal(await desktopIcon(page, 'notes.txt').count(), 1);
  assert.equal(await desktopIcon(page, 'run.sh').count(), 1);
}));
test('Desktop marquee selects multiple targets and right-click keeps that selection', () => scenario('marquee', async page => {
  const icons = page.locator('#icons .icon');
  const first = await icons.nth(0).boundingBox(), second = await icons.nth(1).boundingBox(), surface = await page.locator('#icons').boundingBox();
  const left = Math.max(surface.x + 1, Math.min(first.x, second.x) - 3), top = Math.max(surface.y + 1, Math.min(first.y, second.y) - 3);
  const right = Math.max(first.x + first.width, second.x + second.width) + 3, bottom = Math.max(first.y + first.height, second.y + second.height) + 3;
  await page.mouse.move(right, bottom);
  await page.mouse.down();
  await page.mouse.move(left, top, { steps: 12 });
  await page.mouse.up();
  assert.ok(await page.locator('#icons .icon.selected').count() >= 2);
  const selected = await page.locator('#icons .icon.selected').evaluateAll(elements => elements.map(element => element.dataset.path));
  await page.locator('#icons .icon.selected').first().click({ button: 'right' });
  await page.locator('#context [data-action="copy"]').click();
  await desktopMenu(page);
  await page.locator('#context [data-action="paste"]').click();
  assert.deepEqual((await waitForMessage(page, 'fileOperation', 'paste')).clipboard.paths.sort(), selected.sort());
}));
test('Desktop pointer drag moves an icon into a new grid cell and persists position', () => scenario('grid-drag', async page => {
  const icon = desktopIcon(page, 'notes.txt');
  const before = await icon.boundingBox();
  await page.mouse.move(before.x + 35, before.y + 30);
  await page.mouse.down();
  await page.mouse.move(before.x + 274, before.y + 235, { steps: 15 });
  await page.mouse.up();
  const after = await icon.boundingBox();
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) >= 112, 'Dragging must actually change position');
  assert.equal((after.x - before.x) % 112, 0, 'Horizontal movement must snap to grid cells');
  assert.equal((after.y - before.y) % 112, 0, 'Vertical movement must snap to grid cells');
  const saveRequest = await waitForMessage(page, 'saveDesktopConfig');
  const position = saveRequest.config.positions[`${remoteRoot}/notes.txt`];
  assert.ok(position && Number.isFinite(position.x) && Number.isFinite(position.y));
  const occupied = await page.locator('#icons .icon').evaluateAll(elements => elements.map(element => `${element.style.left},${element.style.top}`));
  assert.equal(new Set(occupied).size, occupied.length, 'Grid cells must not overlap');
  await page.evaluate(config => { window.mockRemote.config = { ...window.mockRemote.config, ...config }; }, saveRequest.config);
  await desktopAction(page, 'refresh');
  const restored = await icon.boundingBox();
  assert.equal(restored.x, after.x);
  assert.equal(restored.y, after.y);
}));
test('Two real windows remain visible, minimize independently, and close removes the dock tab', () => scenario('independent-windows', async page => {
  const first = await openDesktopFolder(page, 'projects');
  const firstId = await first.getAttribute('data-window-id');
  await page.locator('#newWindow').click();
  assert.equal(await page.locator('.window:visible').count(), 2);
  assert.equal(await page.locator('.window-tab').count(), 2);
  const second = page.locator(`.window:not([data-window-id="${firstId}"])`);
  const secondId = await second.getAttribute('data-window-id');
  assert.notEqual(firstId, secondId);
  await windowAction(second, 'minimize').click();
  assert.equal(await page.locator('.window:visible').count(), 1);
  assert.equal(await page.locator('.window-tab').count(), 2);
  await page.locator(`.window-tab[data-window-id="${secondId}"]`).click();
  assert.equal(await page.locator('.window:visible').count(), 2);
  await windowAction(second, 'close').click();
  assert.equal(await page.locator(`.window[data-window-id="${secondId}"]`).count(), 0);
  assert.equal(await page.locator(`.window-tab[data-window-id="${secondId}"]`).count(), 0);
  assert.equal(await page.locator(`.window[data-window-id="${firstId}"]:visible`).count(), 1);
  await page.locator('#newWindow').click();
  const comparison = page.locator(`.window:not([data-window-id="${firstId}"])`);
  await windowAction(comparison, 'icons').click();
  const title = await comparison.locator('.titlebar').boundingBox();
  await page.mouse.move(title.x + 120, title.y + 16);
  await page.mouse.down();
  await page.mouse.move(880, 173, { steps: 12 });
  await page.mouse.up();
  await assertNoViewportOverflow(page);
  await page.screenshot({ path: path.join(artifacts, 'feedback-windows.png'), fullPage: true });
}));
test('Dragging between separate window listings requests a move and refreshes both directories', () => scenario('cross-window-move', async page => {
  const source = await openDesktopFolder(page, 'projects');
  const sourceId = await source.getAttribute('data-window-id');
  await windowAction(source, 'minimize').click();
  const target = await openDesktopFolder(page, 'results');
  const targetId = await target.getAttribute('data-window-id');
  assert.notEqual(sourceId, targetId);
  const title = await target.locator('.titlebar').boundingBox();
  await page.mouse.move(title.x + 120, title.y + 16);
  await page.mouse.down();
  await page.mouse.move(1150, 240, { steps: 15 });
  await page.mouse.up();
  await page.locator(`.window-tab[data-window-id="${sourceId}"]`).click();
  const sourceWindow = page.locator(`.window[data-window-id="${sourceId}"]`), targetWindow = page.locator(`.window[data-window-id="${targetId}"]`);
  const listing = targetWindow.locator('.listing'), targetBox = await listing.boundingBox();
  await windowEntry(sourceWindow, `${remoteRoot}/projects`, 'source.txt').dragTo(listing, { targetPosition: { x: targetBox.width - 24, y: targetBox.height - 24 } });
  const request = await waitForMessage(page, 'fileOperation', 'paste');
  assert.equal(request.parent, `${remoteRoot}/results`);
  assert.equal(request.clipboard.mode, 'move');
  assert.deepEqual(request.clipboard.paths, [`${remoteRoot}/projects/source.txt`]);
  await page.evaluate(item => { const project = `${window.mockRemote.rootPath}/projects`; window.mockRemote.directories[project] = window.mockRemote.directories[project].filter(value => value.name !== 'source.txt'); window.mockRemote.directories[`${window.mockRemote.rootPath}/results`].push(item); }, entry(`${remoteRoot}/results`, 'source.txt'));
  await receive(page, { type: 'operationResult', requestId: request.requestId, success: true, affectedPaths: [`${remoteRoot}/projects`, `${remoteRoot}/results`] });
  await windowEntry(targetWindow, `${remoteRoot}/results`, 'source.txt').waitFor();
  assert.equal(await windowEntry(sourceWindow, `${remoteRoot}/projects`, 'source.txt').count(), 0);
}, { viewport: { width: 1900, height: 1050 } }));
test('Command shortcut creation uses the extension and survives a new webview state', () => scenario('command-shortcut', async page => {
  await desktopMenu(page);
  await page.locator('#context [data-action="command-shortcut"]').click();
  await waitForMessage(page, 'createCommandShortcut');
  const config = { viewMode: 'details', positions: {}, shortcuts: [{ id: 'command-palette', kind: 'command', command: 'workbench.action.showCommands', label: 'Command Palette' }] };
  await page.evaluate(value => { window.mockRemote.config = value; }, config);
  await receive(page, { type: 'configUpdated', config });
  const shortcut = page.locator('#icons .icon').filter({ hasText: 'Command Palette' });
  await shortcut.waitFor();
  await shortcut.dblclick();
  assert.equal((await waitForMessage(page, 'executeCommand')).command, 'workbench.action.showCommands');
  await page.evaluate(() => localStorage.removeItem('demo-state'));
  await page.reload();
  await receive(page, { type: 'remoteState', status: 'ready', rootPath: remoteRoot, folder: remoteRoot, entries: fixture().directories[remoteRoot], config });
  await shortcut.waitFor();
  await shortcut.dblclick();
  assert.equal((await messages(page, 'executeCommand')).at(-1).command, 'workbench.action.showCommands');
}));
test('Send to desktop requests a filesystem shortcut and reload recognizes it without stored webview state', () => scenario('filesystem-shortcut', async page => {
  const win = await openDesktopFolder(page, 'projects');
  await windowEntry(win, `${remoteRoot}/projects`, 'source.txt').click({ button: 'right' });
  await page.locator('#context [data-action="shortcut"]').click();
  const request = await waitForMessage(page, 'fileOperation', 'shortcut');
  assert.deepEqual(request.paths, [`${remoteRoot}/projects/source.txt`]);
  const link = entry(remoteRoot, 'source.txt', 'file', { isSymbolicLink: true });
  await page.evaluate(item => window.mockRemote.directories[window.mockRemote.rootPath].push(item), link);
  await receive(page, { type: 'operationResult', requestId: request.requestId, success: true, affectedPaths: [remoteRoot] });
  await desktopIcon(page, 'source.txt').waitFor();
  assert.equal(await desktopIcon(page, 'source.txt').locator('.shortcut-mark').count(), 1);
  await page.evaluate(() => localStorage.removeItem('demo-state'));
  await page.reload();
  await receive(page, { type: 'remoteState', status: 'ready', rootPath: remoteRoot, folder: remoteRoot, entries: [...fixture().directories[remoteRoot], link], config: fixture().config });
  await desktopIcon(page, 'source.txt').waitFor();
  assert.equal(await desktopIcon(page, 'source.txt').locator('.shortcut-mark').count(), 1);
  await desktopIcon(page, 'source.txt').dblclick();
  assert.equal((await waitForMessage(page, 'openResource')).path, `${remoteRoot}/source.txt`);
}));
test('Failed file operations expose their error without a fake successful update', () => scenario('operation-failure', async page => {
  await desktopIcon(page, 'notes.txt').click({ button: 'right' });
  await page.locator('#context [data-action="delete"]').click();
  const request = await waitForMessage(page, 'fileOperation', 'delete');
  await receive(page, { type: 'operationResult', requestId: request.requestId, success: false, error: 'Permission denied for test fixture' });
  assert.match(await page.locator('#notice').innerText(), /Permission denied/);
  assert.equal(await desktopIcon(page, 'notes.txt').count(), 1);
}));

test('Command shortcut rename and delete wait for persisted host configuration', () => scenario('command-edit', async page => {
  const shortcut = { id: 'edit-command', kind: 'command', command: 'workbench.action.showCommands', label: 'Original command' };
  const config = { viewMode: 'details', positions: {}, shortcuts: [shortcut] };
  await receive(page, { type: 'configUpdated', config });
  const icon = page.locator('#icons .icon[data-id="edit-command"]');
  await icon.click({ button: 'right' });
  await page.locator('#context [data-action="rename"]').click();
  await page.locator('input.name-editor').fill('Renamed command');
  await page.locator('input.name-editor').press('Enter');
  const rename = await waitForMessage(page, 'renameCommandShortcut');
  assert.equal(rename.id, shortcut.id);
  assert.equal(rename.label, 'Renamed command');
  await receive(page, { type: 'configUpdated', config: { ...config, shortcuts: [{ ...shortcut, label: rename.label }] } });
  assert.match(await icon.textContent(), /Renamed command/);
  await icon.click({ button: 'right' });
  await page.locator('#context [data-action="delete"]').click();
  assert.equal((await waitForMessage(page, 'deleteCommandShortcut')).id, shortcut.id);
  assert.equal(await icon.count(), 1, 'Keep the icon until the backend confirms its removal');
  await receive(page, { type: 'configUpdated', config: { ...config, shortcuts: [] } });
  assert.equal(await icon.count(), 0);
}));
test('Small viewport keeps the desktop and window controls accessible', () => scenario('mobile-layout', async page => {
  const win = await openDesktopFolder(page, 'projects');
  await windowAction(win, 'icons').click();
  await assertNoViewportOverflow(page);
  assert.ok(await windowAction(win, 'close').isVisible());
  await page.screenshot({ path: path.join(artifacts, 'feedback-mobile.png'), fullPage: true });
}, { viewport: { width: 390, height: 844 } }));
test('Terminal request carries a directory and no shell command', () => scenario('terminal', async page => {
  await desktopAction(page, 'terminal');
  const request = await waitForMessage(page, 'openTerminal');
  assert.equal(request.command, undefined);
  assert.ok(typeof request.path === 'string');
}));

test('Embedded xterm renders remote TUI output, passes keys, resizes and closes its session', () => scenario('embedded-terminal', async page => {
  await desktopIcon(page, 'notes.txt').click();
  await desktopAction(page, 'terminal');
  const request = await waitForMessage(page, 'openTerminal');
  assert.equal(request.path, remoteRoot);
  assert.equal(request.program, 'shell');
  assert.ok(request.cols > 20 && request.rows > 5);
  const terminal = page.locator(`.terminal-window[data-window-id="${request.id}"]`);
  await terminal.locator('.xterm').waitFor();
  await receive(page, { type: 'terminalOpened', id: request.id, program: 'shell', cwd: remoteRoot, pid: 101 });
  await receive(page, { type: 'terminalData', id: request.id, data: '\x1b[?1049h\x1b[2J\x1b[H\x1b[32mRemote TUI\x1b[0m\r\nserver content' });
  await page.waitForFunction(() => document.querySelector('.terminal-surface').textContent.includes('Remote TUI'));
  assert.match(await terminal.locator('.terminal-surface').textContent(), /server content/);
  await terminal.locator('textarea').focus();
  await page.keyboard.type('vim-input');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+c');
  await page.waitForFunction(() => window.demoMessages.some(message => message.type === 'terminalInput' && message.data === '\x03'));
  const input = (await messages(page, 'terminalInput')).map(message => message.data).join('');
  assert.match(input, /vim-input/);
  assert.ok(input.includes('\x1b[3~'), 'Delete must reach the terminal PTY');
  assert.equal((await messages(page, 'fileOperation')).length, 0, 'Terminal keys must not delete selected desktop files');
  await windowAction(terminal, 'maximize').click();
  await page.waitForFunction(initial => window.demoMessages.some(message => message.type === 'terminalResize' && message.cols > initial), request.cols);
  await windowAction(terminal, 'maximize').click();
  await page.waitForTimeout(60);
  await clearMessages(page);
  const beforeResize = await terminal.boundingBox();
  const corner = await terminal.locator('.resize-handle[data-resize="se"]').boundingBox();
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width / 2 + 100, corner.y + corner.height / 2 + 80, { steps: 8 });
  await page.mouse.up();
  const resized = await terminal.boundingBox();
  assert.ok(resized.width > beforeResize.width && resized.height > beforeResize.height);
  await page.waitForFunction(initial => window.demoMessages.some(message => message.type === 'terminalResize' && message.cols > initial.cols && message.rows > initial.rows), request);
  await receive(page, { type: 'configUpdated', config: { pinnedApps: [{ id: 'vim', label: 'Vim', program: 'vim' }] } });
  assert.match(await terminal.locator('.terminal-surface').textContent(), /Remote TUI/, 'Configuration updates must retain the xterm screen');
  await windowAction(terminal, 'minimize').click();
  assert.equal(await terminal.isVisible(), false);
  await page.locator(`.window-tab[data-window-id="${request.id}"]`).click();
  assert.equal(await terminal.isVisible(), true);
  await page.screenshot({ path: path.join(artifacts, 'embedded-terminal.png'), fullPage: true });
  await windowAction(terminal, 'close').click();
  assert.equal((await waitForMessage(page, 'terminalClose')).id, request.id);
  assert.equal(await page.locator('.terminal-window').count(), 0);
  assert.equal(await page.locator(`.window-tab[data-window-id="${request.id}"]`).count(), 0);
}));

test('Vim and htop launch in desktop windows, pin persists, and reload never executes a program', () => scenario('pinned-programs', async page => {
  await desktopAction(page, 'terminal');
  await page.locator('.terminal-window [data-terminal-program="vim"]').click();
  await page.waitForFunction(() => window.demoMessages.some(message => message.type === 'openTerminal' && message.program === 'vim'));
  const vim = page.locator('.terminal-window[data-program="vim"]');
  const vimId = await vim.getAttribute('data-window-id');
  assert.equal(await vim.locator('[data-window-action="pin"], .terminal-pin').count(), 0);
  await page.locator(`.window-tab[data-window-id="${vimId}"]`).click({ button: 'right' });
  await page.locator('#appContext #togglePinApp').click();
  const pin = await waitForMessage(page, 'pinApp');
  assert.equal(pin.app.program, 'vim');
  assert.equal(await page.locator('.pinned-app').count(), 0, 'Wait for persisted host configuration before showing a pin');
  const config = { pinnedApps: [{ id: 'pinned-vim', label: 'Vim', program: 'vim' }] };
  await page.evaluate(value => { window.mockRemote.config = value; }, config);
  await receive(page, { type: 'configUpdated', config });
  await page.locator('.pinned-app[data-app-id="pinned-vim"]').waitFor();
  await vim.locator('[data-terminal-program="htop"]').click();
  const htopRequest = (await messages(page, 'openTerminal')).at(-1);
  assert.equal(htopRequest.program, 'htop');
  await receive(page, { type: 'terminalError', id: htopRequest.id, error: 'htop is not installed' });
  assert.match(await page.locator('.terminal-window[data-program="htop"] .terminal-status').textContent(), /htop is not installed/);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('demo-state')));
  assert.ok(saved.windows.every(win => win.kind !== 'terminal'), 'Running processes must not be restored automatically');
  await page.reload();
  await receive(page, { type: 'configUpdated', config });
  await page.locator('.pinned-app[data-app-id="pinned-vim"]').waitFor();
  assert.equal((await messages(page, 'openTerminal')).length, 0);
  assert.equal(await page.locator('.terminal-window').count(), 0);
  await page.locator('.pinned-app[data-app-id="pinned-vim"]').click();
  const relaunch = await waitForMessage(page, 'openTerminal');
  assert.equal(relaunch.program, 'vim');
  await page.locator(`.window-tab[data-window-id="${relaunch.id}"]`).click({ button: 'right' });
  assert.match(await page.locator('#togglePinApp').textContent(), /取消固定/);
  await page.locator('#togglePinApp').click();
  assert.equal((await waitForMessage(page, 'unpinApp')).id, 'pinned-vim');
  await page.locator('.pinned-app[data-app-id="pinned-vim"]').click({ button: 'right' });
  await page.locator('#unpinApp').click();
  assert.equal((await waitForMessage(page, 'unpinApp')).id, 'pinned-vim');
  await receive(page, { type: 'configUpdated', config: { pinnedApps: [] } });
  assert.equal(await page.locator('.pinned-app').count(), 0);
}));

test('Server identity and clock use supplied remote time and timezone without local fallback', () => scenario('server-status', async page => {
  assert.equal(await page.locator('#serverClock').textContent(), '服务器时间 —');
  await receive(page, { type: 'serverInfo', username: 'remote-tester', hostname: 'compute-01', epochMs: Date.UTC(2020, 0, 1, 0, 1, 2), timeZone: 'Asia/Shanghai', remote: true, available: true });
  assert.equal(await page.locator('#accountName').textContent(), 'remote-tester');
  assert.equal(await page.locator('#accountName').getAttribute('title'), 'remote-tester@compute-01');
  assert.match(await page.locator('#connection').textContent(), /已连接/);
  assert.match(await page.locator('#serverClock').textContent(), /^08:01:0[23]$/);
  await page.waitForFunction(() => document.querySelector('#serverClock').textContent >= '08:01:03');
  assert.match(await page.locator('#serverClock').getAttribute('datetime'), /^2020-01-01T00:01:/);
  await receive(page, { type: 'serverInfo', username: 'remote-tester', hostname: 'compute-01', epochMs: Date.UTC(2020, 0, 1, 0, 1, 5), timeZone: 'Asia/Shanghai', remote: true, available: true });
  await page.clock.fastForward(91000);
  assert.equal(await page.locator('#serverClock').textContent(), '服务器时间 —');
  assert.match(await page.locator('#connection').textContent(), /等待服务器响应/);
  await receive(page, { type: 'serverInfo', username: 'remote-tester', hostname: 'compute-01', epochMs: Date.UTC(2020, 0, 1, 0, 2, 40), timeZone: 'Asia/Shanghai', remote: true, available: true });
  assert.match(await page.locator('#connection').textContent(), /已连接/);
  assert.equal(await page.locator('#serverClock').textContent(), '08:02:40');
  await receive(page, { type: 'serverInfo', username: null, hostname: null, epochMs: null, timeZone: null, remote: true, available: false, error: 'Wrong extension host' });
  assert.equal(await page.locator('#serverClock').textContent(), '服务器时间 —');
  assert.equal(await page.locator('#accountName').textContent(), '账号不可用');
}, { clock: true }));

test('Context refresh and terminal launch use the current explorer directory', () => scenario('context-refresh', async page => {
  const win = await openDesktopFolder(page, 'projects');
  await clearMessages(page);
  await listingMenu(win);
  await page.locator('#context [data-action="refresh"]').click();
  const refresh = await waitForMessage(page, 'readDirectory');
  assert.equal(refresh.path, `${remoteRoot}/projects`);
  assert.equal(refresh.intent, 'refresh');
  assert.equal((await messages(page, 'refreshRemote')).length, 0);
  await clearMessages(page);
  await desktopMenu(page);
  await page.locator('#context [data-action="refresh"]').click();
  assert.equal((await waitForMessage(page, 'refreshRemote')).intent, 'refresh');
  assert.equal((await waitForMessage(page, 'readDirectory')).path, `${remoteRoot}/projects`, 'Desktop refresh also reloads open directories');
  await listingMenu(win);
  await page.locator('#context [data-action="terminal"]').click();
  assert.equal((await waitForMessage(page, 'openTerminal')).path, `${remoteRoot}/projects`);
  assert.equal(await page.locator('.terminal-window').count(), 1);
}));

test('Temporary zero-sized webview layout does not overwrite window positions', () => scenario('window-position-preserved', async page => {
  const win = await openDesktopFolder(page, 'projects');
  const title = await win.locator('.titlebar').boundingBox();
  await page.mouse.move(title.x + 120, title.y + 16);
  await page.mouse.down(); await page.mouse.move(600, 320, { steps: 10 }); await page.mouse.up();
  const before = await win.boundingBox();
  await page.evaluate(() => { document.querySelector('#windows').style.display = 'none'; window.dispatchEvent(new Event('resize')); });
  await page.evaluate(() => { document.querySelector('#windows').style.display = ''; window.dispatchEvent(new Event('resize')); });
  const after = await win.boundingBox();
  assert.equal(after.x, before.x); assert.equal(after.y, before.y);
}));

test('Compact desktop bar keeps identity and centered time while desktop actions live in the context menu', () => scenario('desktop-chrome-005', async page => {
  await receive(page, { type: 'serverInfo', username: 'remote-tester', hostname: 'compute-01', epochMs: Date.UTC(2026, 8, 17, 6, 20), timeZone: 'Asia/Shanghai', remote: true, available: true });
  const bar = await page.locator('.toolbar').boundingBox();
  const account = await page.locator('#accountName').boundingBox();
  const time = await page.locator('#serverClock').boundingBox();
  assert.ok(bar.height <= 36, 'The top bar should leave the desktop more vertical room');
  assert.ok(account.x < 100);
  assert.ok(Math.abs(time.x + time.width / 2 - 720) < 2, 'Server time stays centered independently of account name width');
  assert.equal(await page.locator('.toolbar button').count(), 2);
  assert.equal(await page.locator('#fullscreen svg').count(), 1);
  assert.equal(await page.locator('#fullscreen').textContent(), '');
  await desktopMenu(page);
  for (const action of ['arrange', 'refresh', 'terminal']) assert.ok(await page.locator(`#context [data-action="${action}"]`).isVisible());
  assert.equal(await page.locator('#context [data-action="fullscreen"]').count(), 0);
  await page.locator('#context [data-action="arrange"]').click();
  await waitForMessage(page, 'saveDesktopConfig');
  await page.locator('#fullscreen').click();
  await waitForMessage(page, 'toggleFullscreen');
  assert.equal((await messages(page, 'executeCommand')).length, 0);
  await receive(page, { type: 'fullscreenResult', ok: true, message: '全屏就绪' });
  assert.equal(await page.locator('#fullscreen').isDisabled(), false);
  await page.screenshot({ path: path.join(artifacts, 'desktop-006.png'), fullPage: true });
  const win = await openDesktopFolder(page, 'projects');
  assert.equal(await win.locator('.explorer-commandbar').count(), 0);
  await listingMenu(win);
  assert.equal(await page.locator('#context [data-action="arrange"]').isVisible(), false);
  assert.equal(await page.locator('#context [data-action="fullscreen"]').isVisible(), false);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(artifacts, 'explorer-005.png'), fullPage: true });
}));

test('Editable addresses navigate absolute, relative and home paths without invoking file shortcuts', () => scenario('address-navigation-005', async page => {
  const win = await openDesktopFolder(page, 'projects');
  const address = win.locator('input[aria-label="目录地址"]');
  await windowEntry(win, `${remoteRoot}/projects`, 'source.txt').click();
  await clearMessages(page);
  await address.fill('draft text');
  await address.press('Control+a');
  await address.press('Control+c');
  await address.press('Delete');
  await address.press('Escape');
  assert.equal(await address.inputValue(), `${remoteRoot}/projects`);
  assert.equal((await messages(page, 'fileOperation')).length, 0);
  assert.equal((await messages(page, 'readDirectory')).length, 0);
  await address.fill('nested');
  await address.press('Enter');
  await windowEntry(win, `${remoteRoot}/projects/nested`, 'deep.txt').waitFor();
  const relative = await waitForMessage(page, 'readDirectory');
  assert.equal(relative.path, `${remoteRoot}/projects/nested`);
  assert.equal(relative.intent, 'navigate');
  await address.fill('../');
  await address.press('Enter');
  await windowEntry(win, `${remoteRoot}/projects`, 'source.txt').waitFor();
  await address.fill(`${remoteRoot}/results`);
  await address.press('Enter');
  await page.waitForFunction(path => document.querySelector('.window-path').value === path, `${remoteRoot}/results`);
  await address.fill('~');
  await address.press('Enter');
  await windowEntry(win, '/home/tester', 'Desktop').waitFor();
  await address.fill('~/Desktop/projects');
  await address.press('Enter');
  await windowEntry(win, `${remoteRoot}/projects`, 'source.txt').waitFor();
  await windowAction(win, 'back').click();
  await windowEntry(win, '/home/tester', 'Desktop').waitFor();
  await windowAction(win, 'forward').click();
  await windowEntry(win, `${remoteRoot}/projects`, 'source.txt').waitFor();
}));

test('Invalid addresses preserve current files and failed navigation never enters the back stack', () => scenario('address-failure-005', async page => {
  const win = await openDesktopFolder(page, 'projects');
  const address = win.locator('input[aria-label="目录地址"]');
  await address.fill(`${remoteRoot}/missing`);
  await address.press('Enter');
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('Directory does not exist'));
  assert.equal(await windowEntry(win, `${remoteRoot}/projects`, 'source.txt').count(), 1);
  await address.press('Escape');
  assert.equal(await address.inputValue(), `${remoteRoot}/projects`);
  await address.fill('nested');
  await address.press('Enter');
  await windowEntry(win, `${remoteRoot}/projects/nested`, 'deep.txt').waitFor();
  await windowAction(win, 'back').click();
  await windowEntry(win, `${remoteRoot}/projects`, 'source.txt').waitFor();
  assert.equal(await address.inputValue(), `${remoteRoot}/projects`);
}));

test('Out-of-order address responses cannot replace newer navigation or another window', () => scenario('address-race-005', async page => {
  const first = await openDesktopFolder(page, 'projects');
  const firstId = await first.getAttribute('data-window-id');
  await page.locator('#newWindow').click();
  const second = page.locator(`.window:not([data-window-id="${firstId}"])`);
  await second.waitFor();
  await page.evaluate(() => { window.mockRemotePaused = true; });
  await clearMessages(page);
  const submit = async (win, path) => {
    await win.locator('.window-path').fill(path);
    await win.locator('.window-path').press('Enter');
    return waitForMessage(page, 'readDirectory');
  };
  // Move the front window away so both address bars remain pointer-accessible.
  const title = await second.locator('.titlebar').boundingBox();
  await page.mouse.move(title.x + 110, title.y + 18);
  await page.mouse.down(); await page.mouse.move(1230, 180, { steps: 10 }); await page.mouse.up();
  const stale = await submit(first, `${remoteRoot}/projects/nested`);
  const latest = await submit(first, `${remoteRoot}/results`);
  const independent = await submit(second, `${remoteRoot}/projects/nested`);
  await receive(page, { type: 'remoteDirectory', path: latest.path, requestId: latest.requestId, windowId: latest.windowId, entries: [entry(latest.path, 'latest.txt')], operationCommand: { command: 'cd latest', status: 'success' } });
  await receive(page, { type: 'remoteDirectory', path: independent.path, requestId: independent.requestId, windowId: independent.windowId, entries: fixture().directories[independent.path], operationCommand: { command: 'cd independent', status: 'success' } });
  await receive(page, { type: 'remoteDirectory', path: stale.path, requestId: stale.requestId, windowId: stale.windowId, error: 'Late stale response', operationCommand: { command: 'cd stale', status: 'error' } });
  await windowEntry(first, `${remoteRoot}/results`, 'latest.txt').waitFor();
  await windowEntry(second, `${remoteRoot}/projects/nested`, 'deep.txt').waitFor();
  assert.equal(await first.locator('.window-path').inputValue(), `${remoteRoot}/results`);
  assert.equal(await second.locator('.window-path').inputValue(), `${remoteRoot}/projects/nested`);
  assert.doesNotMatch(await page.locator('#notice').textContent(), /Late stale response/);
  assert.equal(await page.locator('#operationCommand').textContent(), 'cd independent');
  const cancelled = await submit(first, `${remoteRoot}/projects`);
  await first.locator('.window-path').press('Escape');
  await receive(page, { type: 'remoteDirectory', path: cancelled.path, requestId: cancelled.requestId, entries: fixture().directories[cancelled.path], operationCommand: { command: 'cd cancelled', status: 'success' } });
  assert.equal(await page.locator('#operationCommand').textContent(), 'cd independent', 'Esc-cancelled navigation must not change the operation command');
}, { viewport: { width: 1900, height: 1050 } }));

test('All eight explorer edges resize with the pointer and maximize restores the user dimensions', () => scenario('window-resize-005', async page => {
  const win = await openDesktopFolder(page, 'projects');
  const title = await win.locator('.titlebar').boundingBox();
  await page.mouse.move(title.x + 110, title.y + 18);
  await page.mouse.down(); await page.mouse.move(730, 370, { steps: 10 }); await page.mouse.up();
  for (const direction of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    const before = await win.boundingBox();
    const edge = await win.locator(`.resize-handle[data-resize="${direction}"]`).boundingBox();
    assert.ok(edge, `The ${direction} edge is reachable`);
    const dx = direction.includes('e') ? 20 : direction.includes('w') ? -20 : 0;
    const dy = direction.includes('s') ? 16 : direction.includes('n') ? -16 : 0;
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 + dx, edge.y + edge.height / 2 + dy, { steps: 5 });
    await page.mouse.up();
    const after = await win.boundingBox();
    assert.ok(Math.abs(after.width - before.width - Math.abs(dx)) < 2, `${direction} changes width by its horizontal drag`);
    assert.ok(Math.abs(after.height - before.height - Math.abs(dy)) < 2, `${direction} changes height by its vertical drag`);
    if (direction.includes('w')) assert.ok(after.x < before.x);
    if (direction.includes('n')) assert.ok(after.y < before.y);
  }
  const resized = await win.boundingBox();
  await windowAction(win, 'maximize').click();
  const maximized = await win.boundingBox();
  assert.ok(maximized.width > resized.width);
  await windowAction(win, 'maximize').click();
  const restored = await win.boundingBox();
  for (const field of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(restored[field] - resized[field]) < 2, `Restore preserves ${field}`);
  await assertNoViewportOverflow(page);
  await page.screenshot({ path: path.join(artifacts, 'resize-005.png'), fullPage: true });
}, { viewport: { width: 1900, height: 1100 } }));

test('Long desktop and icon-view names ellipsize until selected, then expose the full name', () => scenario('long-names-005', async page => {
  const longName = 'very-long-remote-analysis-output-file-that-needs-more-than-one-line.txt';
  await page.evaluate(item => { window.mockRemote.directories[window.mockRemote.rootPath].push(item); }, entry(remoteRoot, longName));
  await desktopAction(page, 'refresh');
  const icon = desktopIcon(page, longName);
  await icon.waitFor();
  const labelState = locator => locator.evaluate(element => ({ text: element.textContent, height: element.getBoundingClientRect().height, whiteSpace: getComputedStyle(element).whiteSpace, ellipsis: getComputedStyle(element).textOverflow, clipped: element.scrollWidth > element.clientWidth }));
  const before = await labelState(icon.locator('.icon-label'));
  assert.equal(before.whiteSpace, 'nowrap');
  assert.equal(before.ellipsis, 'ellipsis');
  assert.equal(before.clipped, true);
  await icon.click();
  const expanded = await labelState(icon.locator('.icon-label'));
  assert.equal(expanded.text, longName);
  assert.ok(expanded.height > before.height);
  assert.equal(expanded.clipped, false);
  await page.locator('#newWindow').click();
  const win = page.locator('.window').last();
  await windowAction(win, 'icons').click();
  const item = windowEntry(win, remoteRoot, longName);
  const short = await labelState(item.locator('.entry-label'));
  assert.equal(short.whiteSpace, 'nowrap');
  assert.equal(short.ellipsis, 'ellipsis');
  assert.equal(short.clipped, true);
  await item.click();
  const full = await labelState(item.locator('.entry-label'));
  assert.equal(full.text, longName);
  assert.ok(full.height > short.height);
  assert.equal(full.clipped, false);
  await page.screenshot({ path: path.join(artifacts, 'long-names-005.png'), fullPage: true });
}));

test('The command bar retains the last operation through refresh and distinguishes failures and cancellation', () => scenario('operation-command-005', async page => {
  const command = "mkdir -- '/home/tester/Desktop/a folder'";
  await receive(page, { type: 'operationCommand', command, status: 'success' });
  assert.equal(await page.locator('#operationCommand').textContent(), command);
  assert.equal(await page.locator('#operationStatus').getAttribute('data-status'), 'success');
  await desktopAction(page, 'refresh');
  assert.equal(await page.locator('#operationCommand').textContent(), command, 'Ordinary UI notifications must not erase the operation command');
  const failed = "mv -- '/home/tester/Desktop/a' '/home/tester/Desktop/b'";
  await receive(page, { type: 'operationCommand', command: failed, status: 'error', detail: 'Permission denied' });
  assert.equal(await page.locator('#operationCommand').textContent(), failed);
  assert.equal(await page.locator('#operationStatus').getAttribute('data-status'), 'error');
  await receive(page, { type: 'operationCommand', command: "rm -r -- '/home/tester/Desktop/a'", status: 'cancelled' });
  assert.equal(await page.locator('#operationStatus').getAttribute('data-status'), 'cancelled');
  assert.match(await page.locator('#operationStatus').textContent(), /取消/);
  assert.equal((await messages(page, 'executeCommand')).length, 0, 'Displayed Linux equivalents must never be sent as VS Code commands');
}));
