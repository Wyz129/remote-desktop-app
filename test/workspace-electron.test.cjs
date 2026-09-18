'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn, spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');
const { listInstances } = require('../lib/instance-bridge.cjs');
const project = path.resolve(__dirname, '..');

test('integrated shortcut target, CLI upload/exec, Monaco conflict and HTML/notebook isolation', { timeout:180000 }, async t => {
  const fixture = await createSshFixture(); let application;
  t.after(async () => {
    if (application && application.process().exitCode === null) {
      const timer=setTimeout(()=>{if(process.platform==='win32')spawnSync('taskkill',['/pid',String(application.process().pid),'/T','/F'],{windowsHide:true});else application.process().kill('SIGKILL');},5000);
      try {await application.close();}finally{clearTimeout(timer);}
    }
    await fixture.close();
  });
  await fixture.put('Desktop/source.py','print("original")\n');
  await fixture.put('Desktop/site/index.html','<!doctype html><link rel="stylesheet" href="style.css"><div id="hello">loading</div><img id="pixel" src="pixel.png"><script src="main.js"></script>');
  await fixture.put('Desktop/site/style.css','#hello{color:rgb(1, 120, 30)}');
  await fixture.put('Desktop/site/main.js','document.getElementById("hello").textContent="remote resource loaded";');
  await fixture.put('Desktop/site/pixel.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=','base64'));
  await fixture.put('Desktop/book.ipynb',JSON.stringify({nbformat:4,nbformat_minor:5,metadata:{language_info:{name:'python'}},cells:[{id:'markdown',cell_type:'markdown',metadata:{},source:'# Notebook\n\n$x^2$'},{id:'code',cell_type:'code',metadata:{},source:'print(42)',execution_count:1,outputs:[{output_type:'stream',name:'stdout',text:'42\n'},{output_type:'display_data',metadata:{},data:{'text/html':'<b>existing output</b><script>window.pwned=true</script>'}}]}]}));
  fixture.link(`${fixture.home}/Desktop/public-link`,'/outside');
  await fs.writeFile(path.join(fixture.outsideRoot,'shared.txt'),'shared');
  const userData=path.join(fixture.root,'workspace-app');await fs.mkdir(userData);
  await fs.writeFile(path.join(userData,'settings.json'),JSON.stringify({host:fixture.config.host,port:fixture.config.port,username:fixture.username,knownHosts:{[`${fixture.config.host}:${fixture.config.port}`]:fixture.fingerprint}}));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.env.REMOTE_DESKTOP_TEST_EXE;
  application=await electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[project]),'--smoke-test',`--user-data-dir=${userData}`],env});
  application.on('window',work=>{work.on('pageerror',error=>console.error('Renderer error:',error.stack));});
  const page=await application.firstWindow();page.setDefaultTimeout(15000);
  await application.evaluate(({dialog})=>{globalThis.answers=[];globalThis.promptLog=[];dialog.showMessageBox=async(_win,options)=>{globalThis.promptLog.push(options);return {response:globalThis.answers.shift()??options.cancelId??0};};});
  const answer=response=>application.evaluate((_electron,value)=>globalThis.answers.push(value),response);
  const closeDocument=()=>application.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('/app/workbench.html'));setImmediate(()=>window.close());});
  await page.locator('#connectionDialog[open]').waitFor();await page.locator('#sshPassword').fill(fixture.password);await page.locator('#connectSubmit').click();await page.locator('#connectionDialog').waitFor({state:'hidden'});
  await page.locator(`#icons [data-path="${fixture.home}/Desktop/public-link"]`).dblclick();
  await page.locator('.window .entry').getByText('shared.txt',{exact:true}).waitFor();assert.equal(await page.locator('.window-path').inputValue(),'/outside');
  await page.locator('.window [data-window-action=close]').click();
  let instances=[];for(let i=0;i<50&&!instances.length;i++){instances=await listInstances(userData);if(!instances.length)await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(instances.length,1);
  const cli=async args=>new Promise((resolve,reject)=>{
    const script=executablePath?path.join(path.dirname(executablePath),'resources/cli/scripts/cli.cjs'):path.join(project,'scripts/cli.cjs');
    const executable=executablePath||process.execPath;
    const child=spawn(executable,[script,'--user-data-dir',userData,...args],{windowsHide:true,env:{...env,...(executablePath?{ELECTRON_RUN_AS_NODE:'1'}:{})}});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
  const status=await cli(['status']);assert.equal(status.code,0);assert.equal(JSON.parse(status.stdout).connected,true);
  const command=await cli(['exec','--','fixture-command']);assert.equal(command.code,7);assert.equal(command.stdout,'remote command reply\n');assert.match(command.stderr,/diagnostic/);
  const localUpload=path.join(fixture.root,'cli-upload.txt');await fs.writeFile(localUpload,'uploaded through running instance');
  const uploaded=await cli(['upload',localUpload,'/outside']);assert.equal(uploaded.code,0,uploaded.stderr);
  assert.equal(await fs.readFile(path.join(fixture.outsideRoot,'cli-upload.txt'),'utf8'),'uploaded through running instance');
  if (!await page.locator('#downloadsPanel').isVisible()) await page.locator('#downloadsButton').click();await page.locator('#downloadItems').getByText(/cli-upload.txt/).first().waitFor();
  await page.locator('#closeDownloads').click();
  async function openDocument(name){const opened=application.waitForEvent('window');await page.locator(`#icons [data-path="${fixture.home}/Desktop/${name}"]`).dblclick();const work=await opened;work.setDefaultTimeout(15000);work.on('pageerror',error=>console.error('Workbench renderer:',error.message));work.on('console',message=>{if(message.type()==='error') console.error('Workbench console:',message.text());});try {await work.waitForFunction(()=>window.monaco?.editor.getModels().length>0);await work.waitForFunction(()=>document.getElementById('filePath').textContent.startsWith('/'));}catch(error){console.error('Workbench state:',await work.locator('body').innerText());throw error;}return work;}
  const editor=await openDocument('source.py');assert.equal(await editor.locator('#language').inputValue(),'python');
  assert.equal(await editor.evaluate(()=>typeof window.remoteDesktop),'undefined');
  await editor.evaluate(()=>monaco.editor.getModels()[0].setValue('print("edited")\n'));await editor.locator('#save').click();
  await editor.waitForFunction(()=>document.getElementById('status').textContent.includes('已保存'));assert.equal(await fs.readFile(fixture.mapPath(`${fixture.home}/Desktop/source.py`),'utf8'),'print("edited")\n');
  await fs.writeFile(fixture.mapPath(`${fixture.home}/Desktop/source.py`),'external change\n');
  await editor.evaluate(()=>monaco.editor.getModels()[0].setValue('do not overwrite\n'));await editor.locator('#save').click();
  await editor.waitForFunction(()=>document.getElementById('status').textContent.includes('其他程序修改'));
  assert.equal(await fs.readFile(fixture.mapPath(`${fixture.home}/Desktop/source.py`),'utf8'),'external change\n');
  await answer(2);await closeDocument();await new Promise(resolve=>setTimeout(resolve,150));assert.equal(editor.isClosed(),false,JSON.stringify(await application.evaluate(()=>({prompts:globalThis.promptLog,answers:globalThis.answers}))));
  await answer(1);const closed=editor.waitForEvent('close');await closeDocument();await closed;
  const openedHtml=application.waitForEvent('window');await page.evaluate(remotePath=>window.remoteDesktop.openDocument(remotePath),`${fixture.home}/Desktop/site/index.html`);const html=await openedHtml;html.setDefaultTimeout(15000);await html.waitForFunction(()=>window.monaco?.editor.getModels().length>0);
  await html.locator('[data-mode=split]').click();const preview=html.frameLocator('#preview');await preview.locator('#hello').getByText('remote resource loaded',{exact:true}).waitFor();
  assert.equal(await preview.locator('#hello').evaluate(el=>getComputedStyle(el).color),'rgb(1, 120, 30)');
  assert.equal(await preview.locator('#pixel').evaluate(el=>el.naturalWidth),1);
  assert.deepEqual(await preview.locator('body').evaluate(()=>({node:typeof window.require,workbench:typeof window.workbench,desktop:typeof window.remoteDesktop})),{node:'undefined',workbench:'undefined',desktop:'undefined'});
  await html.screenshot({path:path.join(project,'artifacts',executablePath?'packaged-workbench-html.png':'workbench-html.png')});await html.evaluate(()=>window.close());
  const notebook=await openDocument('book.ipynb');await notebook.locator('.cell').first().waitFor();assert.equal(await notebook.locator('.cell').count(),2);await notebook.locator('.katex').waitFor();await notebook.getByText('existing output',{exact:true}).waitFor();assert.equal(await notebook.evaluate(()=>window.pwned),undefined);
  await notebook.screenshot({path:path.join(project,'artifacts',executablePath?'packaged-notebook.png':'workbench-notebook.png')});await notebook.evaluate(()=>window.close());
  await fs.writeFile(path.join(project,'artifacts',executablePath?'packaged-workspace-results.json':'workspace-results.json'),JSON.stringify({passed:true,boundary:'Real Electron/Monaco/preload + loopback SSH; notebook stored output, not live external Jupyter',cli:true,upload:true,conflict:true,shortcut:true,preview:true},null,2));
  const rootClosed=page.waitForEvent('close');await application.evaluate(({BrowserWindow})=>{const root=BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/app/index.html'));setImmediate(()=>root.close());});await rootClosed;
});
