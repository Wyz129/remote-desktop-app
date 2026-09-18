'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const { SshBackend } = require('../lib/ssh-backend.cjs');
const { DocumentService } = require('../lib/document-service.cjs');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');
async function setup(t){const fixture=await createSshFixture();const backend=new SshBackend();t.after(async()=>{await backend.disconnect();await fixture.close();});await backend.connect(fixture.config);return{fixture,backend,service:new DocumentService(backend)};}
test('remote UTF-8 edit uses atomic save, preserves BOM, and detects external changes', {timeout:30000}, async t=>{
  const {fixture,service}=await setup(t),remote=`${fixture.home}/Desktop/code.py`;
  await fixture.put('Desktop/code.py','\uFEFFprint("中文")\n');const first=await service.read(remote);assert.equal(first.text,'print("中文")\n');assert.equal(first.bom,true);
  const saved=await service.save(first,'print(42)\n');assert.notEqual(saved.revision,first.revision);assert.equal(await fsp.readFile(fixture.mapPath(remote),'utf8'),'\uFEFFprint(42)\n');
  await fsp.writeFile(fixture.mapPath(remote),'external');await assert.rejects(service.save(saved,'must not overwrite'),error=>error.code==='CONFLICT');assert.equal(await fsp.readFile(fixture.mapPath(remote),'utf8'),'external');
  assert.ok(!(await fsp.readdir(fixture.mapPath(`${fixture.home}/Desktop`))).some(name=>name.includes('rdesktop-save')));
});
test('read and save honor account permissions and reject binary/invalid UTF-8 and exclusive conflicts', {timeout:30000}, async t=>{
  const {fixture,service}=await setup(t),remote=`${fixture.home}/Desktop/notes.txt`;await fixture.put('Desktop/notes.txt','original');fixture.readOnlyPaths.add(remote);const document=await service.read(remote);assert.equal(document.readOnly,true);await assert.rejects(service.save(document,'x'),/无编辑权限/);fixture.unreadableFiles.add(remote);await assert.rejects(service.read(remote),/无访问权限/);
  await fixture.put('Desktop/binary.dat',Buffer.from([1,0,2]));await assert.rejects(service.read(`${fixture.home}/Desktop/binary.dat`),/二进制/);
  await fixture.put('Desktop/invalid.txt',Buffer.from([0xff,0xfe]));await assert.rejects(service.read(`${fixture.home}/Desktop/invalid.txt`),/UTF-8/);
  const created=await service.saveAs(`${fixture.home}/Desktop/new.py`,'x=1');assert.equal(created.text,'x=1');await assert.rejects(service.saveAs(created.path,'replace'));assert.equal(await fsp.readFile(fixture.mapPath(created.path),'utf8'),'x=1');
});
test('symlink edits target, oversized documents refuse, and failed save cleans its staging file', {timeout:30000}, async t=>{
  const {fixture,service}=await setup(t);
  const target=await fixture.put('project/script.f90','program p\nend program p\n');
  fixture.link(`${fixture.home}/Desktop/shortcut.f90`,target);
  const document=await service.read(`${fixture.home}/Desktop/shortcut.f90`);assert.equal(document.path,target);
  const saved=await service.save(document,'program changed\nend program changed\n');assert.equal(await fsp.readFile(fixture.mapPath(target),'utf8'),saved.text);assert.equal(fixture.links.get(`${fixture.home}/Desktop/shortcut.f90`),target);
  fixture.failRenames.add(target);await assert.rejects(service.save(saved,'cannot commit'),/Injected rename failure/);assert.equal(await fsp.readFile(fixture.mapPath(target),'utf8'),saved.text);assert.equal((await fsp.readdir(fixture.mapPath(`${fixture.home}/project`))).filter(name=>name.includes('.rdesktop-save-')).length,0);
  const large=await fixture.put('project/large.txt','');await fsp.truncate(fixture.mapPath(large),16*1024*1024+1);await assert.rejects(service.read(large),/16 MiB/);
});
test('document handles cannot write into a replacement SSH connection', {timeout:30000}, async t=>{
  const {fixture,backend,service}=await setup(t);const remote=await fixture.put('Desktop/same.txt','original');const document=await service.read(remote);
  await backend.disconnect();await backend.connect(fixture.config);
  await assert.rejects(service.save(document,'stale write'),/SSH 连接已改变/);await assert.rejects(service.saveAs(`${fixture.home}/Desktop/other.txt`,'stale write'),/SSH 连接已改变/);assert.equal(await fsp.readFile(fixture.mapPath(remote),'utf8'),'original');
});
