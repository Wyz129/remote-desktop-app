'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TransferCenter } = require('../lib/transfer-center.cjs');
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdesktop-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'history.json');
}
test('transfer history survives restart, sanitizes metadata and deletes records only', async t => {
  const historyFile = await setup(t), events = [], center = new TransferCenter(value => events.push(value), { historyFile });
  const file = path.join(path.dirname(historyFile), 'kept.txt'); await fs.writeFile(file, 'safe');
  await center.run({ id: 'done', source: 'remote', targetSide: 'local', targetDirectory: path.dirname(file), password: 'not-persisted' }, async progress => { progress({ done: 4, total: 4 }); return { path: file }; });
  center.update({ id: 'interrupted', status: 'running' }); await center.flush();
  const restored = new TransferCenter(null, { historyFile }); await restored.load();
  assert.equal(restored.get('done').status, 'complete'); assert.equal(restored.get('done').path, file);
  assert.match(restored.get('interrupted').error, /上次退出/);
  assert.ok(!(await fs.readFile(historyFile, 'utf8')).includes('not-persisted'));
  assert.throws(() => center.remove('interrupted'), /先完成或取消/);
  assert.deepEqual(center.clearHistory(), ['done']);
  center.update({ id: 'done', status: 'complete' }); assert.equal(center.get('done'), undefined, 'late completion cannot resurrect deleted history');
  await center.flush(); assert.equal(await fs.readFile(file, 'utf8'), 'safe');
  assert.deepEqual(JSON.parse(await fs.readFile(historyFile, 'utf8')).map(item => item.id), ['interrupted']);
  assert.ok(events.some(value => value.type === 'removed'));
});
test('cancellation and failures are terminal, history cap retains running transfers', async () => {
  const center = new TransferCenter(null, { historyLimit: 2 });
  let finish; const operation = center.run({ id: 'cancel' }, () => new Promise((resolve, reject) => { finish = reject; }), () => finish(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' })));
  assert.equal(center.cancel('cancel'), true); await assert.rejects(operation, /cancelled/); assert.equal(center.get('cancel').status, 'cancelled');
  center.update({ id: 'active', status: 'running' }); center.update({ id: 'new', status: 'complete' });
  assert.equal(center.get('cancel'), undefined); assert.ok(center.get('active')); assert.equal(center.cancel('new'), false);
  await assert.rejects(center.run({ id: 'active' }, async () => {}), /ID 已存在/);
});
test('corrupt history and disk write failures are reported', async t => {
  const historyFile = await setup(t); await fs.writeFile(historyFile, '{}');
  await assert.rejects(new TransferCenter().load(historyFile), /格式无效/);
  const events = [], center = new TransferCenter(value => events.push(value), { historyFile: path.join(historyFile, 'child.json') });
  center.update({ id: 'bad', status: 'complete' }); await assert.rejects(center.flush());
  assert.ok(events.some(value => value.type === 'history-error'));
});
