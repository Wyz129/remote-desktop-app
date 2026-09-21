'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAuditor, createSystemCommandLogger, resultSummary, safeUrl, systemRecord } = require('../lib/activity-audit.cjs');

test('GUI audit binds completion to the original context and preserves failures', async () => {
  let context = { id: 'first' }, release;
  const records = [], audit = createAuditor({ capture: () => context, system: (record, token) => records.push({ record, token }) });
  const original = context;
  const task = audit('download', { path: '/a' }, () => new Promise(resolve => { release = resolve; }));
  context = { id: 'second' }; release({ path: '/b', total: 12 }); await task;
  assert.equal(records.length, 2); assert.ok(records.every(value => value.token === original));
  assert.equal(records[0].record.operationId, records[1].record.operationId);
  await assert.rejects(audit('save', { path: '/a' }, () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }), /denied/);
  assert.equal(records.at(-1).record.type, 'error'); assert.equal(records.at(-1).record.error.code, 'EACCES');
});

test('system result summaries exclude file bodies and browser URL credentials', () => {
  assert.deepEqual(resultSummary({ path: '/a', text: 'private content', token: 'secret', password: 'secret', readOnly: true }), { path: '/a', readOnly: true });
  assert.deepEqual(resultSummary([{ text: 'private content' }]), { count: 1 });
  assert.equal(safeUrl('https://user:password@example.test/a?token=secret#credential'), 'https://example.test/a');
  const notebook = systemRecord({ type: 'jupyter-output', output: { type: 'stream', text: 'notebook reply' } });
  assert.deepEqual(notebook.result, { type: 'stream', text: 'notebook reply' }); assert.equal(notebook.output, '#成功');
  assert.equal(systemRecord({ type: 'end', code: null, signal: 'SIGTERM' }).output, '#失败');
});

test('GUI summaries suppress only nested internal commands while concurrent tasks retain their own results', async () => {
  const records = [], context = { id: 'one' }; let retained = 0, released = 0, finish;
  const log = { capture: () => context, retain: () => { retained++; return () => { released++; }; }, system: record => records.push(systemRecord(record)) };
  const audit = createAuditor(log), trace = createSystemCommandLogger(log);
  const task = audit('readDirectory', { path: '/shared' }, async () => {
    await Promise.resolve(); trace({ type: 'command', operationId: 'inside', command: 'internal implementation source' });
    await new Promise(resolve => { finish = resolve; });
    return { resolvedPath: '/shared', entries: [{ name: 'a' }] };
  });
  await Promise.resolve();
  trace({ type: 'command', operationId: 'outside', command: 'uname -r' });
  trace({ type: 'stdout', operationId: 'inside', data: 'internal transient data' });
  trace({ type: 'stdout', operationId: 'outside', data: 'Linux 6.8' });
  trace({ type: 'end', operationId: 'inside', code: 0 });
  trace({ type: 'end', operationId: 'outside', code: 0 });
  finish(); await task;
  assert.ok(!JSON.stringify(records).includes('internal implementation source'));
  assert.ok(!JSON.stringify(records).includes('internal transient data'));
  assert.ok(records.some(record => record.operationId === 'outside' && record.data === 'Linux 6.8'));
  assert.equal(records[0].input, '#访问目录');
  assert.equal(records.at(-1).output, '#成功'); assert.deepEqual(records.at(-1).result, { resolvedPath: '/shared', count: 1 });
  assert.equal(trace.operations.size, 0); assert.equal(retained, released);
  await audit('fileOperation', { operation: 'move' }, async () => ({ success: false, error: 'Permission denied' }));
  assert.equal(records.at(-1).operationName, '移动文件'); assert.equal(records.at(-1).output, '#失败');
});
