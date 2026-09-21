'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const run = require('node:util').promisify(execFile);
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');
const { SshBackend } = require('../lib/ssh-backend.cjs');
const { Readable } = require('node:stream');
const { archiveOperation, helper } = require('../lib/archive-service.cjs');
// The documented base interpreter supplies only Python standard libraries.
const python = process.env.REMOTE_DESKTOP_TEST_PYTHON || (process.platform === 'win32' ? 'C:/ProgramData/anaconda3/python.exe' : 'python3');
const available = spawnSync(python, ['-I', '-c', 'import tarfile,zipfile; print("ready")'], { windowsHide: true }).status === 0;
const options = { timeout: 30000, skip: available ? false : 'Set REMOTE_DESKTOP_TEST_PYTHON to a Python 3 interpreter.' };
async function setup(t, config = {}) {
  const fixture = await createSshFixture({ archivePython: python, ...config }), backend = new SshBackend();
  t.after(async () => { await backend.disconnect(); await fixture.close(); });
  await backend.connect(fixture.config); const service = backend.desktopService(); await service.inspect();
  return { fixture, backend, service, parent: `${fixture.home}/Desktop` };
}
for (const format of ['tar.gz', 'zip']) {
  test(`server ${format} archive roundtrip preserves bytes and empty directories without overwriting`, options, async t => {
    const { fixture, service, parent } = await setup(t);
    const name = "quote ' 中文 $(touch never)";
    await fixture.put(`Desktop/${name}/nested/data.bin`, Buffer.from([0, 1, 2, 128, 255]));
    await fs.mkdir(fixture.mapPath(`${parent}/${name}/empty`));
    const input = { operation: 'compress', parent, paths: [`${parent}/${name}`], format };
    const first = await service.operate(input), second = await service.operate(input);
    assert.notEqual(first.paths[0], second.paths[0]);
    const original = await fs.readFile(fixture.mapPath(first.paths[0]));
    const extracted = await service.operate({ operation: 'extract', parent, paths: first.paths });
    const extractedAgain = await service.operate({ operation: 'extract', parent, paths: first.paths });
    assert.notEqual(extracted.paths[0], extractedAgain.paths[0]);
    const content = fixture.mapPath(`${extracted.paths[0]}/${name}`);
    assert.deepEqual(await fs.readFile(path.join(content, 'nested', 'data.bin')), Buffer.from([0, 1, 2, 128, 255]));
    assert.ok((await fs.stat(path.join(content, 'empty'))).isDirectory());
    assert.deepEqual(await fs.readFile(fixture.mapPath(first.paths[0])), original);
    assert.equal(await fs.stat(fixture.mapPath(`${parent}/never`)).catch(() => null), null);
  });
}
test('archive extraction rejects traversal, absolute paths, links, duplicate files and corruption before exposing output', options, async t => {
  const { fixture, service, parent } = await setup(t);
  const cases = ['../escaped.txt', '/escaped.txt', 'C:/escaped.txt', 'link', 'duplicate'];
  for (let index = 0; index < cases.length; index++) {
    const remote = `${parent}/malicious-${index}.zip`, local = fixture.mapPath(remote);
    const code = 'import zipfile,sys,stat\nz=zipfile.ZipFile(sys.argv[1],"w")\nn=sys.argv[2]\ni=zipfile.ZipInfo(n)\nif n=="link": i.create_system=3; i.external_attr=(stat.S_IFLNK|0o777)<<16\nz.writestr(i,"outside")\nif n=="duplicate": z.writestr(n,"second")\nz.close()';
    await run(python, ['-I', '-c', code, local, cases[index]], { windowsHide: true });
    const before = await fs.readdir(fixture.mapPath(parent));
    await assert.rejects(service.operate({ operation: 'extract', parent, paths: [remote] }), /无法解压/);
    assert.deepEqual(await fs.readdir(fixture.mapPath(parent)), before);
  }
  await fixture.put('Desktop/corrupt.tar.gz', 'invalid');
  await assert.rejects(service.operate({ operation: 'extract', parent, paths: [`${parent}/corrupt.tar.gz`] }), /无法解压/);
  assert.equal(await fs.stat(fixture.mapPath(`${fixture.home}/escaped.txt`)).catch(() => null), null);
});
test('archive validates format, source location, server permissions and missing runtime', options, async t => {
  const { fixture, service, parent } = await setup(t, { archivePython: null });
  await assert.rejects(service.operate({ operation: 'compress', parent, paths: [`${parent}/notes.txt`], format: 'rar' }), /格式/);
  await assert.rejects(service.operate({ operation: 'compress', parent, paths: [`${fixture.home}/outside.txt`] }), /同一个目录/);
  await fixture.put('Desktop/source.txt', 'source');
  await assert.rejects(service.operate({ operation: 'compress', parent, paths: [`${parent}/source.txt`] }), /python3/);
  const restricted = await setup(t);
  await restricted.fixture.put('Desktop/source.txt', 'source');
  restricted.fixture.deniedDirectories.add(restricted.parent);
  await assert.rejects(restricted.service.operate({ operation: 'compress', parent: restricted.parent, paths: [`${restricted.parent}/source.txt`] }), /Permission denied/);
});

test('tar extraction accepts a conventional dot root and rejects hard links, devices and file-parent conflicts', options, async t => {
  const { fixture, service, parent } = await setup(t);
  const create = `import tarfile,io,sys
with tarfile.open(sys.argv[1], 'w') as archive:
    root=tarfile.TarInfo('./');root.type=tarfile.DIRTYPE;archive.addfile(root)
    item=tarfile.TarInfo('./folder/data.txt');item.size=7;archive.addfile(item,io.BytesIO(b'content'))
    kind=sys.argv[2]
    if kind != 'safe':
        item=tarfile.TarInfo('folder' if kind == 'parent' else 'unsafe')
        if kind == 'hardlink':item.type=tarfile.LNKTYPE;item.linkname='../escaped'
        elif kind == 'symlink':item.type=tarfile.SYMTYPE;item.linkname='../escaped'
        elif kind == 'device':item.type=tarfile.CHRTYPE
        archive.addfile(item)
`;
  for (const kind of ['safe', 'hardlink', 'symlink', 'device', 'parent']) {
    const remote = `${parent}/${kind}.tar`;
    await run(python, ['-I', '-c', create, fixture.mapPath(remote), kind], { windowsHide: true });
    const before = await fs.readdir(fixture.mapPath(parent));
    if (kind === 'safe') {
      const result = await service.operate({ operation: 'extract', parent, paths: [remote] });
      assert.equal(await fs.readFile(fixture.mapPath(`${result.paths[0]}/folder/data.txt`), 'utf8'), 'content');
    } else {
      await assert.rejects(service.operate({ operation: 'extract', parent, paths: [remote] }), /无法解压/);
      assert.deepEqual(await fs.readdir(fixture.mapPath(parent)), before);
    }
  }
});

test('archive member limit includes discarded dot roots and extraction failure removes only fresh output', options, async t => {
  const { fixture, parent } = await setup(t);
  const local = fixture.mapPath(`${parent}/roots.tar`);
  const code = `import sys,tarfile,json
namespace={'__name__':'archive_helper'};exec(sys.argv[1],namespace)
namespace['MAX_ITEMS']=2
with tarfile.open(sys.argv[2],'w') as archive:
    for _ in range(3):
        item=tarfile.TarInfo('./');item.type=tarfile.DIRTYPE;archive.addfile(item)
namespace['run']({'operation':'extract','parent':sys.argv[3],'paths':[sys.argv[2]]})
`;
  await assert.rejects(run(python, ['-I', '-c', code, helper, local, fixture.mapPath(parent)], { windowsHide: true }), /100000 entries/);
  assert.deepEqual(await fs.readdir(fixture.mapPath(parent)), ['roots.tar']);
  const source = await fixture.put('Desktop/failure.zip', Buffer.alloc(0));
  const failure = `import sys,zipfile,json
namespace={'__name__':'archive_helper'};exec(sys.argv[1],namespace)
with zipfile.ZipFile(sys.argv[2],'w') as archive:
    archive.writestr('first.txt','first');archive.writestr('second.txt','second')
original=zipfile.ZipFile.open
def reject_second(self,name,*args,**kwargs):
    if getattr(name,'filename',name)=='second.txt':raise OSError('injected read failure')
    return original(self,name,*args,**kwargs)
zipfile.ZipFile.open=reject_second
namespace['run']({'operation':'extract','parent':sys.argv[3],'paths':[sys.argv[2]]})
`;
  await fixture.put('Desktop/failure/keep.txt', 'pre-existing directory');
  const before = await fs.readdir(fixture.mapPath(parent));
  await assert.rejects(run(python, ['-I', '-c', failure, helper, fixture.mapPath(source), fixture.mapPath(parent)], { windowsHide: true }), /injected read failure/);
  assert.deepEqual(await fs.readdir(fixture.mapPath(parent)), before);
  assert.equal(await fs.readFile(fixture.mapPath(`${parent}/failure/keep.txt`), 'utf8'), 'pre-existing directory');
});

test('archive helper rejects source replacement during compression and removes the reserved archive', options, async t => {
  const { fixture, parent } = await setup(t);
  const source = await fixture.put('Desktop/changing.txt', 'original');
  const code = `import sys
namespace={'__name__':'archive_helper'};exec(sys.argv[1],namespace)
original=namespace['source_entries']
def replace_source(paths,parent):
    entries=original(paths,parent)
    paths[0].write_bytes(b'changed source with a different size')
    return entries
namespace['source_entries']=replace_source
namespace['run']({'operation':'compress','format':'zip','parent':sys.argv[3],'paths':[sys.argv[2]]})
`;
  await assert.rejects(run(python, ['-I', '-c', code, helper, fixture.mapPath(source), fixture.mapPath(parent)], { windowsHide: true }), /Source changed/);
  assert.deepEqual(await fs.readdir(fixture.mapPath(parent)), ['changing.txt']);
  assert.equal(await fs.readFile(fixture.mapPath(source), 'utf8'), 'changed source with a different size');
});

test('a selected directory alias archives its children and returns the selected path', options, async t => {
  const { fixture, service, parent } = await setup(t);
  await fixture.put('Desktop/actual/source.txt', 'directory alias content');
  await fs.symlink(fixture.mapPath(`${parent}/actual`), fixture.mapPath(`${parent}/alias`), process.platform === 'win32' ? 'junction' : 'dir');
  const selected = `${parent}/alias`;
  const result = await service.operate({ operation: 'compress', parent: selected, paths: [`${selected}/source.txt`], format: 'zip' });
  assert.equal(path.posix.dirname(result.paths[0]), selected);
  assert.ok((await fs.stat(fixture.mapPath(result.paths[0]))).isFile());
  const unpacked = await service.operate({ operation: 'extract', parent: selected, paths: result.paths });
  assert.equal(await fs.readFile(fixture.mapPath(`${unpacked.paths[0]}/source.txt`), 'utf8'), 'directory alias content');
});

test('archive operation refuses an SSH session changed during validation or execution', async () => {
  const input = { operation: 'compress', parent: '/work', paths: ['/work/source.txt'] };
  for (const phase of ['validation', 'execution']) {
    let commands = 0, signal;
    const backend = { client: {}, sftp: {}, home: '/home/test', async _execStream(_command, receivedSignal) {
      commands++; signal = receivedSignal;
      return { stream: Readable.from((async function* () { yield Buffer.from('{"paths":["/work/result.zip"]}'); backend.client = {}; })()), completion: Promise.resolve() };
    } };
    const service = { backend, async checked(value) { if (phase === 'validation' && value.endsWith('source.txt')) backend.sftp = {}; return value; } };
    await assert.rejects(archiveOperation(service, input), /SSH 连接已改变/);
    assert.equal(commands, phase === 'validation' ? 0 : 1);
    if (signal) assert.equal(signal.aborted, true);
  }
});

test('archive operation bounds output and rejects noncanonical or forged destination paths', async () => {
  for (const output of [Buffer.alloc(65537, 65), ...['/outside/result.zip', '/work/..', '/work/./bad.zip', '/work/bad\n.zip'].map(target => Buffer.from(JSON.stringify({ paths: [target] })))]) {
    let signal;
    const backend = { client: {}, sftp: {}, home: '/home/test', async _execStream(_command, receivedSignal) { signal = receivedSignal; return { stream: Readable.from([output]), completion: Promise.resolve() }; } };
    await assert.rejects(archiveOperation({ backend, async checked(value) { return value; } }, { operation: 'compress', parent: '/work', paths: ['/work/source.txt'] }), /返回内容过大|目标路径无效/);
    assert.equal(signal.aborted, true);
  }
});
