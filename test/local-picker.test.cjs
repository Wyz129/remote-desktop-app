'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { LocalPicker } = require('../lib/local-picker.cjs');

const pageUrl = pathToFileURL(path.resolve(__dirname, '../app/local-picker.html')).href;
function fixture(options = {}) {
  const windows = [], invocations = [], handlers = new Map();
  const parent = new EventEmitter(); Object.assign(parent, { destroyed:false, minimized:Boolean(options.minimized), visible:options.visible !== false, restores:0, focuses:0,
    isDestroyed(){return this.destroyed;},isVisible(){return this.visible;},isMinimized(){return this.minimized;},minimize(){this.minimized=true;},restore(){this.minimized=false;this.restores++;},focus(){this.focuses++;} });
  const electron = {
    ipcMain:{ handle(name,fn){assert.equal(handlers.has(name),false);handlers.set(name,fn);},removeHandler(name){handlers.delete(name);} },
    BrowserWindow:class extends EventEmitter {
      constructor(config){super();this.config=config;this.destroyed=false;this.messages=[];this.webContents=new EventEmitter();Object.assign(this.webContents,{
        setWindowOpenHandler:handler=>{this.openHandler=handler;},send:(channel,message)=>this.messages.push({channel,...message}),session:{setPermissionRequestHandler(){},setPermissionCheckHandler(){},webRequest:{onBeforeRequest:(_filter,handler)=>{this.networkHandler=handler;}}}
      });windows.push(this);}
      loadFile(){return options.loadError?Promise.reject(new Error('load failed')):Promise.resolve();}
      showInactive(){this.visible=true;}
      isDestroyed(){return this.destroyed;}
      destroy(){this.destroyed=true;this.emit('closed');}
    }
  };
  const child = new EventEmitter(); child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.killed=false;child.input='';
  child.stdin.on('data',data=>{child.input+=data.toString();});child.kill=()=>{child.killed=true;};
  const dialog = { async showOpenDialog(_parent,config){ invocations.push(config);return options.dialogPromise || {canceled:false,filePaths:['C:\\selected.txt']}; } };
  const picker = new LocalPicker({app:{isPackaged:false},dialog,getParent:()=>parent},{platform:'win32',electron,spawn:(...args)=>{invocations.push(args);return child;}});
  const ready = () => new Promise(resolve=>setImmediate(resolve));
  const output = value => child.stdout.write(JSON.stringify(value)+'\n');
  const action = (name,sender=windows[0].webContents,url=pageUrl) => handlers.get('local-picker:action')({sender,senderFrame:{url}},name);
  return {picker,parent,child,windows,invocations,handlers,ready,output,action};
}

test('system Explorer picker confirms only matching window selections and restores visible parent', async () => {
  const f=fixture(), pending=f.picker.choose();assert.equal(f.picker.choose(),pending);
  await f.ready();const panel=f.windows[0];
  assert.equal(f.parent.minimized,true);assert.equal(panel.visible,true);
  assert.equal(panel.config.alwaysOnTop,true);assert.equal(panel.config.webPreferences.sandbox,true);assert.equal(panel.config.webPreferences.nodeIntegration,false);assert.equal(panel.config.webPreferences.contextIsolation,true);
  assert.equal(f.invocations[0][0],'powershell.exe');assert.ok(!f.invocations[0][1].includes('-ExecutionPolicy'));
  assert.equal(f.action('select'),false,'selection must wait for captured Explorer HWND');
  f.output({type:'ready',handle:'9236'});assert.equal(panel.messages.at(-1).ready,true);
  assert.equal(f.action('select'),true);assert.equal(f.action('select'),false,'deduplicate pending confirmation');
  assert.ok(f.child.input.includes('select\n'));
  f.output({type:'selected',handle:'9236',paths:['C:\\Work\\text.py','C:\\Work\\folder','C:\\Work\\text.py']});
  assert.deepEqual(await pending,['C:\\Work\\text.py','C:\\Work\\folder']);
  assert.equal(f.child.killed,true);assert.equal(panel.destroyed,true);assert.equal(f.parent.restores,1);assert.equal(f.parent.focuses,1);assert.equal(f.handlers.size,0);
});

test('picker rejects unrelated sender, changed document URL and arbitrary path actions', async () => {
  const f=fixture(),pending=f.picker.choose();await f.ready();f.output({type:'ready',handle:'42'});
  assert.throws(()=>f.action('select',{}),/非本地选择窗口/);
  assert.throws(()=>f.action('select',f.windows[0].webContents,'https://example.test'),/非本地选择窗口/);
  assert.throws(()=>f.action({paths:['C:\\secret.txt']}),/仅允许/);
  assert.equal(f.child.input,'');
  let networkResult;f.windows[0].networkHandler({url:'https://example.test'},value=>networkResult=value);assert.deepEqual(networkResult,{cancel:true});
  assert.deepEqual(f.windows[0].openHandler(),{action:'deny'});
  f.action('cancel');assert.deepEqual(await pending,[]);
});

test('empty selection remains open for correction and closing Explorer cancels', async () => {
  const f=fixture(),pending=f.picker.choose();await f.ready();f.output({type:'ready',handle:'17'});f.action('select');
  f.output({type:'selection-error',error:'Select one or more files or folders first.'});
  assert.equal(f.windows[0].destroyed,false);assert.equal(f.windows[0].messages.at(-1).ready,true);assert.equal(f.action('select'),true);
  f.output({type:'cancelled'});assert.deepEqual(await pending,[]);assert.equal(f.parent.restores,1);
});

test('mismatched HWND, unsolicited paths and malformed subprocess results never return selections', async () => {
  for (const response of [ {type:'selected',handle:'999',paths:['C:\\other.txt']}, {type:'selected',handle:'7',paths:['relative.txt']}, {type:'selected',handle:'7',paths:['C:\\bad\0.txt']} ]) {
    const f=fixture(),pending=f.picker.choose();await f.ready();f.output({type:'ready',handle:'7'});f.action('select');
    const rejected=assert.rejects(pending,/不匹配/);f.output(response);await rejected;assert.equal(f.child.killed,true);
  }
  const f=fixture(),pending=f.picker.choose();await f.ready();f.output({type:'ready',handle:'7'});
  const rejected=assert.rejects(pending,/不匹配/);f.output({type:'selected',handle:'7',paths:['C:\\unsolicited.txt']});await rejected;
  const broken=fixture(),brokenPending=broken.picker.choose();await broken.ready();const brokenRejected=assert.rejects(brokenPending,/无效结果/);broken.child.stdout.write('not-json\n');await brokenRejected;
});

test('disconnect, confirmation close and main-window close all cancel without revealing hidden parent', async () => {
  for (const close of [f=>f.picker.close(),f=>f.windows[0].destroy(),f=>{f.parent.destroyed=true;f.parent.emit('closed');}]) {
    const f=fixture({visible:false}),pending=f.picker.choose();await f.ready();f.output({type:'ready',handle:'22'});close(f);
    assert.deepEqual(await pending,[]);assert.equal(f.parent.restores,0);assert.equal(f.parent.focuses,0);assert.equal(f.handlers.size,0);
  }
  const f=fixture({minimized:true}),pending=f.picker.choose();await f.ready();f.picker.close();await pending;assert.equal(f.parent.restores,0);
});

test('subprocess launch and policy errors surface while picker cleanup remains complete', async () => {
  const f=fixture(),pending=f.picker.choose();await f.ready();const rejected=assert.rejects(pending,/running scripts is disabled/);
  f.child.stderr.write('running scripts is disabled');f.child.emit('close',1);await rejected;
  assert.equal(f.parent.restores,1);assert.equal(f.windows[0].destroyed,true);assert.equal(f.handlers.size,0);
  const failed=fixture({loadError:true});await assert.rejects(failed.picker.choose(),/load failed/);assert.equal(failed.invocations.length,0);assert.equal(failed.parent.restores,0);
});

test('explicit native file/folder dialogs preserve multi-selection and ignore late results after disconnect', async () => {
  const f=fixture();assert.deepEqual(await f.picker.choose('files'),['C:\\selected.txt']);assert.deepEqual(f.invocations[0].properties,['openFile','multiSelections']);
  await f.picker.choose('directory');assert.deepEqual(f.invocations[1].properties,['openDirectory','multiSelections']);assert.equal(f.windows.length,0);
  let resolve;const late=fixture({dialogPromise:new Promise(done=>{resolve=done;})});const pending=late.picker.choose('files');late.picker.close();resolve({canceled:false,filePaths:['C:\\late.txt']});assert.deepEqual(await pending,[]);
});

test('PowerShell Explorer script captures the new HWND and never reads unrelated COM selections', {skip:process.platform !== 'win32'}, async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'rdesktop-picker-test-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.writeFile(path.join(directory,'sample.txt'),'sample');await fs.mkdir(path.join(directory,'folder'));
  function run(scenario,input='select\n') {
    const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(__dirname,'helpers/local-picker-mock.ps1')],{
      windowsHide:true,encoding:'utf8',input,timeout:10000,
      env:{...process.env,RDESKTOP_TEST_SCENARIO:scenario,RDESKTOP_TEST_DIRECTORY:directory,RDESKTOP_TEST_PICKER_SCRIPT:path.resolve(__dirname,'../scripts/native-picker/local-picker.ps1')}
    });
    assert.ifError(result.error);assert.equal(result.stderr,'',result.stderr);
    return {...result,records:result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line.replace(/^\uFEFF/,'')))};
  }
  const mixed=run('mixed');assert.equal(mixed.status,0);assert.deepEqual(mixed.records.map(item=>item.type),['ready','selected']);assert.equal(mixed.records[0].handle,'22');
  assert.deepEqual(mixed.records[1].paths,[path.join(directory,'sample.txt'),path.join(directory,'folder')]);
  const ambiguous=run('ambiguous');assert.equal(ambiguous.status,1);assert.deepEqual(ambiguous.records.map(item=>item.type),['error']);assert.match(ambiguous.records[0].error,/More than one/);
  const closed=run('closed');assert.equal(closed.status,0);assert.deepEqual(closed.records.map(item=>item.type),['ready','cancelled']);
  const empty=run('empty','select\ncancel\n');assert.equal(empty.status,0);assert.deepEqual(empty.records.map(item=>item.type),['ready','selection-error']);
});
