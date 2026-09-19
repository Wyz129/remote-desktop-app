'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAuditor, resultSummary, safeUrl } = require('../lib/activity-audit.cjs');

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
});
