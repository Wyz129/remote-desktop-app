'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const desktop = '/home/tester/Desktop';
let browser, server, origin;
const results = [];

before(async () => {
  server = http.createServer((req, res) => {
    const file = req.url === '/' ? '/app/index.html' : req.url.split('?')[0];
    if (!/^\/(?:app|media|media\/workbench)\/[\w.-]+$/.test(file)) return res.writeHead(404).end();
    const target = path.join(root, file);
    if (!fs.existsSync(target)) return res.writeHead(404).end();
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'artifacts', 'standalone-ui-results.json'), JSON.stringify({ boundary: '真实渲染器、无头 Chrome、替身 Electron/SSH API', results }, null, 2));
});

async function scenario(name, fn) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const root = '/home/tester/Desktop';
    const entry = (name, type = 'file', base = root) => ({ name, type, path: `${base}/${name}`, size: '12 B' });
    window.messages = []; window.calls = []; window.downloadPending = new Map();
    window.fetch = (...args) => { throw new Error('Renderer must not fetch local files: ' + String(args[0])); };
    window.settings = { downloadThreshold: 50 * 1024 * 1024, scriptEditor: 'vim', downloadsPath: 'D:\\Downloads' };
    window.directories = { '/home/tester': [entry('Documents', 'folder', '/home/tester'), entry('profile.txt', 'file', '/home/tester')], [root]: [entry('projects', 'folder'), entry('results', 'folder'), entry('notes.txt'), entry('picture.png'), entry('archive.zip')], [`${root}/projects`]: [entry('nested','folder',`${root}/projects`), entry('source.txt','file',`${root}/projects`)], [`${root}/projects/nested`]: [], [`${root}/results`]: [] };
    window.systemInfo = { username:'tester',hostname:'remote-server',home:'/home/tester',os:'Ubuntu 24.04 LTS',kernel:'Linux 6.8',architecture:'x86_64',cpu:'4 CPUs',memory:'16 GiB',disk:'40% used',dateTime:'2026-09-18 13:00:00 CST',timeZone:'Asia/Shanghai',locale:'LANG=zh_CN.UTF-8',shell:'/bin/bash',network:'192.0.2.12' };
    window.connectedState = () => window.receive({ type:'remoteState', status:'ready', rootPath:root, homePath:'/home/tester', entries:window.directories[root], config:{viewMode:'details', shortcuts:[{command:'workbench.action.showCommands',label:'Legacy'}]} });
    window.remoteDesktop = {
      onMessage(callback) { window.receive = callback; },
      onBrowserEvent(callback) { window.browserEvent = callback; },
      onActivityEvent(callback) { window.activityEvent = callback; },
      async getActivitySnapshot() { return { sessions: [], entries: [], systemLogPath: '', connected: false, error: null }; },
      async openBrowser() { window.calls.push({type:'openBrowser'}); if (window.deferBrowserOpen) return new Promise(resolve=>{window.resolveBrowserOpen=resolve;}); return {id:41,embedded:true}; },
      async layoutBrowser(id,bounds,hidden) { window.calls.push({type:'browserLayout',id,bounds,hidden}); },
      async closeBrowser(id) { window.calls.push({type:'closeBrowser',id}); window.browserEvent({type:'closed',id}); return true; },
      async openDocument(path,options) { window.calls.push({type:'openDocument',path,...options}); },
      async chooseUpload() { window.calls.push({type:'chooseUpload'}); return ['D:\\projects\\code.py']; },
      async chooseDownloadDirectory() { window.calls.push({type:'chooseDownloadDirectory'}); return 'D:\\Downloads'; },
      async acceptDroppedFiles(files) { window.calls.push({type:'acceptDroppedFiles',names:files.map(file=>file.name)}); return files.map(file=>'D:\\drop\\'+file.name); },
      async upload(localPath,remoteDirectory,id) { window.calls.push({type:'upload',localPath,remoteDirectory,id}); return {id,path:remoteDirectory+'/code.py',done:12,total:12}; },
      async listTransfers() { return []; },
      async removeTransfer(id) { window.calls.push({type:'removeTransfer',id}); return true; },
      async clearTransferHistory() { window.calls.push({type:'clearTransferHistory'}); return true; },
      async openTransferTarget(id) { window.calls.push({type:'openTransferTarget',id}); return window.transferTarget || {side:'local'}; },
      send(message) {
        window.messages.push(message);
        queueMicrotask(() => {
          if (message.type === 'readDirectory') window.receive({type:'remoteDirectory',path:message.path,requestId:message.requestId,...(window.deniedDirectory === message.path ? {error:'Permission denied (EACCES)',accessDenied:true} : window.directories[message.path] ? {entries:window.directories[message.path]} : {error:'目录不存在'})});
          if (message.type === 'openTerminal') window.receive({type:'terminalOpened',id:message.id});
          if (message.type === 'saveDesktopConfig') window.receive({type:'configSaved',requestId:message.requestId,ok:!window.failConfigSave,config:message.config,error:window.failConfigSave ? 'Permission denied' : undefined});
          if (message.type === 'toggleFullscreen') window.receive({type:'fullscreenResult',ok:true});
        });
      },
      async connect(input) {
        window.calls.push({type:'connect',input});
        if (window.failConnection) throw new Error('Authentication failed');
        window.receive({type:'serverInfo',username:input.username,hostname:input.host,epochMs:Date.now(),timeZone:'UTC',remote:true});
        if (window.unavailableDesktop) window.receive({type:'remoteState',status:'error',homePath:'/home/tester',message:'无访问权限：/shared/previous — Permission denied (EACCES)'});
        else if (window.missingDesktop) window.receive({type:'remoteState',status:'missing',homePath:'/home/tester'}); else window.connectedState();
        return {username:input.username,host:input.host,home:'/home/tester',verified:true,hostFingerprint:'SHA256:test'};
      },
      async disconnect() { window.receive({type:'remoteState',status:'disconnected'}); },
      async list(path) { window.calls.push({type:'list',path}); if(window.deniedDirectory === path) throw new Error('Permission denied (EACCES)'); if(!window.directories[path]) throw new Error('目录不存在'); return window.directories[path]; },
      async setDesktop(path) { window.calls.push({type:'setDesktop',path}); if(window.deferDesktop) return new Promise((resolve,reject)=>{window.resolveDesktop=resolve;window.rejectDesktop=reject;}); if(window.deniedDirectory === path) throw new Error('无访问权限：Permission denied (EACCES)'); if(!window.directories[path]) throw new Error('目录不存在'); return {status:'ready',rootPath:path,homePath:'/home/tester',entries:window.directories[path],config:{wallpaper:'slate',viewMode:'details',showHiddenFiles:true}}; },
      async checkFileAccess(path) { window.calls.push({type:'checkFileAccess',path}); if(window.deferFileAccess) return new Promise(resolve=>{window.resolveFileAccess=resolve;}); return {path,readable:window.deniedFile !== path,writable:window.readOnlyFile !== path,error:window.deniedFile === path ? 'Permission denied (EACCES)' : undefined}; },
      async getSettings() { return window.settings; },
      async getSystemInfo() { window.calls.push({type:'getSystemInfo'}); if (window.failSystemInfo) throw new Error('SSH connection closed'); if (window.deferSystemInfo) return new Promise(resolve=>{window.resolveSystemInfo=resolve;}); return {...window.systemInfo}; },
      async saveSettings(patch) { Object.assign(window.settings,patch); return window.settings; },
      async choosePrivateKey() { return 'D:\\keys\\id_ed25519'; },
      async closeTerminal(id) {
        window.messages.push({type:'terminalClose',id}); window.calls.push({type:'closeTerminal',id});
        if (window.failTerminalClose) throw new Error('保存失败，请检查文件权限');
        if (window.deferTerminalClose) return new Promise(resolve=>{window.resolveTerminalClose=resolve;});
        return window.cancelTerminalClose !== true;
      },
      async image(file) { window.calls.push({type:'image',path:file}); const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 1200; const context = canvas.getContext('2d'); context.fillStyle = '#70b294'; context.fillRect(0,0,1600,1200); context.fillStyle = '#fff'; context.beginPath(); context.arc(400,400,180,0,Math.PI*2); context.fill(); return {name:'picture.png',mime:'image/png',data:canvas.toDataURL('image/png').split(',')[1]}; },
      download(file,id,destination) { window.calls.push({type:'download',path:file,id,destination}); return new Promise((resolve,reject) => window.downloadPending.set(id,{resolve,reject})); },
      async cancelDownload(id) { window.calls.push({type:'cancelDownload',id}); const error=new Error('操作已取消');error.code='ABORT_ERR';window.downloadPending.get(id)?.reject(error); },
      onDownloadProgress(callback) { window.progress = callback; },
      async quitFullscreen() { window.calls.push({type:'quitFullscreen'}); }
    };
  });
  try {
    await page.goto(origin + '/app/index.html');
    await page.locator('#connectionDialog[open]').waitFor();
    await fn(page);
    assert.deepEqual(errors, [], 'renderer has no uncaught errors');
    results.push({name,passed:true});
  } catch (error) {
    results.push({name,passed:false,error:error.message});
    await page.screenshot({path:path.join(root,'artifacts',`standalone-failed-${name}.png`)}).catch(()=>{});
    throw error;
  } finally { await page.close(); }
}
async function connect(page) {
  await page.locator('#sshHost').fill('ssh.example.test');
  await page.locator('#sshUsername').fill('tester');
  await page.locator('#sshPassword').fill('memory-only');
  await page.locator('#connectSubmit').click();
  await page.locator('#connectionDialog').waitFor({state:'hidden'});
}
const icon = (page,name) => page.locator(`#icons [data-path="${desktop}/${name}"]`);

test('applications_overview_bottom_dock_search_keyboard_and_offline_access', () => scenario('applications-overview', async page => {
  await page.locator('#closeConnection').click();
  const toggle = page.locator('#applicationsButton'), panel = page.locator('#applicationsPanel');
  assert.equal(await page.locator('#dock #editorShortcut, #dock #imageShortcut, #builtinApps').count(), 0);
  await toggle.click(); await panel.waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await panel.locator('.application-label').allTextContents(), ['浏览器','传输中心','实时监听','htop','Monaco Editor','图片查看器']);
  assert.equal(await panel.locator('button.application-tile:disabled').count(), 4);
  assert.equal(await page.locator('#applicationsSearch').evaluate(el => el === document.activeElement), true);
  const toggleBounds = await toggle.boundingBox(), dockBounds = await page.locator('#dock').boundingBox();
  assert.ok(dockBounds.y + dockBounds.height - toggleBounds.y - toggleBounds.height <= 14, 'applications stays at dock bottom');
  await page.locator('#applicationsSearch').fill('nothing-matches'); await page.locator('#applicationsEmpty').waitFor();
  assert.equal(await panel.locator('.application-tile:visible').count(), 0);
  await page.locator('#applicationsSearch').fill('下载'); await page.keyboard.press('Enter');
  assert.equal(await panel.isVisible(), false); await page.locator('#downloadsPanel').waitFor();
  await page.locator('#closeDownloads').click();
  await toggle.click(); await page.keyboard.press('Escape');
  assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click(); await toggle.click(); assert.equal(await panel.isVisible(), false);
  await page.locator('#connectButton').click(); await connect(page);
  await toggle.click(); assert.equal(await panel.locator('button.application-tile:disabled').count(), 0);
  await page.keyboard.press('Control+Alt+t'); assert.equal(await page.locator('.terminal-window').count(), 0, 'overview consumes desktop shortcuts');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.application), 'browser');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.application), 'transfer');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.application), 'image');
  await page.screenshot({ path: path.join(root, 'artifacts', 'standalone-applications.png') });
  await page.locator('#homeShortcut').click(); assert.equal(await panel.isVisible(), false);
  await page.locator('.window').first().waitFor();
  await toggle.click(); await page.evaluate(() => window.receive({type:'remoteState',status:'disconnected'}));
  assert.equal(await panel.isVisible(), false);
  await toggle.click(); assert.equal(await panel.locator('button.application-tile:disabled').count(), 4);
}));

test('applications_launch_existing_apps_and_hide_native_browser_views', () => scenario('applications-launch', async page => {
  await connect(page);
  const launch = async id => { await page.locator('#applicationsButton').click(); await page.locator(`[data-application="${id}"]`).click(); assert.equal(await page.locator('#applicationsPanel').isVisible(), false); };
  await launch('browser'); await page.locator('.browser-window').waitFor();
  assert.equal(await page.locator('.browser-window .window-title').textContent(), '浏览器');
  assert.equal(await page.locator('#windowTabs .tab-label').textContent(), '浏览器');
  await page.waitForFunction(() => window.calls.some(call => call.type === 'browserLayout' && !call.hidden));
  await page.locator('#applicationsButton').click();
  await page.waitForFunction(() => window.calls.filter(call => call.type === 'browserLayout').at(-1)?.hidden === true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.calls.filter(call => call.type === 'browserLayout').at(-1)?.hidden === false);
  await launch('browser'); assert.equal(await page.locator('.browser-window').count(), 1);
  await launch('activity'); await launch('activity'); assert.equal(await page.locator('.activity-window').count(), 1);
  await launch('transfer'); await page.locator('#downloadsPanel').waitFor(); await page.locator('#closeDownloads').click();
  await launch('htop'); await page.locator('.terminal-window[data-program=htop]').waitFor();
  assert.equal(await page.evaluate(() => window.messages.filter(message => message.type === 'openTerminal' && message.program === 'htop').length), 1);
  await launch('editor'); assert.ok(await page.evaluate(() => window.calls.some(call => call.type === 'openDocument' && call.path === null)));
  await launch('image'); await page.locator('.image-window').waitFor();
}));

test('connection_failure_and_disconnect_never_display_demo', () => scenario('connection', async page => {
  assert.equal(await page.locator('#icons .icon').count(),0);
  await page.screenshot({path:path.join(root,'artifacts','standalone-connect.png')});
  await page.evaluate(()=>{window.failConnection=true;});
  await page.locator('#sshHost').fill('host');await page.locator('#sshUsername').fill('tester');await page.locator('#sshPassword').fill('secret');await page.locator('#connectSubmit').click();
  await page.waitForFunction(()=>document.getElementById('connectionError').textContent.includes('Authentication failed'));
  assert.equal(await page.locator('#icons .icon').count(),0);assert.equal(await page.locator('#sshPassword').inputValue(),'');
  await page.evaluate(()=>{window.failConnection=false;});await connect(page);
  await icon(page,'projects').waitFor();assert.equal(await page.locator('#icons .icon').count(),5);
  assert.equal(await page.locator('#icons').getByText('Legacy').count(),0);
  await icon(page,'projects').dblclick();await page.locator('.window').waitFor();
  await page.evaluate(()=>window.receive({type:'remoteState',status:'disconnected'}));
  assert.equal(await page.locator('.window').count(),0);assert.equal(await page.locator('#icons .icon').count(),0);
  await page.evaluate(()=>window.receive({type:'remoteDirectory',path:'/home/tester/Desktop',entries:[{name:'stale',path:'/home/tester/Desktop/stale'}]}));
  assert.equal(await page.locator('#icons .icon').count(),0);
}));

test('windows_navigation_resize_drag_minimize_maximize', () => scenario('windows', async page => {
  await connect(page);await icon(page,'projects').dblclick();
  const win=page.locator('.window').first();await win.locator('.entry').first().waitFor();
  assert.equal(await win.locator('.window-path').inputValue(),`${desktop}/projects`);
  await win.locator('.window-path').fill('~/Desktop/results');await win.locator('.window-path').press('Enter');
  await page.waitForFunction(()=>document.querySelector('.window-path').value==='/home/tester/Desktop/results');
  await win.locator('[data-window-action="back"]').click();await win.getByText('source.txt',{exact:true}).waitFor();
  const before=await win.boundingBox();const title=await win.locator('.window-title').boundingBox();
  await page.mouse.move(title.x+10,title.y+8);await page.mouse.down();await page.mouse.move(title.x+140,title.y+70,{steps:8});await page.mouse.up();
  const moved=await win.boundingBox();assert.ok(moved.x>before.x+80);
  const resize=await win.locator('[data-resize="se"]').boundingBox();await page.mouse.move(resize.x+3,resize.y+3);await page.mouse.down();await page.mouse.move(resize.x+90,resize.y+70,{steps:8});await page.mouse.up();
  assert.ok((await win.boundingBox()).width>moved.width+50);
  await win.locator('[data-window-action="maximize"]').click();assert.ok((await win.getAttribute('class')).includes('maximized'));
  await win.locator('[data-window-action="maximize"]').click();
  await win.locator('[data-window-action="minimize"]').click();assert.equal(await win.isVisible(),false);
  await page.locator('#windowTabs .window-tab').click();assert.equal(await win.isVisible(),true);
  assert.equal(await page.locator('#newWindow').count(),0);
  await page.locator('#homeShortcut').click();assert.equal(await page.locator('.window').count(),2);
  await page.locator('.window').last().locator('[data-window-action="close"]').click();assert.equal(await page.locator('#windowTabs .window-tab').count(),1);
}));

test('crud_selection_and_terminal_shortcut_preserved', () => scenario('file-actions', async page => {
  await connect(page);await icon(page,'notes.txt').click();await page.keyboard.press('F2');
  await page.locator('.name-editor').fill('renamed.txt');await page.locator('.name-editor').press('Enter');
  await page.waitForFunction(()=>window.messages.some(m=>m.operation==='rename'&&m.name==='renamed.txt'));
  await icon(page,'projects').click();await page.keyboard.down('Control');await icon(page,'notes.txt').click();await page.keyboard.up('Control');
  await page.keyboard.press('Control+c');await page.keyboard.press('Control+v');
  assert.equal(await page.evaluate(()=>window.messages.find(m=>m.operation==='paste').clipboard.paths.length),2);
  await page.keyboard.press('Control+Alt+t');await page.locator('.terminal-window .xterm').waitFor();
  await page.waitForFunction(()=>window.messages.some(m=>m.type==='openTerminal'&&m.program==='shell'));
  await page.locator('.terminal-window [data-window-action="close"]').click();
  assert.ok(await page.evaluate(()=>window.messages.some(m=>m.type==='terminalClose')));
  await icon(page,'notes.txt').dblclick();
  await page.waitForFunction(()=>window.calls.some(m=>m.type==='openDocument'&&m.path.endsWith('/notes.txt')));
  assert.equal(await page.locator('.terminal-window').count(),0);
}));

test('image_viewer_library_zoom_pan_rotate_flip_and_window_lifecycle', () => scenario('image', async page => {
  await connect(page);await icon(page,'picture.png').dblclick();const win=page.locator('.image-window');
  await page.waitForFunction(()=>document.querySelector('.image-source')?.viewer?.viewed);
  const data=()=>win.evaluate(el=>({...el.querySelector('.image-source').viewer.imageData}));
  const first=await data();assert.ok(first.ratio>0&&first.ratio<1);
  assert.equal(await win.locator('.image-viewport > .viewer-container').count(),1,'real Viewer.js is embedded');
  const viewport=await win.locator('.image-viewport').boundingBox();const x=viewport.x+viewport.width*0.3,y=viewport.y+viewport.height*0.35;
  await page.mouse.move(x,y);await page.mouse.wheel(0,-200);
  await page.waitForFunction(scale=>document.querySelector('.image-source').viewer.imageData.ratio>scale,first.ratio);
  const next=await data();
  assert.ok(Math.abs((x-viewport.x-first.x)/first.ratio-(x-viewport.x-next.x)/next.ratio)<1,'library zoom anchors pointer');
  await page.mouse.down();await page.mouse.move(x+80,y+50,{steps:8});await page.mouse.up();
  assert.ok((await data()).x>next.x+60,'Viewer.js pans the image');
  await win.locator('[data-image-action="actual"]').click();assert.equal((await data()).ratio,1);
  await win.locator('[data-image-action="rotate"]').click();assert.equal((await data()).rotate,90);
  await win.locator('[data-image-action="flip"]').click();assert.equal((await data()).scaleX,-1);
  await win.locator('[data-image-action="fit"]').click();assert.ok((await data()).ratio<1);assert.equal((await data()).rotate,0);assert.equal((await data()).scaleX,1);
  await win.locator('[data-window-action="maximize"]').click();await win.locator('[data-window-action="minimize"]').click();await page.locator('#windowTabs .window-tab').click();
  await page.screenshot({path:path.join(root,'artifacts','standalone-image.png')});
  await page.evaluate(()=>{window.oldImageViewer=document.querySelector('.image-source').viewer;});
  await win.locator('[data-window-action="close"]').click();assert.equal(await page.locator('.image-window').count(),0);
  assert.equal(await page.evaluate(()=>window.oldImageViewer.element.viewer),undefined,'close destroys Viewer.js instance');
}));

test('image_launcher_remote_picker_errors_keyboard_focus_and_disconnect_cleanup', () => scenario('image-launcher', async page => {
  await connect(page);await page.locator('#applicationsButton').click();await page.locator('[data-application=image]').click();const win=page.locator('.image-window');
  await win.locator('.image-empty').waitFor();assert.equal(await win.locator('[data-image-action="in"]').isDisabled(),true);
  await win.locator('.image-controls [data-image-action="open"]').click();
  const picker=page.locator('.server-picker-window');await picker.locator('.window-picker-path').fill(desktop+'/picture.png');await picker.locator('.window-picker-select').click();
  await page.waitForFunction(()=>document.querySelector('.image-source')?.viewer?.viewed);
  assert.equal(await win.locator('.window-title').textContent(),'picture.png');
  await win.focus();await page.keyboard.press('r');assert.equal(await win.evaluate(el=>el.querySelector('.image-source').viewer.imageData.rotate),90);
  await page.locator('#homeShortcut').click();await page.locator('.window-path').fill('/home/tester');await page.keyboard.press('r');
  assert.equal(await win.evaluate(el=>el.querySelector('.image-source').viewer.imageData.rotate),90,'typing in another window does not rotate image');
  await page.locator('#windowTabs .window-tab').filter({hasText:'picture.png'}).click();
  await win.locator('.image-controls [data-image-action="open"]').click();
  await picker.locator('.window-picker-path').fill(desktop+'/notes.txt');await picker.locator('.window-picker-select').click();
  await page.waitForFunction(()=>document.querySelector('.image-status').textContent.includes('/notes.txt'));
  await page.evaluate(()=>{window.remoteDesktop.image=async()=>{throw new Error('无访问权限：Permission denied');};});
  await win.locator('.image-controls [data-image-action="open"]').click();await picker.locator('.window-picker-path').fill(desktop+'/picture.png');await picker.locator('.window-picker-select').click();
  await page.waitForFunction(()=>document.querySelector('.image-status').textContent.includes('无访问权限'));
  assert.equal(await win.locator('.viewer-container').count(),1,'failed reads preserve current image');
  await page.evaluate(()=>{window.oldImageViewer=document.querySelector('.image-source').viewer;window.receive({type:'remoteState',status:'disconnected'});});
  assert.equal(await page.locator('.image-window').count(),0);
  assert.equal(await page.evaluate(()=>window.oldImageViewer.element.viewer),undefined,'disconnect destroys Viewer.js instance');
}));

test('download_menu_directory_progress_cancel_and_completion', () => scenario('downloads', async page => {
  await connect(page);await icon(page,'projects').click({button:'right'});await page.locator('[data-action="download"]').click();
  await page.locator('.download-item').waitFor();const id=await page.evaluate(()=>window.calls.find(c=>c.type==='download').id);
  await page.evaluate(id=>window.progress({id,done:25,total:100,method:'sftp',status:'running'}),id);
  assert.match(await page.locator('.download-status').textContent(),/25%/);
  await page.locator('.download-item .transfer-cancel').click();await page.waitForFunction(()=>document.querySelector('.download-status').textContent.includes('已取消'));
  assert.ok(await page.evaluate(id=>window.calls.some(c=>c.type==='cancelDownload'&&c.id===id),id));
  await page.locator('#closeDownloads').click();await icon(page,'notes.txt').click({button:'right'});await page.locator('[data-action="download"]').click();
  const second=await page.evaluate(()=>window.calls.filter(c=>c.type==='download').at(-1).id);
  await page.evaluate(id=>window.downloadPending.get(id).resolve({id,path:'D:\\Downloads\\notes.txt',method:'ssh'}),second);
  await page.waitForFunction(()=>[...document.querySelectorAll('.download-status')].some(el=>el.textContent.includes('已完成')));
}));

test('settings_threshold_key_picker_and_fullscreen_shortcut', () => scenario('settings', async page => {
  await page.locator('#chooseKey').click();assert.match(await page.locator('#sshPrivateKey').inputValue(),/id_ed25519$/);
  await connect(page);
  const credentials = await page.evaluate(()=>window.calls.find(call=>call.type==='connect').input);
  assert.match(credentials.privateKeyPath,/id_ed25519$/);assert.equal(Object.hasOwn(credentials,'privateKey'),false,'renderer forwards a local path, never key contents');
  await page.locator('#desktopSettings').click();await page.locator('#settingsDownloadThreshold').waitFor();
  await page.waitForFunction(()=>document.getElementById('settingsDownloadThreshold').value==='50');
  await page.locator('#settingsDownloadThreshold').fill('80');await page.locator('#saveExtensionSettings').click();
  await page.waitForFunction(()=>window.settings.downloadThreshold===80*1024*1024);
  assert.match(await page.locator('#downloadsLocation').textContent(),/D:\\Downloads/);
  await page.locator('#closeSettings').click();await page.keyboard.press('F11');
  assert.ok(await page.evaluate(()=>window.messages.some(m=>m.type==='toggleFullscreen')));
  await page.screenshot({path:path.join(root,'artifacts','standalone-desktop.png')});
}));

test('missing_desktop_requires_explicit_creation', () => scenario('missing-desktop', async page => {
  await page.evaluate(()=>{window.missingDesktop=true;});await connect(page);
  await page.locator('#missingDesktopDialog[open]').waitFor();
  assert.equal(await page.locator('#icons .icon').count(),0);assert.equal(await page.evaluate(()=>window.messages.some(m=>m.type==='createDesktop')),false);
  await page.locator('#createDesktop').click();assert.ok(await page.evaluate(()=>window.messages.some(m=>m.type==='createDesktop')));
}));

test('terminal_close_error_and_pending_request_keep_window_until_channel_closes', () => scenario('terminal-channel-close', async page => {
  await connect(page); await page.keyboard.press('Control+Alt+t');
  const win=page.locator('.terminal-window'); await win.waitFor();
  const id=await win.getAttribute('data-window-id');
  const close=win.locator('[data-window-action="close"]');
  await page.evaluate(()=>{window.cancelTerminalClose=true;}); await close.click();
  await page.waitForFunction(()=>window.calls.some(c=>c.type==='closeTerminal'));
  assert.equal(await win.isVisible(),true); assert.equal(await close.isEnabled(),true);
  await page.evaluate(()=>{window.cancelTerminalClose=false;window.failTerminalClose=true;}); await close.click();
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('保存失败'));
  assert.equal(await win.isVisible(),true); assert.equal(await close.isEnabled(),true);
  await page.evaluate(()=>{window.failTerminalClose=false;window.deferTerminalClose=true;}); await close.click();
  await page.waitForFunction(()=>typeof window.resolveTerminalClose==='function');
  assert.equal(await win.isVisible(),true); assert.equal(await close.isDisabled(),true);
  await page.evaluate(id=>window.receive({type:'terminalData',id,data:'still editing'}),id);
  assert.equal(await win.locator('.xterm').count(),1);
  await page.evaluate(()=>window.resolveTerminalClose(false));
  await page.waitForFunction(()=>!document.querySelector('.terminal-window [data-window-action="close"]').disabled);
  assert.equal(await win.isVisible(),true);
  await page.evaluate(()=>{window.resolveTerminalClose=null;}); await close.click();
  await page.waitForFunction(()=>typeof window.resolveTerminalClose==='function');
  await page.evaluate(id=>{window.receive({type:'terminalClosed',id});window.resolveTerminalClose(true);},id);
  await win.waitFor({state:'detached'});
  assert.equal(await page.locator('#windowTabs .window-tab').count(),0);
}));

test('desktop_refresh_errors_and_root_changes_preserve_running_editors', () => scenario('editor-refresh', async page => {
  await connect(page); await page.keyboard.press('Control+Alt+t');
  const id = await page.locator('.terminal-window').getAttribute('data-window-id');
  await page.evaluate(()=>window.receive({type:'remoteState',status:'error',message:'temporary read failure'}));
  assert.equal(await page.locator('.terminal-window').getAttribute('data-window-id'),id);
  await page.evaluate(()=>window.receive({type:'remoteState',status:'missing',homePath:'/home/tester'}));
  await page.locator('#skipDesktop').click();
  assert.equal(await page.locator('.terminal-window').getAttribute('data-window-id'),id);
  await page.evaluate(()=>window.receive({type:'remoteState',status:'ready',rootPath:'/home/tester/desktop',homePath:'/home/tester',entries:[],config:{}}));
  assert.equal(await page.locator('.terminal-window').getAttribute('data-window-id'),id);
  assert.equal(await page.evaluate(()=>window.calls.some(call=>call.type==='closeTerminal')),false);
  await page.evaluate(()=>window.receive({type:'remoteState',status:'disconnected'}));
  assert.equal(await page.locator('.terminal-window').count(),0);
}));

test('builtin_home_and_settings_remain_available_without_connection_or_pins', () => scenario('builtin-shortcuts', async page => {
  await page.locator('#closeConnection').click();
  assert.equal(await page.locator('#dock #editorShortcut, #dock #imageShortcut, #builtinApps').count(),0);
  assert.deepEqual(await page.locator('.toolbar-actions button').evaluateAll(nodes => nodes.map(node => node.id).filter(id => ['browserButton', 'homeShortcut', 'desktopSettings'].includes(id))), ['browserButton', 'homeShortcut', 'desktopSettings']);
  assert.equal(await page.locator('#dock #homeShortcut, #dock #browserButton, #dock #desktopSettings').count(), 0);
  await page.locator('#desktopSettings').click();
  await page.waitForFunction(()=>document.getElementById('settingsDownloadThreshold').value==='50');
  assert.equal(await page.locator('#applySettings').isDisabled(),true);
  await page.locator('#settingsDownloadThreshold').fill('70'); await page.locator('#saveExtensionSettings').click();
  await page.waitForFunction(()=>window.settings.downloadThreshold===70*1024*1024);
  await page.locator('#systemSettingsTab').click();
  assert.match(await page.locator('#systemInfoStatus').textContent(),/连接 SSH/);
  assert.equal(await page.locator('#refreshSystemInfo').isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.calls.some(c=>c.type==='getSystemInfo')),false);
  await page.locator('#closeSettings').click();
  await page.locator('#homeShortcut').click(); await page.locator('#connectionDialog[open]').waitFor();
  await connect(page); await page.locator('#homeShortcut').click();
  const win=page.locator('.window'); await win.getByText('profile.txt',{exact:true}).waitFor();
  assert.equal(await win.locator('.window-path').inputValue(),'/home/tester');
  assert.ok(await page.evaluate(()=>window.messages.some(m=>m.type==='readDirectory'&&m.path==='/home/tester')));
  await win.locator('[data-window-action="minimize"]').click(); await page.locator('#homeShortcut').click();
  assert.equal(await page.locator('.window').count(),1); assert.equal(await win.isVisible(),true);
  await page.evaluate(()=>window.receive({type:'configUpdated',config:{pinnedApps:[]}}));
  assert.equal(await page.locator('#dock #editorShortcut, #dock #imageShortcut, #builtinApps').count(),0);
  await page.locator('#homeShortcut').click({button:'right'});
  assert.equal(await page.locator('#appContext').isVisible(),false);
  await page.evaluate(()=>window.receive({type:'remoteState',status:'disconnected'}));
  assert.equal(await page.locator('#dock #editorShortcut, #dock #imageShortcut, #builtinApps').count(),0);
  await page.locator('#desktopSettings').click(); await page.locator('#settingsDialog[open]').waitFor();
}));

test('settings_single_window_preserves_input_and_supports_desktop_window_controls', () => scenario('settings-window', async page => {
  await connect(page);
  await page.locator('#desktopSettings').click();
  const win = page.locator('#settingsDialog');
  await page.waitForFunction(() => document.getElementById('settingsDownloadThreshold').value === '50');
  assert.equal(await win.evaluate(element => element.matches(':modal')), false);
  assert.equal(await win.evaluate(element => element.parentElement.id), 'windows');
  await page.locator('#settingsDesktopPath').fill('/shared/pending-desktop');
  await page.locator('#settingsDownloadThreshold').fill('73');
  await page.locator('#desktopSettings').click();
  await page.locator('#desktopSettings').click();
  assert.equal(await page.locator('.settings-dialog[open]').count(), 1);
  assert.equal(await page.locator('#settingsDesktopPath').inputValue(), '/shared/pending-desktop');
  assert.equal(await page.locator('#settingsDownloadThreshold').inputValue(), '73');
  const before = await win.boundingBox();
  const bar = await win.locator('.titlebar').boundingBox();
  await page.mouse.move(bar.x + 180, bar.y + 16); await page.mouse.down();
  await page.mouse.move(bar.x + 230, bar.y + 45, { steps: 5 }); await page.mouse.up();
  const moved = await win.boundingBox();
  assert.ok(moved.x > before.x + 30); assert.ok(moved.y > before.y + 10);
  const handle = await win.locator('.resize-handle[data-resize="se"]').boundingBox();
  await page.mouse.move(handle.x + 3, handle.y + 3); await page.mouse.down();
  await page.mouse.move(handle.x + 73, handle.y + 23, { steps: 5 }); await page.mouse.up();
  assert.ok((await win.boundingBox()).width > moved.width + 40);
  await win.locator('[data-window-action="maximize"]').click();
  assert.equal(await win.evaluate(element => element.classList.contains('maximized')), true);
  await win.locator('[data-window-action="maximize"]').click();
  await win.locator('[data-window-action="minimize"]').click();
  assert.equal(await win.isVisible(), false);
  await page.locator('#windowTabs [data-window-id="settings-window"]').click();
  assert.equal(await win.isVisible(), true);
  assert.equal(await page.locator('#settingsDownloadThreshold').inputValue(), '73');
  await page.screenshot({ path: path.join(root, 'artifacts', 'standalone-settings-window.png') });
  await page.locator('#closeSettings').click();
  assert.equal(await win.isVisible(), false);
  assert.equal(await page.locator('#windowTabs [data-window-id="settings-window"]').count(), 0);
  await page.locator('#desktopSettings').click();
  assert.equal(await page.locator('#settingsDesktopPath').inputValue(), desktop);
  assert.equal(await page.locator('.settings-dialog[open]').count(), 1);
}));

test('home_without_desktop_browses_real_home_without_creating_or_faking_desktop', () => scenario('home-without-desktop', async page => {
  await page.evaluate(()=>{window.missingDesktop=true;}); await connect(page);
  await page.locator('#skipDesktop').click(); await page.locator('#homeShortcut').click();
  const win=page.locator('.window'); await win.getByText('profile.txt',{exact:true}).waitFor();
  assert.equal(await win.locator('.window-path').inputValue(),'/home/tester');
  assert.equal(await page.locator('#icons .icon').count(),0);
  await win.locator('[data-window-action="refresh"]').click();
  await win.getByText('profile.txt',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.messages.some(m=>m.type==='createDesktop'||m.type==='saveDesktopConfig'||m.type==='refreshRemote')),false);
  await page.locator('#desktopSettings').click();
  assert.equal(await page.locator('#applySettings').isEnabled(),true);
  await page.locator('#systemSettingsTab').click();
  await page.locator('[data-system-info="os"]').getByText('Ubuntu 24.04 LTS',{exact:true}).waitFor();
}));

test('control_panel_system_info_refresh_failure_and_disconnect_rejects_stale_data', () => scenario('system-control-panel', async page => {
  await connect(page); await page.locator('#desktopSettings').click(); await page.locator('#systemSettingsTab').click();
  await page.locator('#systemInfoFields').waitFor();
  assert.equal(await page.locator('[data-system-info="home"]').textContent(),'/home/tester');
  assert.equal(await page.locator('[data-system-info="timeZone"]').textContent(),'Asia/Shanghai');
  assert.match(await page.locator('.system-settings-note').textContent(),/图形设置不会/);
  await page.screenshot({path:path.join(root,'artifacts','standalone-control-panel.png')});
  await page.evaluate(()=>{window.systemInfo.network='<img src=x onerror=alert(1)>';});
  await page.locator('#refreshSystemInfo').click();
  await page.waitForFunction(()=>document.querySelector('[data-system-info="network"]').textContent.startsWith('<img'));
  assert.equal(await page.locator('[data-system-info="network"] img').count(),0);
  await page.evaluate(()=>{window.failSystemInfo=true;}); await page.locator('#refreshSystemInfo').click();
  await page.waitForFunction(()=>document.getElementById('systemInfoError').textContent.includes('SSH connection closed'));
  assert.equal(await page.locator('#systemInfoFields').isVisible(),false);
  await page.evaluate(()=>{window.failSystemInfo=false;window.deferSystemInfo=true;}); await page.locator('#refreshSystemInfo').click();
  await page.waitForFunction(()=>typeof window.resolveSystemInfo==='function');
  await page.evaluate(()=>{window.receive({type:'remoteState',status:'disconnected'});window.resolveSystemInfo({...window.systemInfo,hostname:'stale-host'});});
  await page.waitForFunction(()=>document.getElementById('refreshSystemInfo').disabled);
  assert.equal(await page.locator('#systemInfoFields').isVisible(),false);
  assert.equal(await page.locator('[data-system-info="hostname"]').textContent(),'');
  await page.locator('#settingsConnection').click(); await page.locator('#connectionDialog[open]').waitFor();
}));

test('public_filesystem_navigation_and_denied_directory_restore_previous_location', () => scenario('public-resources', async page => {
  await connect(page);
  await page.evaluate(()=>{window.directories['/']=[{name:'shared',path:'/shared',type:'folder'}];window.directories['/shared']=[{name:'locked',path:'/shared/locked',type:'folder'}];window.deniedDirectory='/shared/locked';});
  await page.locator('#homeShortcut').click();const win=page.locator('.window');
  await win.getByText('profile.txt',{exact:true}).waitFor();
  await win.locator('.window-path').fill('/');await win.locator('.window-path').press('Enter');
  await win.getByText('shared',{exact:true}).dblclick();await win.getByText('locked',{exact:true}).waitFor();
  await win.getByText('locked',{exact:true}).dblclick();
  await win.locator('.window-error').waitFor();
  assert.equal(await win.locator('.window-path').inputValue(),'/shared');
  assert.match(await win.locator('.window-error').textContent(),/无访问权限.*Permission denied[\s\S]*\/shared\/locked/);
  assert.equal(await win.getByText('locked',{exact:true}).count(),1);
  await win.locator('[data-window-action="back"]').click();await win.getByText('shared',{exact:true}).waitFor();
  assert.equal(await win.locator('.window-path').inputValue(),'/');
}));

test('desktop_picker_accepts_arbitrary_public_path_and_preserves_running_editor', () => scenario('desktop-location', async page => {
  await connect(page);await page.keyboard.press('Control+Alt+t');
  const terminal=await page.locator('.terminal-window').getAttribute('data-window-id');
  await page.evaluate(()=>{window.directories['/']=[{name:'shared',path:'/shared',type:'folder'}];window.directories['/shared']=[{name:'anything',path:'/shared/anything',type:'folder'}];window.directories['/shared/anything']=[{name:'public.txt',path:'/shared/anything/public.txt',type:'file'}];window.deniedDirectory='/locked';});
  await page.locator('#desktopSettings').click();await page.locator('#browseDesktopPath').click();
  await page.locator('#desktopPickerPath').fill('/');await page.locator('#desktopPickerGo').click();
  await page.locator('#desktopPickerEntries [data-path="/shared"]').dblclick();
  await page.locator('#desktopPickerEntries [data-path="/shared/anything"]').waitFor();
  await page.locator('#desktopPickerPath').fill('/locked');await page.locator('#desktopPickerGo').click();
  await page.waitForFunction(()=>document.getElementById('desktopPickerError').textContent.includes('无访问权限'));
  assert.equal(await page.locator('#desktopPickerPath').inputValue(),'/shared');
  await page.locator('#desktopPickerEntries [data-path="/shared/anything"]').dblclick();
  await page.waitForFunction(()=>document.getElementById('desktopPickerPath').value==='/shared/anything');
  await page.locator('#desktopPickerSelect').click();await page.locator('#applySettings').click();
  await page.locator('#settingsDialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#desktopPath').textContent(),'/shared/anything');
  assert.equal(await page.locator('#desktop').getAttribute('data-wallpaper'),'slate');
  assert.equal(await page.locator('#icons [data-path="/shared/anything/public.txt"]').count(),1);
  assert.equal(await page.locator('.terminal-window').getAttribute('data-window-id'),terminal);
  assert.equal(await page.evaluate(()=>window.messages.some(m=>m.type==='saveDesktopConfig')),false,'location only does not require remote configuration writes');
}));

test('desktop_switch_failure_preserves_desktop_and_form_then_handles_appearance_write_failure', () => scenario('desktop-location-errors', async page => {
  await connect(page);await page.locator('#desktopSettings').click();
  await page.evaluate(()=>{window.deniedDirectory='/locked';window.directories['/public']=[];});
  await page.locator('#settingsDesktopPath').fill('/locked');await page.locator('#settingsWallpaper').selectOption('purple');await page.locator('#applySettings').click();
  await page.waitForFunction(()=>document.getElementById('settingsError').textContent.includes('无访问权限'));
  assert.equal(await page.locator('#desktopPath').textContent(),desktop);
  assert.equal(await page.locator('#settingsWallpaper').inputValue(),'purple');
  assert.equal(await page.locator('#settingsDesktopPath').inputValue(),'/locked');
  await page.evaluate(()=>{window.failConfigSave=true;});
  await page.locator('#settingsDesktopPath').fill('/public');await page.locator('#applySettings').click();
  await page.waitForFunction(()=>document.getElementById('settingsError').textContent.includes('外观保存失败'));
  assert.equal(await page.locator('#desktopPath').textContent(),'/public');
  assert.equal(await page.locator('#settingsDialog').isVisible(),true);
  await page.evaluate(()=>{window.failConfigSave=false;});await page.locator('#applySettings').click();
  await page.locator('#settingsDialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#desktop').getAttribute('data-wallpaper'),'purple');
}));

test('missing_desktop_can_choose_existing_location_and_late_switch_cannot_restore_disconnected_session', () => scenario('missing-desktop-location', async page => {
  await page.evaluate(()=>{window.missingDesktop=true;window.directories['/public']=[];});await connect(page);
  await page.locator('#skipDesktop').click();await page.locator('#desktopSettings').click();
  assert.equal(await page.locator('#settingsDesktopPath').inputValue(),'/home/tester/rdesktop');
  assert.equal(await page.locator('#applySettings').isEnabled(),true);
  await page.locator('#settingsDesktopPath').fill('/public');await page.locator('#applySettings').click();
  await page.locator('#settingsDialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#desktopPath').textContent(),'/public');
  await page.locator('#desktopSettings').click();await page.locator('#settingsDesktopPath').fill('/delayed');
  await page.evaluate(()=>{window.deferDesktop=true;});await page.locator('#applySettings').click();
  await page.waitForFunction(()=>typeof window.resolveDesktop==='function');
  await page.evaluate(()=>{window.receive({type:'remoteState',status:'disconnected'});window.resolveDesktop({rootPath:'/delayed',homePath:'/home/tester',entries:[{name:'stale.txt',path:'/delayed/stale.txt',type:'file'}],config:{}});});
  assert.equal(await page.locator('#icons .icon').count(),0);
  assert.match(await page.locator('#desktopPath').textContent(),/连接 SSH/);
  assert.equal(await page.locator('#applySettings').isDisabled(),true);
}));

test('file_permission_denied_and_read_only_confirmation_are_explicit_and_failed_terminal_is_removed', () => scenario('file-permissions', async page => {
  await connect(page);await page.evaluate(()=>{window.deniedFile='/home/tester/Desktop/notes.txt';});
  await icon(page,'notes.txt').dblclick();await page.locator('#fileAccessDialog[open]').waitFor();
  assert.equal(await page.locator('#fileAccessTitle').textContent(),'无访问权限');
  assert.match(await page.locator('#fileAccessDetail').textContent(),/Permission denied/);
  assert.equal(await page.locator('.terminal-window').count(),0);await page.locator('#fileAccessCancel').click();
  await page.evaluate(()=>{window.deniedFile=null;window.readOnlyFile='/home/tester/Desktop/notes.txt';});
  await icon(page,'notes.txt').dblclick();await page.locator('#fileAccessReadOnly').waitFor();
  assert.equal(await page.locator('#fileAccessTitle').textContent(),'无编辑权限');
  await page.locator('#fileAccessCancel').click();assert.equal(await page.locator('.terminal-window').count(),0);
  await icon(page,'notes.txt').dblclick();await page.locator('#fileAccessReadOnly').click();
  await page.waitForFunction(()=>window.calls.some(m=>m.type==='openDocument'&&m.readOnly===true));
  await page.keyboard.press('Control+Alt+t');
  const id=await page.locator('.terminal-window').getAttribute('data-window-id');
  await page.evaluate(id=>window.receive({type:'fileAccessError',id,path:'/home/tester/Desktop/notes.txt',error:'Permission denied after permissions changed'}),id);
  assert.equal(await page.locator('.terminal-window').count(),0);await page.locator('#fileAccessDialog[open]').waitFor();
}));

test('desktop_switch_waits_for_backend_commit_without_abandoning_slow_persistence', () => scenario('desktop-location-delayed-commit', async page => {
  await connect(page);await page.locator('#desktopSettings').click();
  await page.clock.install();await page.evaluate(()=>{window.deferDesktop=true;});
  await page.locator('#settingsDesktopPath').fill('/delayed');await page.locator('#applySettings').click();
  await page.waitForFunction(()=>typeof window.resolveDesktop==='function');
  assert.equal(await page.locator('#applySettings').isDisabled(),true);
  await page.clock.fastForward(60000);
  assert.equal(await page.locator('#settingsError').textContent(),'');
  assert.equal(await page.locator('#applySettings').isDisabled(),true);
  await page.evaluate(()=>window.resolveDesktop({rootPath:'/delayed',homePath:'/home/tester',entries:[],config:{}}));
  await page.locator('#settingsDialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#desktopPath').textContent(),'/delayed');
}));

test('desktop_switch_backend_timeout_keeps_previous_location_and_releases_controls', () => scenario('desktop-location-backend-timeout', async page => {
  await connect(page);await page.locator('#desktopSettings').click();
  await page.evaluate(()=>{window.deferDesktop=true;});
  await page.locator('#settingsDesktopPath').fill('/delayed');await page.locator('#applySettings').click();
  await page.waitForFunction(()=>typeof window.rejectDesktop==='function');
  await page.evaluate(()=>window.rejectDesktop(new Error('切换桌面超时，请重试')));
  await page.waitForFunction(()=>document.getElementById('settingsError').textContent.includes('超时'));
  assert.equal(await page.locator('#applySettings').isEnabled(),true);
  assert.equal(await page.locator('#settingsDialog').isVisible(),true);
  assert.equal(await page.locator('#desktopPath').textContent(),desktop);
}));

test('unavailable_saved_desktop_keeps_home_and_settings_available_for_recovery', () => scenario('saved-desktop-recovery', async page => {
  await page.evaluate(()=>{window.unavailableDesktop=true;window.directories['/shared/recovered']=[{name:'restored.txt',path:'/shared/recovered/restored.txt',type:'file'}];});
  await connect(page);
  assert.match(await page.locator('#connection').textContent(),/已连接，桌面不可用/);
  assert.match(await page.locator('#notice').textContent(),/无访问权限.*Permission denied/);
  await page.locator('#homeShortcut').click();
  await page.locator('.window').getByText('profile.txt',{exact:true}).waitFor();
  assert.equal(await page.locator('#connectionDialog').isVisible(),false);
  await page.locator('#desktopSettings').click();
  assert.equal(await page.locator('#applySettings').isEnabled(),true);
  assert.equal(await page.locator('#browseDesktopPath').isEnabled(),true);
  assert.match(await page.locator('#settingsError').textContent(),/\/shared\/previous.*Permission denied/);
  await page.locator('#settingsDesktopPath').fill('/shared/recovered');await page.locator('#applySettings').click();
  await page.locator('#settingsDialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#desktopPath').textContent(),'/shared/recovered');
  assert.equal(await page.locator('#connection').textContent(),'SSH · 已连接');
  assert.equal(await page.locator('#icons [data-path="/shared/recovered/restored.txt"]').count(),1);
  await page.locator('#desktopSettings').click();assert.equal(await page.locator('#settingsError').textContent(),'');
}));

test('late_file_permission_result_after_disconnect_does_not_open_editor', () => scenario('late-file-permissions', async page => {
  await connect(page);await page.evaluate(()=>{window.deferFileAccess=true;});await icon(page,'notes.txt').dblclick();
  await page.waitForFunction(()=>typeof window.resolveFileAccess==='function');
  await page.evaluate(()=>{window.receive({type:'remoteState',status:'disconnected'});window.resolveFileAccess({readable:true,writable:true});});
  assert.equal(await page.locator('.terminal-window').count(),0);
  assert.equal(await page.evaluate(()=>window.messages.some(m=>m.type==='openTerminal')),false);
}));

test('clock_uses_server_zone_or_explicit_offset_without_client_timezone_fallback', () => scenario('server-local-clock', async page => {
  await connect(page);
  await page.evaluate(()=>window.receive({type:'serverInfo',epochMs:Date.UTC(2026,0,2,3,4,5),timeZone:'Asia/Shanghai',utcOffsetMinutes:480,timeZoneLabel:'Asia/Shanghai · UTC+08:00',remote:true}));
  assert.match(await page.locator('#serverClock').textContent(),/11:04:05.*Asia\/Shanghai.*UTC\+08:00/);
  await page.evaluate(()=>window.receive({type:'serverInfo',epochMs:Date.UTC(2026,0,2,3,4,5),timeZone:'SERVER-CUSTOM',utcOffsetMinutes:345,timeZoneLabel:'NPT · UTC+05:45',remote:true}));
  assert.match(await page.locator('#serverClock').textContent(),/08:49:05.*NPT.*UTC\+05:45/);
  await page.evaluate(()=>window.receive({type:'serverInfo',epochMs:Date.UTC(2026,0,2,3,4,5),timeZone:'SERVER-CUSTOM',remote:true}));
  assert.equal(await page.locator('#serverClock').textContent(),'服务器时间 —');
}));

test('monaco_default_readonly_and_fixed_launcher_have_no_vim_file_route', () => scenario('workbench-open-routes', async page => {
  await page.evaluate(() => { window.remoteDesktop.openDocument = async(path,options) => window.calls.push({type:'openDocument',path,...options}); });
  await connect(page); await icon(page,'notes.txt').dblclick();
  await page.waitForFunction(()=>window.calls.some(value=>value.type==='openDocument'&&!value.readOnly));
  assert.equal(await page.locator('.terminal-window').count(),0);
  await page.evaluate(()=>{window.readOnlyFile='/home/tester/Desktop/notes.txt';});
  await icon(page,'notes.txt').dblclick();await page.locator('#fileAccessReadOnly').click();
  await page.waitForFunction(()=>window.calls.some(value=>value.type==='openDocument'&&value.readOnly));
  await page.evaluate(()=>{window.readOnlyFile=null;});await icon(page,'notes.txt').click({button:'right'});
  assert.equal(await page.locator('#context [data-action=vim]').count(),0);
  await page.keyboard.press('Escape');await page.locator('#applicationsButton').click();await page.locator('[data-application=editor]').click();
  await page.waitForFunction(()=>window.calls.some(value=>value.type==='openDocument'&&value.path===null));
}));

test('transfer_center_upload_destination_download_and_browser_entry', () => scenario('transfer-controls', async page => {
  await page.evaluate(() => {
    window.remoteDesktop.chooseUpload=async()=>{window.calls.push({type:'chooseUpload'});return ['D:\\projects\\code.py','D:\\projects\\folder'];};
    window.directories['/shared']=[];
    window.remoteDesktop.chooseDownloadDirectory=async()=>{window.calls.push({type:'chooseDownloadDirectory'});return 'D:\\saved';};
    window.remoteDesktop.download=async(path,id,destination)=>{window.calls.push({type:'download',path,id,destination});return {id,path:destination+'\\code.py'};};
    window.remoteDesktop.openBrowser=async url=>{window.calls.push({type:'openBrowser',url});return {id:41,embedded:true};};
  });
  await connect(page);await page.locator('#downloadsButton').click();
  assert.equal(await page.locator('.transfer-controls button').count(),2);
  await page.locator('#transferUpload').click();
  const picker=page.locator('.server-picker-window');await picker.waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(value=>value.type==='upload').length),0);
  assert.equal(await page.evaluate(()=>window.calls.some(value=>value.type==='chooseUpload')),true);
  await picker.locator('.window-picker-path').fill('/shared');await picker.locator('[data-window-action="pick"]').click();
  await page.waitForFunction(()=>window.calls.filter(value=>value.type==='upload').length===2);
  assert.match(await page.locator('#downloadItems strong').first().textContent(),/^↑ 上传 · code.py$/);
  assert.equal(await page.locator('#downloadItems progress:visible, #downloadItems .transfer-cancel:visible').count(),0);
  await page.locator('#transferDownload').click();await picker.waitFor();
  assert.equal(await page.evaluate(()=>window.calls.some(value=>value.type==='chooseDownloadDirectory')),false);
  await picker.locator('.window-picker-path').fill('/shared/code.py');await picker.locator('[data-window-action="pick"]').click();
  await page.waitForFunction(()=>window.calls.some(value=>value.type==='download'&&value.destination==='D:\\saved'));
  await page.locator('#closeDownloads').click();await page.locator('#browserButton').click();
  await page.waitForFunction(()=>window.calls.some(value=>value.type==='openBrowser'));
}));

test('transfer_server_picker_reuses_virtual_explorer_and_selects_files_without_opening_editor', () => scenario('transfer-explorer-picker', async page => {
  await page.evaluate(() => { window.remoteDesktop.openDocument = async path => window.calls.push({type:'openDocument',path}); });
  await connect(page); await icon(page,'projects').dblclick();
  const win = page.locator('#windows .window').first();
  await win.getByText('source.txt',{exact:true}).waitFor();
  await win.getByText('source.txt',{exact:true}).click();
  await page.locator('#downloadsButton').click();
  await page.locator('#transferDownload').click();
  await win.locator('.window-picker-bar').waitFor();
  assert.equal(await page.locator('#windows .window').count(),1);
  assert.equal(await page.locator('#downloadsPanel').isVisible(),false);
  assert.equal(await win.locator('.window-path').inputValue(),`${desktop}/projects`);
  await win.getByText('source.txt',{exact:true}).dblclick();
  await page.locator('#downloadsPanel').waitFor();
  assert.equal(await page.evaluate(()=>window.calls.find(call=>call.type==='download').path),`${desktop}/projects/source.txt`);
  assert.equal(await win.locator('.window-picker-bar').isVisible(),false);
  assert.equal(await page.evaluate(()=>window.calls.some(call=>call.type==='openDocument')),false);
  assert.equal(await page.locator('#windows .window').count(),1);
}));

test('transfer_server_picker_allows_direct_paths_and_retains_last_accessible_directory', () => scenario('transfer-explorer-path', async page => {
  await connect(page); await page.locator('#downloadsButton').click();
  await page.locator('#transferDownload').click();
  const win = page.locator('.server-picker-window'); await win.getByText('notes.txt',{exact:true}).waitFor();
  await page.evaluate(() => { window.deniedDirectory = '/private'; window.deniedFile = '/private'; });
  await win.locator('.window-path').fill('/private'); await win.locator('.window-path').press('Enter');
  await page.waitForFunction(()=>document.querySelector('.server-picker-window .window-error')?.textContent.includes('无访问权限'));
  assert.equal(await win.locator('.window-path').inputValue(),desktop);
  await win.locator('.window-picker-path').fill('/private'); await win.locator('[data-window-action="pick"]').click();
  await page.waitForFunction(()=>document.querySelector('.server-picker-window .window-error')?.textContent.includes('无访问权限'));
  assert.equal(await win.count(),1);
  await win.locator('.window-picker-path').fill('~/Desktop/notes.txt'); await win.locator('.window-picker-path').press('Enter');
  await page.locator('#downloadsPanel').waitFor();
  assert.equal(await page.evaluate(()=>window.calls.find(call=>call.type==='download').path),`${desktop}/notes.txt`);
  assert.equal(await page.locator('.server-picker-window').count(),0);
  await page.locator('#transferDownload').click();
  await page.locator('.server-picker-window [data-window-action="cancel-picker"]').click();
  await page.locator('#downloadsPanel').waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.type==='download').length),1);
}));

test('embedded_browser_shell_dock_bounds_visibility_and_lifecycle', () => scenario('browser-window', async page => {
  await connect(page);
  assert.equal(await page.locator('#applicationsButton').count(), 1);
  await page.locator('#browserButton').click();
  const win = page.locator('.browser-window'); await win.waitFor();
  const browserIcon = win.locator('.browser-app-icon');
  assert.equal(await browserIcon.count(), 1, 'browser window titlebar uses a dedicated browser icon');
  assert.equal(await win.locator('.window-app-icon.glyph.folder').count(), 0, 'browser window must not use the explorer folder icon');
  assert.equal(await browserIcon.locator('svg').count(), 1, 'browser icon is rendered as a Lucide globe');
  await page.screenshot({path:path.join(root,'artifacts','standalone-browser-window.png')});
  await page.waitForFunction(()=>window.calls.some(call=>call.type==='browserLayout'&&!call.hidden));
  const bounds = await win.locator('.browser-surface').boundingBox();
  const layout = await page.evaluate(()=>window.calls.filter(call=>call.type==='browserLayout').at(-1));
  assert.ok(Math.abs(layout.bounds.x-bounds.x)<=1); assert.ok(Math.abs(layout.bounds.height-bounds.height)<=1);
  await page.locator('#browserButton').click(); assert.equal(await win.count(),1);
  assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.type==='openBrowser').length),1);
  await win.locator('[data-window-action="maximize"]').click();
  await page.waitForFunction(()=>window.calls.filter(call=>call.type==='browserLayout').at(-1).bounds.width>1200);
  await win.locator('[data-window-action="minimize"]').click();
  await page.waitForFunction(()=>window.calls.filter(call=>call.type==='browserLayout').at(-1).hidden);
  await page.locator('#windowTabs [data-window-id="browser-41"]').click();
  await page.waitForFunction(()=>!window.calls.filter(call=>call.type==='browserLayout').at(-1).hidden);
  await page.locator('#desktopSettings').click();
  await page.waitForFunction(()=>window.calls.filter(call=>call.type==='browserLayout').at(-1).hidden);
  await page.locator('#browserButton').click();
  await page.waitForFunction(()=>!window.calls.filter(call=>call.type==='browserLayout').at(-1).hidden);
  assert.equal(await page.locator('#settingsDialog').isVisible(),true,'nonmodal settings may remain open behind active browser');
  await page.locator('#desktopSettings').click();
  await page.waitForFunction(()=>window.calls.filter(call=>call.type==='browserLayout').at(-1).hidden);
  await page.locator('#closeSettings').click();
  await page.waitForFunction(()=>!window.calls.filter(call=>call.type==='browserLayout').at(-1).hidden);
  await page.locator('#downloadsButton').click();
  await page.waitForFunction(()=>window.calls.filter(call=>call.type==='browserLayout').at(-1).hidden);
  await page.locator('#closeDownloads').click();
  await page.waitForFunction(()=>!window.calls.filter(call=>call.type==='browserLayout').at(-1).hidden);
  await page.locator('#connectButton').click();
  await page.waitForFunction(()=>window.calls.filter(call=>call.type==='browserLayout').at(-1).hidden);
  await page.locator('#closeConnection').click();
  await page.waitForFunction(()=>!window.calls.filter(call=>call.type==='browserLayout').at(-1).hidden);
  await page.evaluate(()=>{document.getElementById('context').hidden=false;});
  await page.waitForFunction(()=>window.calls.filter(call=>call.type==='browserLayout').at(-1).hidden);
  await page.locator('#browserButton').click();
  await page.waitForFunction(()=>!window.calls.filter(call=>call.type==='browserLayout').at(-1).hidden);
  await win.locator('[data-window-action="minimize"]').click();
  await page.waitForFunction(()=>window.calls.filter(call=>call.type==='browserLayout').at(-1).hidden);
  await page.evaluate(()=>window.browserEvent({type:'focus',id:41}));
  await page.waitForFunction(()=>!window.calls.filter(call=>call.type==='browserLayout').at(-1).hidden);
  assert.equal(await win.isVisible(),true,'new popup tab focus restores its virtual browser');
  await page.evaluate(()=>window.browserEvent({type:'closed',id:41}));
  assert.equal(await win.count(),0);
  assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.type==='closeBrowser').length),0,'closed event does not recursively close manager');
  await page.locator('#browserButton').click(); await win.waitFor();
  await win.locator('[data-window-action="close"]').click();
  assert.equal(await win.count(),0); assert.ok(await page.evaluate(()=>window.calls.some(call=>call.type==='closeBrowser')));
  await page.locator('#browserButton').click(); await win.waitFor();
  await page.evaluate(()=>window.receive({type:'remoteState',status:'disconnected'}));
  assert.equal(await win.count(),0);
  await page.evaluate(()=>window.browserEvent({type:'focus',id:41}));
  assert.equal(await win.count(),0,'late popup cannot resurrect disconnected shell');
}));

test('embedded_browser_deduplicates_pending_open_and_disposes_late_connection_result', () => scenario('browser-window-opening', async page => {
  await connect(page); await page.evaluate(()=>{window.deferBrowserOpen=true;});
  await page.locator('#browserButton').click(); await page.locator('#browserButton').click();
  await page.waitForFunction(()=>typeof window.resolveBrowserOpen==='function');
  assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.type==='openBrowser').length),1);
  await page.evaluate(()=>{window.receive({type:'remoteState',status:'disconnected'});window.resolveBrowserOpen({id:88,embedded:true});});
  await page.waitForFunction(()=>window.calls.some(call=>call.type==='closeBrowser'&&call.id===88));
  assert.equal(await page.locator('.browser-window').count(),0);
}));

test('cli_activity_toast_stream_snapshot_dedup_and_monitor_window_lifecycle', () => scenario('activity-stream', async page => {
  await connect(page);
  await page.evaluate(() => {
    window.activitySession = { id: 'cli-1', time: '2026-09-19T01:02:03.000Z', ip: '192.0.2.7', ipSource: 'ssh-local-address', action: 'exec', logPath: '/home/tester/Desktop/.log/cli-1.log', status: 'running' };
    window.activityCommand = { id: 'entry-1', seq: 1, source: 'cli', sessionId: 'cli-1', type: 'command', time: window.activitySession.time, action: 'exec', args: { command: 'printf "你好\\n"' } };
    window.activityEvent({ type: 'connection', session: window.activitySession });
    window.activityEvent({ type: 'entry', entry: window.activityCommand });
    window.activityEvent({ type: 'state', connected: true, sessions: [window.activitySession], entries: [window.activityCommand], systemLogPath: '/home/tester/Desktop/.log/system.log' });
  });
  await page.locator('#activityToast').waitFor();
  assert.match(await page.locator('#activityToastIp').textContent(), /192\.0\.2\.7.*SSH 本机出口/);
  assert.match(await page.locator('#activityToastTime').textContent(), /2026/);
  assert.equal(await page.locator('.activity-window').count(), 0, 'recording does not depend on opening the monitor');
  await page.locator('#openActivityToast').click();
  const win = page.locator('.activity-window'); await win.waitFor();
  assert.equal(await win.evaluate(element => element.parentElement.id), 'windows');
  assert.equal(await win.locator('.activity-entry').count(), 1, 'live entry and snapshot are deduplicated');
  assert.match(await win.locator('.activity-events').textContent(), /printf/);
  assert.match(await win.locator('.activity-metadata').textContent(), /\.log\/cli-1\.log/);
  await page.evaluate(() => window.activityEvent({ type: 'entry', entry: { id: 'entry-2', seq: 2, sessionId: 'cli-1', type: 'output', stream: 'stdout', data: '你好\n下一行', time: '2026-09-19T01:02:04.000Z' } }));
  await page.waitForFunction(() => document.querySelector('.activity-events').textContent.includes('你好\n下一行'));
  await page.evaluate(() => window.activityEvent({ type: 'session', session: { ...window.activitySession, logPath: '/home/tester/Desktop/.log/cli-1.2.log', logPaths: ['/home/tester/Desktop/.log/cli-1.log', '/home/tester/Desktop/.log/cli-1.2.log'] } }));
  await page.waitForFunction(() => document.querySelector('.activity-metadata').textContent.includes('cli-1.2.log'));
  assert.equal(await page.locator('#activityToast').isVisible(), false, 'log rotation updates metadata without a new connection notification');
  await page.locator('#activityButton').click(); assert.equal(await win.count(), 1);
  await win.locator('[data-window-action="maximize"]').click(); assert.ok((await win.getAttribute('class')).includes('maximized'));
  await win.locator('[data-window-action="minimize"]').click(); assert.equal(await win.isVisible(), false);
  await page.locator('#windowTabs [data-window-id="activity-window"]').click(); assert.equal(await win.isVisible(), true);
  await page.screenshot({ path: path.join(root, 'artifacts', 'standalone-activity-monitor.png') });
  await win.locator('[data-window-action="close"]').click(); assert.equal(await win.count(), 0);
  await page.evaluate(() => window.activityEvent({ type: 'entry', entry: { id: 'entry-3', seq: 3, sessionId: 'cli-1', type: 'end', exitCode: 0, time: '2026-09-19T01:02:05.000Z' } }));
  await page.locator('#activityButton').click(); assert.equal(await win.locator('.activity-entry').count(), 3, 'closing monitor leaves incoming recording intact');
}));

test('cli_activity_permission_errors_ip_truthful_and_session_selection', () => scenario('activity-error', async page => {
  await connect(page);
  await page.evaluate(() => {
    const sessions = [
      { id: 'cli-a', time: '2026-09-19T01:01:01.000Z', action: 'exec', ip: null, logPath: '/desktop/.log/cli-a.log' },
      { id: 'cli-b', time: '2026-09-19T01:02:01.000Z', action: 'upload', ip: null, error: 'Permission denied: /desktop/.log', logPath: '/desktop/.log/cli-b.log' }
    ];
    for (const session of sessions) window.activityEvent({ type: 'connection', session });
    window.activityEvent({ type: 'state', sessions, entries: [
      { id: 'a', seq: 1, sessionId: 'cli-a', type: 'command', command: 'whoami' },
      { id: 'b', seq: 2, sessionId: 'cli-b', type: 'error', message: '<img src=x onerror="window.activityInjected=true">' }
    ], connected: true, error: 'Permission denied: /desktop/.log' });
  });
  assert.match(await page.locator('#activityToastIp').textContent(), /本机命名管道（无网络 IP）/);
  await page.waitForFunction(() => document.querySelector('.activity-toast-note').textContent.includes('Permission denied'));
  await page.locator('#openActivityToast').click();
  const win = page.locator('.activity-window');
  assert.equal(await win.locator('.activity-session').inputValue(), 'cli-b');
  assert.match(await win.locator('.activity-error').textContent(), /Permission denied/);
  assert.equal(await win.locator('.activity-events img').count(), 0);
  assert.equal(await page.evaluate(() => window.activityInjected), undefined);
  await win.locator('.activity-session').selectOption('cli-a');
  assert.match(await win.locator('.activity-events').textContent(), /whoami/);
  assert.doesNotMatch(await win.locator('.activity-events').textContent(), /onerror/);
  await page.evaluate(() => { window.activityEvent({ type: 'state', connected: false, error: 'SSH disconnected' }); window.receive({ type: 'remoteState', status: 'disconnected' }); });
  await page.waitForFunction(() => document.querySelector('.activity-status').textContent.includes('已断开'));
  assert.equal(await win.isVisible(), true, 'disconnect keeps recent monitor history available');
}));

test('cli_activity_toast_and_monitor_hide_native_browser_surface', () => scenario('activity-browser', async page => {
  await connect(page); await page.locator('#browserButton').click();
  await page.waitForFunction(() => window.calls.filter(call => call.type === 'browserLayout').at(-1)?.hidden === false);
  await page.evaluate(() => window.activityEvent({ type: 'connection', session: { id: 'cli-overlay', time: new Date().toISOString(), action: 'exec' } }));
  await page.waitForFunction(() => window.calls.filter(call => call.type === 'browserLayout').at(-1).hidden);
  await page.locator('#closeActivityToast').click();
  await page.waitForFunction(() => !window.calls.filter(call => call.type === 'browserLayout').at(-1).hidden);
  await page.locator('#activityButton').click();
  await page.waitForFunction(() => window.calls.filter(call => call.type === 'browserLayout').at(-1).hidden);
  await page.locator('.activity-window [data-window-action="minimize"]').click();
  await page.waitForFunction(() => !window.calls.filter(call => call.type === 'browserLayout').at(-1).hidden);
}));

test('cli_activity_rendering_is_bounded_and_keeps_latest_entries', () => scenario('activity-bounded', async page => {
  await connect(page);
  await page.evaluate(() => {
    window.activityEvent({ type: 'connection', session: { id: 'cli-bounded', action: 'exec', time: new Date().toISOString() } });
    window.activityEvent({ type: 'state', connected: true, sessions: [], entries: Array.from({ length: 650 }, (_, index) => ({ id: `bounded-${index}`, seq: index + 1, sessionId: 'cli-bounded', type: 'output', data: `record-${index}` })) });
  });
  await page.locator('#openActivityToast').click();
  const win = page.locator('.activity-window');
  assert.equal(await win.locator('.activity-entry').count(), 600);
  assert.match(await win.locator('.activity-entry').first().textContent(), /record-50/);
  assert.match(await win.locator('.activity-entry').last().textContent(), /record-649/);
  await page.evaluate(() => window.activityEvent({ type: 'entry', entry: { id: 'huge', seq: 651, sessionId: 'cli-bounded', type: 'output', data: 'a'.repeat(100000) } }));
  await page.waitForFunction(() => document.querySelector('.activity-entry:last-child').textContent.includes('界面显示已截断'));
  assert.ok((await win.locator('.activity-entry').last().textContent()).length < 34000);
}));

test('cancelled_pending_transfer_picker_can_be_reopened_in_reused_explorer', () => scenario('transfer-picker-pending-cancel', async page => {
  await connect(page); await icon(page,'projects').dblclick();
  await page.locator('.window').getByText('source.txt',{exact:true}).click();
  await page.locator('#downloadsButton').click(); await page.locator('#transferDownload').click();
  await page.evaluate(()=>{const list=window.remoteDesktop.list;window.remoteDesktop.list=path=>path==='/deferred' ? new Promise(resolve=>{window.resolvePickerList=resolve;}) : list(path);});
  const win = page.locator('.server-picker-window');
  await win.locator('.window-picker-path').fill('/deferred'); await win.locator('[data-window-action="pick"]').click();
  await page.waitForFunction(()=>typeof window.resolvePickerList==='function');
  await win.locator('[data-window-action="cancel-picker"]').click(); await page.locator('#downloadsPanel').waitFor();
  await page.locator('#transferDownload').click(); await win.waitFor();
  assert.equal(await win.locator('[data-window-action="pick"]').isEnabled(),true,'new picker must reset a cancelled pending validation');
  await page.evaluate(()=>window.resolvePickerList([]));
  assert.equal(await win.count(),1,'old validation cannot close the new picker');
}));

test('transfer_download_multiselect_uses_one_destination_and_preserves_sources', () => scenario('transfer-multi-download', async page => {
  await connect(page);await page.locator('#downloadsButton').click();await page.locator('#transferDownload').click();
  const win=page.locator('.server-picker-window');await win.locator(`[data-path="${desktop}/projects"]`).click();
  await win.locator(`[data-path="${desktop}/notes.txt"]`).click({modifiers:['Control']});
  assert.match(await win.locator('.window-picker-count').textContent(),/已选择 2 项/);
  await win.locator('[data-window-action="pick"]').click();
  await page.waitForFunction(()=>window.calls.filter(call=>call.type==='download').length===2);
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(call=>call.type==='download').map(call=>call.path)),[`${desktop}/projects`,`${desktop}/notes.txt`]);
  assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.type==='chooseDownloadDirectory').length),1);
  assert.equal(await page.evaluate(()=>window.calls.some(call=>call.type==='openDocument')),false);
}));

test('transfer_cancel_and_late_local_selection_do_not_start_or_cross_connections', () => scenario('transfer-cancel-stale', async page => {
  await connect(page);await page.locator('#downloadsButton').click();
  await page.evaluate(()=>{window.remoteDesktop.chooseUpload=async()=>[];});
  await page.locator('#transferUpload').click();
  assert.equal(await page.locator('.server-picker-window').count(),0);
  assert.equal(await page.locator('.download-item').count(),0);
  await page.evaluate(()=>{window.remoteDesktop.chooseUpload=()=>new Promise(resolve=>{window.resolveUploadChoice=resolve;});});
  await page.locator('#transferUpload').click();await page.waitForFunction(()=>typeof window.resolveUploadChoice==='function');
  assert.equal(await page.locator('#transferDownload').isDisabled(),true);
  await page.evaluate(()=>window.receive({type:'remoteState',status:'disconnected'}));
  await page.locator('#connectButton').click();await connect(page);
  await page.evaluate(()=>window.resolveUploadChoice(['D:\\stale.txt']));
  assert.equal(await page.locator('.server-picker-window').count(),0);
  assert.equal(await page.evaluate(()=>window.calls.some(call=>call.type==='upload')),false);
  await page.evaluate(()=>{window.remoteDesktop.chooseDownloadDirectory=async()=>null;});
  await page.locator('#transferDownload').click();
  await page.locator('.server-picker-window .window-picker-path').fill(`${desktop}/notes.txt`);
  await page.locator('.server-picker-window [data-window-action="pick"]').click();
  assert.equal(await page.locator('.download-item').count(),0);
}));

test('remote_html_drag_downloads_to_local_and_local_drop_prompts_server_destination', () => scenario('transfer-drops', async page => {
  await connect(page);await page.locator('#downloadsButton').click();
  await page.evaluate(()=>{
    const data=new DataTransfer();data.setData('application/x-remote-desktop',JSON.stringify({paths:['/home/tester/Desktop/projects','/home/tester/Desktop/notes.txt']}));
    document.getElementById('downloadsPanel').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));
  });
  await page.waitForFunction(()=>window.calls.filter(call=>call.type==='download').length===2);
  assert.equal(await page.locator('.server-picker-window').count(),0);
  await page.evaluate(()=>{
    const data=new DataTransfer();data.items.add(new File(['print(1)'],'local.py'));data.items.add(new File(['text'],'notes.txt'));
    document.getElementById('desktop').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));
  });
  const win=page.locator('.server-picker-window');await win.waitFor();
  assert.deepEqual(await page.evaluate(()=>window.calls.find(call=>call.type==='acceptDroppedFiles').names),['local.py','notes.txt']);
  assert.equal(await page.evaluate(()=>window.calls.some(call=>call.type==='chooseUpload')),false);
  assert.equal(await page.evaluate(()=>window.calls.some(call=>call.type==='upload')),false);
  await win.locator('[data-window-action="pick"]').click();
  await page.waitForFunction(()=>window.calls.filter(call=>call.type==='upload').length===2);
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(call=>call.type==='upload').map(call=>call.remoteDirectory)),[desktop,desktop]);
  assert.equal(await page.evaluate(()=>window.messages.some(message=>message.operation==='paste')),false);
}));

test('desktop_pointer_drag_to_transfer_center_downloads_without_reposition_or_move', () => scenario('transfer-desktop-drag', async page => {
  await connect(page);await page.locator('#downloadsButton').click();
  const source=await icon(page,'notes.txt').boundingBox();const target=await page.locator('#downloadsPanel').boundingBox();
  await page.mouse.move(source.x+source.width/2,source.y+30);await page.mouse.down();
  await page.mouse.move(target.x+target.width/2,target.y+70,{steps:10});await page.mouse.up();
  await page.waitForFunction(()=>window.calls.some(call=>call.type==='download'));
  assert.equal(await page.evaluate(()=>window.calls.find(call=>call.type==='download').path),`${desktop}/notes.txt`);
  assert.equal(await page.evaluate(()=>window.messages.some(message=>message.operation==='paste'||message.type==='saveDesktopConfig')),false);
}));

test('transfer_history_can_open_targets_delete_finished_and_keep_active_tasks', () => scenario('transfer-history', async page => {
  await connect(page);await page.locator('#downloadsButton').click();
  await page.evaluate(()=>{
    window.progress({id:'upload-done',direction:'upload',source:'D:\\project.py',path:'/home/tester/Desktop/projects/project.py',status:'complete'});
    window.progress({id:'download-done',direction:'download',source:'/tmp/file.txt',path:'D:\\Downloads\\file.txt',status:'complete'});
    window.progress({id:'failed',direction:'download',source:'/tmp/fail',status:'error',error:'permission denied'});
    window.progress({id:'active',direction:'download',source:'/tmp/live',status:'running',done:1,total:100});
  });
  const upload=page.locator('[data-download-id="upload-done"]');
  assert.equal(await upload.locator('progress, .transfer-cancel').evaluateAll(nodes=>nodes.every(node=>node.hidden)),true);
  await page.evaluate(()=>{window.transferTarget={side:'remote',path:'/home/tester/Desktop/projects'};});
  await upload.locator('.transfer-target').click();
  await page.locator('.window').getByText('source.txt',{exact:true}).waitFor();
  await page.locator('#downloadsButton').click();
  await page.evaluate(()=>{window.transferTarget={side:'local'};});
  await page.locator('[data-download-id="download-done"] .transfer-target').click();
  assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.type==='openTransferTarget').length),2);
  await page.locator('[data-download-id="failed"] .transfer-remove').click();
  assert.equal(await page.locator('[data-download-id="failed"]').count(),0);
  await page.locator('#clearTransferHistory').click();
  assert.deepEqual(await page.locator('.download-item').evaluateAll(nodes=>nodes.map(node=>node.dataset.downloadId)),['active']);
  assert.equal(await page.locator('[data-download-id="active"] progress').isVisible(),true);
  assert.equal(await page.locator('[data-download-id="active"] .transfer-remove').isVisible(),false);
  await page.evaluate(()=>window.progress({type:'removed',id:'active'}));
  assert.equal(await page.locator('.download-item').count(),0);
  await page.evaluate(()=>window.progress({type:'history-error',error:'无法保存传输历史：Permission denied'}));
  assert.match(await page.locator('#transferError').textContent(),/无法保存传输历史/);
}));
