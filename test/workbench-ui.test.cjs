'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root=path.resolve(__dirname,'..');let server,browser,origin;
before(async()=>{
  server=http.createServer((req,res)=>{const relative=decodeURIComponent(req.url.split('?')[0]);if(relative==='/test/workbench-host.html'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><html><body><iframe id="editorFrame" style="width:1100px;height:740px"></iframe><script src="/app/workbench-frame.js"></script></body></html>');}if(relative==='/test/workbench-attack.html'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><html><body>isolated remote preview</body></html>');}const file=path.resolve(root,'.'+relative);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return res.writeHead(404).end();res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':file.endsWith('.ttf')?'font/ttf':'application/javascript');res.end(fs.readFileSync(file));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({channel:'chrome',headless:true});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));});
async function pageFor(t,name,text,readOnly=false,extra={}){
  const page=await browser.newPage();page.setDefaultTimeout(12000);t.after(()=>page.close());const errors=[],consoleErrors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});t.after(()=>assert.deepEqual(errors,[]));
  await page.addInitScript(({name,text,readOnly,extra})=>{
    window.calls=[];window.doc={name,path:'/shared/'+name,text,readOnly,revision:'first',...extra};
    window.workbench={onEvent(callback){window.receive=callback;},async call(action,payload){
      window.calls.push({action,payload});
      if(action==='load')return{ok:true,value:{document:window.doc,connected:true,defaultDirectory:'/home/test/rdesktop'}};
      if(action==='open'){if(window.openError)return{ok:false,error:window.openError};if(window.cancelOpen)return{ok:true,value:null};window.doc={...window.nextDocument,path:payload.path};return{ok:true,value:window.doc};}
      if(action==='saveAs'){if(window.saveAsError)return{ok:false,error:window.saveAsError};window.doc={name:payload.path.split('/').pop(),path:payload.path,text:payload.text,revision:'saved-as',readOnly:false};window.receive({type:'saved',document:window.doc});return{ok:true,value:window.doc};}
      if(action==='save'){if(window.conflict)return{ok:false,error:'远程文件已被其他程序修改',code:'CONFLICT'};window.doc={...window.doc,text:payload.text,revision:'saved'};return{ok:true,value:window.doc};}
      if(action==='preview')return{ok:true,value:{url:'http://127.0.0.1:1/isolated'}};
      if(action==='jupyterConnect')return{ok:true,value:{kernelspecs:[{name:'python3',displayName:'Python 3'}],kernels:[]}};
      if(action==='jupyterInfo')return{ok:true,value:{kernelspecs:[],kernels:[]}};
      if(action==='execute'){window.receive({type:'jupyterOutput',cellId:payload.cellId,outputType:'stream',content:{name:'stdout',text:'executed\n'}});return{ok:true,value:{status:'ok',execution_count:3}};}
      return{ok:true,value:{}};
    }};
  },{name,text,readOnly,extra});
  await page.goto(origin+'/app/workbench.html');try{await page.waitForFunction(()=>document.querySelector('#status').textContent!=='正在加载编辑器…');}catch(error){throw new Error(error.message+' '+JSON.stringify(consoleErrors)+' status='+await page.locator('#status').textContent()+' runtime='+JSON.stringify(await page.evaluate(()=>({monaco:typeof monaco,calls:window.calls,resources:performance.getEntriesByType('resource').map(x=>x.name).slice(-10)}))));}assert.match(await page.locator('#status').textContent(),/已打开|只读/);return page;
}
test('Monaco Python/C++/Fortran language, folding, search, replace, dirty and conflict',async t=>{
  const page=await pageFor(t,'sample.f90','program sample\n  print *, "hi"\nend program sample\n');
  assert.equal(await page.evaluate(()=>monaco.editor.getModels()[0].getLanguageId()),'fortran');assert.ok((await page.evaluate(()=>monaco.editor.tokenize('program sample','fortran')[0])).some(token=>token.type.includes('keyword')));
  await page.locator('#language').selectOption('python');assert.equal(await page.evaluate(()=>monaco.editor.getModels()[0].getLanguageId()),'python');await page.locator('#language').selectOption('cpp');
  await page.locator('.monaco-editor textarea').first().focus();await page.keyboard.press('Control+h');await page.locator('.find-widget.visible').waitFor();await page.keyboard.press('Escape');
  await page.evaluate(()=>monaco.editor.getModels()[0].setValue('int main() { return 0; }'));await page.waitForFunction(()=>window.calls.some(x=>x.action==='update'));await page.locator('#save').click();await page.waitForFunction(()=>window.calls.some(x=>x.action==='save'));assert.equal(await page.locator('#dirty').textContent(),'');
  await page.evaluate(()=>{window.conflict=true;monaco.editor.getModels()[0].setValue('changed');});await page.locator('#save').click();await page.getByRole('status').getByText('远程文件已被其他程序修改').waitFor();assert.equal(await page.evaluate(()=>monaco.editor.getModels()[0].getValue()),'changed');
});
test('read-only source keeps editing disabled',async t=>{const page=await pageFor(t,'readonly.py','x = 1\n',true);assert.ok(await page.locator('#readOnly').isVisible());assert.ok(await page.locator('#save').isDisabled());assert.ok(await page.locator('#saveAs').isEnabled());await page.locator('.monaco-editor textarea').first().focus();await page.keyboard.type('xyz');assert.equal(await page.evaluate(()=>monaco.editor.getModels()[0].getValue()),'x = 1\n');});
test('notebook markdown, math, outputs sanitize and Jupyter execution',async t=>{
  const notebook={nbformat:4,nbformat_minor:5,metadata:{language_info:{name:'python'}},cells:[{cell_type:'markdown',metadata:{},source:'# Heading\n\n$x^2$ <img src="x" onerror="window.pwned=1"><script>window.pwned=1</script>'},{cell_type:'code',metadata:{},source:'print(2)',execution_count:1,outputs:[{output_type:'display_data',data:{'text/html':'<b>existing output</b><img src="http://invalid/x" onerror="window.pwned=1">'},metadata:{}}]}]};
  const page=await pageFor(t,'demo.ipynb',JSON.stringify(notebook));assert.equal(await page.locator('.cell').count(),2);await page.locator('.cell-markdown h1').getByText('Heading').waitFor();assert.ok(await page.locator('.katex').count());assert.equal(await page.evaluate(()=>window.pwned),undefined);assert.equal(await page.locator('.cell-markdown img,.cell-output img').count(),0);await page.locator('.cell-output').getByText('existing output').waitFor();
  await page.locator('#connectJupyter').click();await page.locator('#inputValue').fill('http://localhost:8888/');await page.locator('#jupyterToken').fill('secret');await page.locator('#inputForm button[type=submit]').click();await page.locator('#startKernel').click();await page.waitForFunction(()=>document.querySelector('#kernelState').textContent==='内核已连接');await page.getByRole('button',{name:'▶ 执行',exact:true}).click();await page.locator('.cell-output').getByText('executed').waitFor();assert.equal(await page.locator('#jupyterToken').inputValue(),'');await page.locator('#save').click();await page.waitForFunction(()=>window.calls.some(x=>x.action==='save'));const saved=await page.evaluate(()=>JSON.parse(window.calls.findLast(x=>x.action==='save').payload.text));assert.equal(saved.cells[1].execution_count,3);assert.equal(saved.cells[1].outputs[0].text,'executed\n');
});
test('HTML source split preview grants explicit root and isolates scripts',async t=>{const page=await pageFor(t,'index.html','<h1>Example</h1>');await page.locator('button[data-mode=split]').click();await page.waitForFunction(()=>window.calls.some(x=>x.action==='preview'));assert.equal(await page.locator('#preview').getAttribute('sandbox'),'allow-scripts');assert.ok(await page.locator('#editor').isVisible());assert.ok(await page.locator('#previewPanel').isVisible());await page.locator('#previewRoot').click();await page.locator('#inputValue').fill('/shared');await page.locator('#inputForm button[type=submit]').click();await page.waitForFunction(()=>window.calls.some(x=>x.action==='preview'&&x.payload.root==='/shared'));});

test('Monaco launcher opens untitled text and Ctrl+S asks for an absolute remote save path', async t => {
  const page = await pageFor(t, 'Untitled.txt', '', false, { untitled: true, path: '' });
  assert.equal(await page.locator('header, #filePath, .brand').count(), 0, 'file title is owned by the virtual window titlebar');
  assert.equal(await page.locator('#reload').isDisabled(), true);
  await page.evaluate(() => monaco.editor.getModels()[0].setValue('print("new document")\n'));
  await page.locator('.monaco-editor textarea').first().focus(); await page.keyboard.press('Control+s');
  await page.locator('#inputDialog[open]').waitFor();
  assert.equal(await page.locator('#inputValue').inputValue(), '/home/test/rdesktop/Untitled.txt');
  await page.locator('#inputValue').fill('/shared/new.py'); await page.locator('#inputForm button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === '已另存为。');
  assert.equal(await page.evaluate(() => window.doc.path), '/shared/new.py');
  assert.equal(await page.locator('#language').inputValue(), 'python'); assert.equal(await page.locator('#dirty').textContent(), '');
  assert.equal(await page.evaluate(() => window.calls.some(item => item.action === 'save')), false);
  await page.evaluate(() => monaco.editor.getModels()[0].setValue('print("updated")\n'));
  await page.locator('#save').click(); await page.waitForFunction(() => window.calls.some(item => item.action === 'save'));
});
test('untitled save cancellation and failed save-as preserve edits, and close request reopens save-as', async t => {
  const page = await pageFor(t, 'Untitled.txt', 'keep my edits', false, { untitled: true, path: '' });
  await page.locator('#save').click(); await page.locator('#inputDialog[open]').waitFor(); await page.locator('#inputCancel').click();
  assert.equal(await page.evaluate(() => window.calls.some(item => item.action === 'saveAs')), false);
  await page.evaluate(() => { window.saveAsError = '目标已存在，不会覆盖'; window.receive({ type: 'requestSaveAs' }); });
  await page.locator('#inputDialog[open]').waitFor(); await page.locator('#inputValue').fill('/shared/existing.txt'); await page.locator('#inputForm button[type=submit]').click();
  await page.getByRole('status').getByText('目标已存在，不会覆盖').waitFor();
  assert.equal(await page.evaluate(() => monaco.editor.getModels()[0].getValue()), 'keep my edits');
  assert.equal(await page.locator('#save').isEnabled(), true); assert.equal(await page.evaluate(() => window.doc.untitled), true);
});
test('remote open keeps current edits on cancellation or permission failure and supports read-only files', async t => {
  const page = await pageFor(t, 'current.py', 'keep current');
  async function openPath(remotePath) { await page.locator('#open').click(); await page.locator('#inputValue').fill(remotePath); await page.locator('#inputForm button[type=submit]').click(); await page.waitForFunction(() => !document.querySelector('#open').disabled); }
  await page.evaluate(() => { window.cancelOpen = true; monaco.editor.getModels()[0].setValue('unsaved content'); });
  await openPath('/shared/cancelled.txt'); assert.equal(await page.evaluate(() => monaco.editor.getModels()[0].getValue()), 'unsaved content');
  await page.evaluate(() => { window.cancelOpen = false; window.openError = '无访问权限：/restricted'; });
  await openPath('/restricted'); await page.getByRole('status').getByText('无访问权限：/restricted').waitFor();
  assert.equal(await page.evaluate(() => window.doc.path), '/shared/current.py');
  await page.evaluate(() => { window.openError = ''; window.nextDocument = { name: 'readonly.f90', text: 'program hello\nend program', readOnly: true, revision: 'next' }; });
  await openPath('/shared/readonly.f90'); assert.equal(await page.locator('#language').inputValue(), 'fortran');
  assert.equal(await page.locator('#save').isDisabled(), true); assert.equal(await page.locator('#saveAs').isEnabled(), true);
  assert.equal(await page.locator('#readOnly').isVisible(), true); assert.equal(await page.locator('#dirty').textContent(), '');
});
test('read-only save-as becomes editable and a disconnect disables all remote file actions', async t => {
  const page = await pageFor(t, 'readonly.py', 'x = 1\n', true);
  await page.locator('#saveAs').click(); await page.locator('#inputValue').fill('/shared/copy.py'); await page.locator('#inputForm button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === '已另存为。');
  assert.equal(await page.locator('#save').isEnabled(), true); assert.equal(await page.locator('#readOnly').isVisible(), false);
  await page.evaluate(() => window.receive({ type: 'disconnected' }));
  for (const id of ['open', 'save', 'saveAs', 'reload']) assert.equal(await page.locator('#' + id).isDisabled(), true);
  assert.equal(await page.evaluate(() => monaco.editor.getModels()[0].getValue()), 'x = 1\n');
});

test('opening another file does not rewrite an unchanged compact Notebook or mark it dirty', async t => {
  const text = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', metadata: {}, source: ['print(1)'], outputs: [], execution_count: null }] });
  const page = await pageFor(t, 'compact.ipynb', text);
  await page.evaluate(() => { window.cancelOpen = true; });
  await page.locator('#open').click(); await page.locator('#inputValue').fill('/shared/next.py'); await page.locator('#inputForm button[type=submit]').click();
  await page.waitForFunction(() => window.calls.some(item => item.action === 'open'));
  assert.equal(await page.evaluate(() => window.calls.findLast(item => item.action === 'update').payload.text), text);
  assert.equal(await page.locator('#dirty').textContent(), '');
});

function managerHarness(options = {}) {
  const { EventEmitter } = require('node:events'), { createRequire } = require('node:module');
  const filename = path.join(root, 'lib/workbench-manager.cjs'), nativeRequire = createRequire(filename);
  const prompts = [], answers = [], events = [], backend = { connected: true, home: '/home/test', desktop: '/home/test/rdesktop' };
  let sequence = 0;
  class Window extends EventEmitter {
    constructor(options) { super(); this.title = options.title; this.webContents = new EventEmitter(); this.webContents.id = ++sequence; this.webContents.setWindowOpenHandler = () => {}; this.webContents.send = (_channel, event) => events.push(event); this.webContents.session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } }; }
    setTitle(title) { this.title = title; } isDestroyed() { return false; } async loadFile() {} show() {} focus() {} close() {}
  }
  class Service {
    async read(remotePath) { return { path: remotePath, name: path.posix.basename(remotePath), text: 'source\n', revision: 'first', readOnly: false }; }
    async saveAs(remotePath, text) { return { ...await this.read(remotePath), text, revision: 'saved-as' }; }
    async save(document, text) { return { ...document, text, revision: 'saved' }; }
  }
  const electron = { BrowserWindow: Window, ipcMain: { handle() {} }, dialog: { async showMessageBox(_window, options) { prompts.push(options); return { response: answers.shift() ?? options.cancelId }; } } };
  const module = { exports: {} };
  const load = new Function('require', 'module', 'exports', '__dirname', '__filename', fs.readFileSync(filename, 'utf8'));
  load(id => id === 'electron' ? electron : id === './document-service.cjs' ? { DocumentService: Service } : nativeRequire(id), module, module.exports, path.dirname(filename), filename);
  const manager = new module.exports.WorkbenchManager({ getBackend: () => backend, getConnectionId: () => 'test-connection', getParent: () => null, ...options });
  return { manager, backend, prompts, answers, events };
}
test('manager keeps untitled close confirmation, save-as title and conflict protections', async () => {
  const { manager, prompts, answers, events } = managerHarness();
  await manager.open(null); const state = [...manager.windows.values()][0];
  assert.equal(state.document.untitled, true); assert.equal(state.window.title, 'Untitled.txt — Monaco Editor');
  assert.equal((await manager.action(state, 'load', {})).defaultDirectory, '/home/test/rdesktop');
  await manager.action(state, 'update', { text: 'unsaved\n' }); answers.push(0);
  assert.equal(await manager.confirm(state), false); assert.equal(events.at(-1).type, 'requestSaveAs');
  assert.equal(state.dirty, true); assert.match(prompts.at(-1).message, /尚未保存/);
  answers.push(2); assert.equal(await manager.confirm(state), false);
  answers.push(1); assert.equal(await manager.confirm(state), true);
  await manager.action(state, 'saveAs', { path: '/shared/new.py', text: 'unsaved\n' });
  assert.equal(state.document.path, '/shared/new.py'); assert.equal(state.document.untitled, undefined); assert.equal(state.dirty, false);
  assert.equal(state.window.title, 'new.py — Monaco Editor');
  await manager.action(state, 'update', { text: 'later edits' });
  state.service.save = async () => { throw Object.assign(new Error('remote conflict'), { code: 'CONFLICT' }); }; answers.push(0);
  assert.equal(await manager.confirm(state), false); assert.equal(state.text, 'later edits'); assert.equal(state.dirty, true);
  assert.match(prompts.at(-1).detail, /remote conflict/);
});
test('manager preserves current document and services when remote open fails or is cancelled', async () => {
  const { manager, answers } = managerHarness(); await manager.open('/shared/current.py'); const state = [...manager.windows.values()][0];
  let clientClosed = 0, previewClosed = 0; state.client = { close: () => clientClosed++ }; state.preview = { dispose: () => previewClosed++ };
  await manager.action(state, 'update', { text: 'pending edits' }); answers.push(2);
  assert.equal(await manager.action(state, 'open', { path: '/shared/other.py' }), null);
  assert.equal(state.document.path, '/shared/current.py'); assert.equal(state.text, 'pending edits');
  answers.push(1); state.service.read = async () => { throw new Error('无访问权限'); };
  await assert.rejects(manager.action(state, 'open', { path: '/restricted' }), /无访问权限/);
  assert.equal(state.document.path, '/shared/current.py'); assert.equal(state.dirty, true); assert.equal(clientClosed, 0); assert.equal(previewClosed, 0);
  answers.push(1); state.service.read = async () => ({ path: '/shared/next.py', name: 'next.py', text: 'readonly source', readOnly: true });
  const opened = await manager.action(state, 'open', { path: '/shared/next.py' });
  assert.equal(opened.readOnly, true); assert.equal(state.dirty, false); assert.equal(clientClosed, 1); assert.equal(previewClosed, 1);
  assert.equal(state.window.title, 'next.py — Monaco Editor');
});

test('embedded manager creates virtual descriptors, protects dirty close and retains drafts across disconnect', async t => {
  const emitted = [], { manager, answers } = managerHarness({ embedded: true, onEvent: event => emitted.push(event) });
  t.after(() => manager.dispose());
  const descriptor = await manager.open('/shared/current.py');
  assert.match(descriptor.id, /^[a-f0-9-]{36}$/); assert.equal(descriptor.title, 'current.py — Monaco Editor');
  const state = manager.windows.get(descriptor.id); assert.equal(state.embedded, true); assert.equal(state.window, null);
  assert.equal(emitted[0].type, 'open');
  assert.deepEqual(await manager.open('/shared/current.py'), descriptor); assert.equal(emitted.at(-1).type, 'focus');
  await manager.call(descriptor.id, 'update', { text: 'my unsaved draft' });
  assert.equal(emitted.at(-1).dirty, true);
  answers.push(2); assert.deepEqual(await manager.call(descriptor.id, 'close'), { ok: true, value: false });
  assert.equal(manager.list().length, 1);
  manager.disconnect(); assert.equal(emitted.at(-1).event.type, 'disconnected');
  const loaded = (await manager.call(descriptor.id, 'load')).value;
  assert.equal(loaded.document.text, 'source\n'); assert.equal(loaded.draftText, 'my unsaved draft'); assert.equal(loaded.dirty, true); assert.equal(loaded.connected, false);
  assert.equal((await manager.call(descriptor.id, 'save', { text: 'my unsaved draft' })).ok, false);
  assert.equal((await manager.call('wrong-document-id', 'load')).ok, false);
  assert.equal((await manager.call(descriptor.id, 'exec', { command: 'unauthorized' })).ok, false);
  answers.push(1); assert.deepEqual(await manager.call(descriptor.id, 'close'), { ok: true, value: true });
  assert.equal(manager.list().length, 0); assert.deepEqual(emitted.at(-1), { type: 'closed', id: descriptor.id });
  assert.equal((await manager.call(descriptor.id, 'load')).ok, false);
});

test('embedded Monaco loads in an opaque iframe, saves through its bridge and rejects preview impersonation', async t => {
  const page = await browser.newPage(); page.setDefaultTimeout(12000); t.after(() => page.close());
  await page.goto(origin + '/test/workbench-host.html');
  await page.evaluate(() => {
    window.secretDesktopApi = { credentials: 'unreachable-from-document' };
    window.calls = []; window.focusCount = 0;
    window.currentDocument = { name: 'embedded.py', path: '/shared/embedded.py', text: 'print("embedded")\n', readOnly: false };
    window.frameHost = RemoteWorkbenchFrame.mount({ iframe: document.querySelector('#editorFrame'), id: '11111111-1111-1111-1111-111111111111', onFocus: () => window.focusCount++, call: async (action, payload) => {
      window.calls.push({ action, payload });
      if (action === 'load') return { ok: true, value: { document: window.currentDocument, connected: true } };
      if (action === 'save') { window.currentDocument = { ...window.currentDocument, text: payload.text }; return { ok: true, value: window.currentDocument }; }
      return { ok: true, value: {} };
    } });
  });
  const embedded = page.frameLocator('#editorFrame'); await embedded.locator('#status').filter({ hasText: '已打开服务器文件' }).waitFor();
  const frame = page.frames().find(item => item.url().includes('/app/workbench.html#'));
  assert.equal(await page.locator('#editorFrame').getAttribute('sandbox'), 'allow-scripts allow-forms');
  assert.equal(await frame.evaluate(() => { try { return Boolean(parent.secretDesktopApi); } catch { return false; } }), false);
  await frame.evaluate(() => monaco.editor.getModels()[0].setValue('print("updated")\n'));
  await embedded.locator('#save').click(); await page.waitForFunction(() => window.calls.some(item => item.action === 'save'));
  assert.equal(await page.evaluate(() => window.currentDocument.text), 'print("updated")\n'); assert.ok(await page.evaluate(() => window.focusCount > 0));
  await frame.evaluate(url => { document.querySelector('#preview').src = url; }, origin + '/test/workbench-attack.html');
  await page.waitForFunction(() => window.calls.some(item => item.action === 'load'));
  const preview = await frame.waitForSelector('#preview', { state: 'attached' });
  const previewFrame = await preview.contentFrame(); await previewFrame.waitForURL('**/test/workbench-attack.html');
  await previewFrame.evaluate(() => top.postMessage({ channel: 'remote-desktop-workbench-v1', id: '11111111-1111-1111-1111-111111111111', type: 'request', requestId: 999, action: 'save', payload: { text: 'INJECTED' } }, '*'));
  await frame.evaluate(() => parent.postMessage({ channel: 'remote-desktop-workbench-v1', id: '22222222-2222-2222-2222-222222222222', type: 'request', requestId: 1000, action: 'save', payload: { text: 'INJECTED' } }, '*'));
  await embedded.locator('#save').click(); await page.waitForFunction(() => window.calls.filter(item => item.action === 'save').length === 2);
  assert.equal(await page.evaluate(() => window.calls.some(item => item.payload?.text === 'INJECTED')), false);
  await page.evaluate(() => window.frameHost.send({ type: 'disconnected' }));
  await embedded.locator('#status').filter({ hasText: 'SSH 已断开' }).waitFor(); assert.equal(await embedded.locator('#save').isDisabled(), true);
  assert.equal(await frame.evaluate(() => monaco.editor.getModels()[0].getValue()), 'print("updated")\n');
  await page.evaluate(() => window.frameHost.destroy()); assert.equal(await page.locator('#editorFrame').getAttribute('src'), null);
});

test('embedded static asset origin serves bundled editor resources only and rejects mutation or traversal', async t => {
  const { createWorkbenchAssets } = require('../lib/workbench-assets.cjs');
  const assets = await createWorkbenchAssets(); t.after(() => assets.close());
  const page = await fetch(assets.url); assert.equal(page.status, 200); assert.match(await page.text(), /HTML 隔离预览/);
  assert.equal(page.headers.get('access-control-allow-origin'), 'null');
  const scriptUrl = new URL('workbench-frame.js', assets.url);
  const script = await fetch(scriptUrl); assert.equal(script.status, 200); assert.match(await script.text(), /remote-desktop-workbench-v1/);
  const head = await fetch(scriptUrl, { method: 'HEAD' }); assert.equal(head.status, 200); assert.ok(Number(head.headers.get('content-length')) > 0); assert.equal(await head.text(), '');
  assert.equal((await fetch(scriptUrl, { method: 'POST', body: 'write denied' })).status, 405);
  assert.equal((await fetch(new URL('../main.cjs', assets.url))).status, 404);
  assert.equal((await fetch(new URL('../app/desktop.js', assets.url))).status, 404);
  assert.equal((await fetch(new URL('/app/workbench.html', assets.url))).status, 404);
  const prefix = assets.url.slice(0, -'app/workbench.html'.length);
  assert.equal((await fetch(prefix + 'media/workbench/%2e%2e%2f%2e%2e%2fmain.cjs')).status, 403);
  const wrongHostStatus = await new Promise((resolve, reject) => { const request = http.get(scriptUrl, { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
  assert.equal(wrongHostStatus, 403);
});
