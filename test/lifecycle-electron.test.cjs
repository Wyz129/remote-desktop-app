'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');
const project = path.resolve(__dirname, '..');
async function launch(t) {
  const fixture = await createSshFixture({ desktop: false }); let application, processHandle;
  t.after(async () => {
    if (application && processHandle.exitCode === null) {
      const timer = setTimeout(() => spawnSync('taskkill', ['/pid', String(processHandle.pid), '/T', '/F'], { windowsHide: true }), 5000);
      try { await application.close(); } finally { clearTimeout(timer); }
    }
    await fixture.close();
  });
  const userData = path.join(fixture.root, 'lifecycle-app'); await fs.mkdir(userData);
  await fs.writeFile(path.join(userData,'settings.json'), JSON.stringify({ knownHosts: { [`${fixture.config.host}:${fixture.config.port}`]: fixture.fingerprint }, shellPreferences: { toolbarHidden: ['browserButton'] } }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; const executablePath = process.env.REMOTE_DESKTOP_TEST_EXE;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [project]), '--smoke-test', `--user-data-dir=${userData}`], env });
  processHandle = application.process();
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  await page.locator('#switchAccountButton:not([disabled])').waitFor();
  await application.evaluate(({ dialog }) => { globalThis.promptLog = []; globalThis.answers = []; dialog.showMessageBox = async (_window, options) => { globalThis.promptLog.push(options); return { response: globalThis.answers.shift() ?? options.cancelId ?? 0 }; }; });
  return { fixture, application, page };
}
async function connect({ page, fixture }) {
  if (!await page.locator('#connectionDialog').isVisible()) await page.locator('#connectButton').click();
  await page.locator('#switchAccountButton').click(); await page.locator('#sshHost').fill(fixture.config.host); await page.locator('#sshPort').fill(String(fixture.config.port));
  await page.locator('#sshUsername').fill(fixture.config.username); await page.locator('#sshPassword').fill(fixture.config.password);
  await page.locator('#advancedConnectSubmit').click(); await page.locator('#connectionDialog').waitFor({state:'hidden'});
}
async function waitFullscreen(application, expected) {
  for (let attempt=0; attempt<100; attempt++) { if(await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/app/index.html')).isFullScreen()) === expected) return; await new Promise(resolve=>setTimeout(resolve,30)); }
  assert.equal(await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/app/index.html')).isFullScreen()), expected);
}

test('F11 exclusively toggles host fullscreen from desktop and other app web contents; Exit cancels safely for dirty Monaco then exits', {timeout:90000}, async t => {
  const context = await launch(t), { application, page } = context;
  await waitFullscreen(application, true);
  await page.keyboard.press('Escape'); await page.keyboard.press('Control+Alt+f'); await waitFullscreen(application, true);
  await page.keyboard.press('F11'); await waitFullscreen(application,false); await page.keyboard.press('F11'); await waitFullscreen(application,true);
  await application.evaluate(async ({BrowserWindow}) => {
    globalThis.keyTestWindow = new BrowserWindow({ show:false, webPreferences: {sandbox:true,contextIsolation:true,nodeIntegration:false} });
    await globalThis.keyTestWindow.loadURL('data:text/html,<input autofocus><script>window.keys=[];document.addEventListener("keydown",e=>keys.push(e.key))</script>');
    globalThis.keyTestWindow.webContents.sendInputEvent({type:'keyDown',keyCode:'F11'}); globalThis.keyTestWindow.webContents.sendInputEvent({type:'keyUp',keyCode:'F11'});
  });
  await waitFullscreen(application,false);
  await application.evaluate(() => { keyTestWindow.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); keyTestWindow.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'}); });
  await waitFullscreen(application,false);
  assert.ok(await application.evaluate(() => keyTestWindow.webContents.executeJavaScript('keys.includes("Escape")')));
  await application.evaluate(() => keyTestWindow.destroy());
  await connect(context);
  const document = await page.evaluate(() => window.remoteDesktop.openDocument(null));
  const update = await page.evaluate(id => window.remoteDesktop.workbenchCall(id,'update',{text:'unsaved draft'}),document.id); assert.equal(update.ok,true);
  await application.evaluate(() => answers.push(2));
  assert.equal(await page.evaluate(() => window.remoteDesktop.quit()),false);
  assert.equal(application.process().exitCode,null); assert.equal((await page.evaluate(() => window.remoteDesktop.listDocuments()))[0].dirty,true);
  assert.equal(await page.locator('#exitButton').getAttribute('title'),'Exit');
  await application.evaluate(() => answers.push(1));
  const closing=application.waitForEvent('close'); await page.locator('#exitButton').click(); await closing;
});

test('Exit waits for an in-progress SSH login and cancels its handshake instead of silently ignoring the request', {timeout:45000}, async t => {
  const { application, page } = await launch(t); const sockets=new Set();
  const stalled = net.createServer(socket => {sockets.add(socket); socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>stalled.listen(0,'127.0.0.1',resolve)); t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>stalled.close(resolve));});
  await page.evaluate(port => { window.pendingLogin = window.remoteDesktop.connect({host:'127.0.0.1',port,username:'fixture',password:'unused'}).catch(error=>({error:error.message})); }, stalled.address().port);
  for(let attempt=0;attempt<100&&!sockets.size;attempt++)await new Promise(resolve=>setTimeout(resolve,30)); assert.equal(sockets.size,1);
  const started=Date.now(), closing=application.waitForEvent('close');
  await page.evaluate(() => { window.quitResult=window.remoteDesktop.quit(); }); await closing;
  assert.ok(Date.now()-started<10000,'cancels rather than waiting for the SSH ready timeout');
});

test('stalled cleanup has a deadline and offers an explicit Exit after document confirmation', {timeout:45000}, async t => {
  const { application, page } = await launch(t);
  await application.evaluate(({app,dialog}) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath()+'/main.cjs');
    const {WorkbenchManager} = load('./lib/workbench-manager.cjs');
    WorkbenchManager.prototype.disconnect = () => new Promise(()=>{});
    dialog.showMessageBox = async (_window,options) => {globalThis.promptLog.push(options);if(options.title==='Exit')return new Promise(resolve=>globalThis.confirmCleanupExit=()=>resolve({response:1}));return {response:options.cancelId??0};};
  });
  const started=Date.now(), closing=application.waitForEvent('close');
  await page.evaluate(() => { window.quitResult=window.remoteDesktop.quit(); });
  for(let attempt=0;attempt<120;attempt++) { const prompts=await application.evaluate(()=>promptLog); if(prompts.some(value=>value.title==='Exit')) break; await new Promise(resolve=>setTimeout(resolve,80)); }
  assert.match((await application.evaluate(()=>promptLog)).find(value=>value.title==='Exit').detail,/超时/);
  await application.evaluate(()=>{confirmCleanupExit();});
  await closing; assert.ok(Date.now()-started<15000,'network cleanup cannot block Exit indefinitely');
});
