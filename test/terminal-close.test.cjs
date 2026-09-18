'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SshBackend } = require('../lib/ssh-backend.cjs');
const { TerminalGuard } = require('../lib/terminal-guard.cjs');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');

async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Terminal wait timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function setup(t, options = {}) {
  const fixture = await createSshFixture(options), backend = new SshBackend();
  t.after(async () => { await backend.disconnect(); await fixture.close(); });
  await backend.connect(fixture.config);
  const filePath = await fixture.put('Desktop/edit me.txt', 'original\n');
  let output = '';
  backend.openShell('editor', fixture.home, data => { output += data.toString(); }, () => {}, { program: 'vim', filePath });
  await until(() => output.includes('fixture-shell-ready'));
  if (!options.vimNotReady) await until(() => backend.terminalSessions.get('editor')?.ready);
  const dialogs = [], reports = [], closed = [], answers = [];
  const guard = new TerminalGuard({ getBackend: () => backend,
    ask: async value => { dialogs.push(value); return { response: answers.shift() ?? 2 }; },
    report: async value => { reports.push(value); }, closed: id => closed.push(id) });
  return { fixture, backend, guard, dialogs, reports, closed, answers };
}

test('Vim save waits for clean SSH process exit before confirming close', { timeout: 15000 }, async t => {
  const { fixture, backend, guard, dialogs, closed, answers } = await setup(t);
  answers.push(0);
  assert.equal(await guard.request('editor'), true);
  assert.deepEqual(dialogs[0].buttons, ['保存并关闭', '不保存关闭', '取消']);
  assert.ok(fixture.calls.shell.includes('\x1c\x0e:wqa\r'));
  assert.equal(backend.shells.size, 0); assert.deepEqual(closed, ['editor']);
});
test('Vim discard exits normally without a write command', { timeout: 15000 }, async t => {
  const { fixture, guard, answers } = await setup(t); answers.push(1);
  assert.equal(await guard.request('editor'), true);
  assert.ok(fixture.calls.shell.includes('\x1c\x0e:qa!\r'));
  assert.equal(fixture.calls.shell.some(data => data.includes(':wqa')), false);
});
test('cancel preserves Vim and all-close cancels connection transition', { timeout: 15000 }, async t => {
  const { fixture, backend, guard, answers, closed } = await setup(t); answers.push(2);
  assert.equal(await guard.all(), false);
  assert.equal(backend.shells.size, 1); assert.equal(fixture.calls.shell.length, 0); assert.deepEqual(closed, []);
  backend.writeShell('editor', 'continue editing');
  await until(() => fixture.calls.shell.includes('continue editing'));
});
test('E325 startup question receives no automatic close keystrokes', { timeout: 15000 }, async t => {
  const { fixture, backend, guard, reports, answers } = await setup(t, { vimNotReady: true }); answers.push(0);
  assert.equal(await guard.request('editor'), false);
  assert.equal(backend.shells.size, 1); assert.equal(fixture.calls.shell.length, 0);
  assert.match(reports[0].detail, /交换文件恢复/);
});
test('write failure keeps SSH channel usable and allows a later explicit discard', { timeout: 15000 }, async t => {
  const { fixture, backend } = await setup(t, { vimWriteFailure: true });
  await assert.rejects(backend.closeVim('editor', true, 200), /窗口已保留/);
  assert.equal(backend.shells.size, 1);
  backend.writeShell('editor', 'more input'); await until(() => fixture.calls.shell.includes('more input'));
  await backend.closeVim('editor', false); assert.equal(backend.shells.size, 0);
});
test('signal/abnormal Vim exit never claims a successful save', { timeout: 15000 }, async t => {
  const { guard, reports, answers, closed } = await setup(t, { vimExitCode: 1 }); answers.push(0);
  assert.equal(await guard.request('editor'), false); assert.deepEqual(closed, []);
  assert.match(reports[0].detail, /代码 1/);
});
test('repeated close clicks share one prompt and one close request', { timeout: 15000 }, async t => {
  const { guard, dialogs, fixture, answers } = await setup(t); answers.push(0);
  assert.deepEqual(await Promise.all([guard.request('editor'), guard.request('editor')]), [true, true]);
  assert.equal(dialogs.length, 1); assert.equal(fixture.calls.shell.filter(data => data.includes(':wqa')).length, 1);
});
test('shell close defaults to returning to editor without sending Vim commands', { timeout: 15000 }, async t => {
  const { fixture, backend, guard, answers, dialogs } = await setup(t);
  backend.closeShell('editor');
  backend.openShell('shell', fixture.home, () => {}, () => {}, { program: 'shell' });
  await until(() => backend.shells.has('shell'));
  answers.push(0); assert.equal(await guard.request('shell'), false);
  assert.match(dialogs[0].detail, /手动启动了 Vim/);
  assert.equal(fixture.calls.shell.length, 0);
  answers.push(1); assert.equal(await guard.request('shell'), true);
});
