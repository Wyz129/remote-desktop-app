'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
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
  const dialogs = [], reports = [], closed = [], actions = [];
  const guard = new TerminalGuard({ getBackend: () => backend,
    ask: async value => { dialogs.push(value); throw new Error('Terminal close must not ask to save'); },
    report: async value => reports.push(value), closed: id => closed.push(id), onAction: action => actions.push(action) });
  return { fixture, backend, guard, dialogs, reports, closed, actions, filePath };
}

test('closing Vim immediately ends SSH channel without a save prompt or editor keystrokes', { timeout: 15000 }, async t => {
  const { fixture, backend, guard, dialogs, reports, closed, actions, filePath } = await setup(t);
  assert.equal(await guard.request('editor'), true);
  assert.equal(backend.shells.size, 0); assert.equal(backend.terminalSessions.size, 0);
  assert.deepEqual(dialogs, []); assert.deepEqual(reports, []); assert.deepEqual(closed, ['editor']);
  assert.deepEqual(fixture.calls.shell, []);
  assert.deepEqual(actions, [{ type: 'terminal-close-command', terminalId: 'editor', command: 'SSH channel close' }]);
  assert.equal(await fs.readFile(fixture.mapPath(filePath), 'utf8'), 'original\n');
});
test('a Vim startup recovery prompt does not prevent an explicit terminal close', { timeout: 15000 }, async t => {
  const { fixture, backend, guard, dialogs } = await setup(t, { vimNotReady: true });
  assert.equal(await guard.request('editor'), true); assert.equal(backend.shells.size, 0);
  assert.deepEqual(fixture.calls.shell, []); assert.deepEqual(dialogs, []);
});
test('all-close ends Vim, shell and htop sessions without prompts or injected input', { timeout: 15000 }, async t => {
  const { fixture, backend, guard, dialogs, closed } = await setup(t);
  for (const program of ['shell', 'htop']) backend.openShell(program, fixture.home, () => {}, () => {}, { program });
  await until(() => backend.shells.size === 3);
  assert.equal(await guard.all(), true);
  assert.equal(backend.shells.size, 0); assert.equal(backend.terminalSessions.size, 0);
  assert.deepEqual(new Set(closed), new Set(['editor', 'shell', 'htop']));
  assert.deepEqual(fixture.calls.shell, []); assert.deepEqual(dialogs, []);
});
test('an explicit close also cancels an SSH PTY that is still opening', { timeout: 15000 }, async t => {
  const { fixture, backend, guard, dialogs } = await setup(t);
  backend.openShell('pending', fixture.home, () => {}, () => {}, { program: 'shell' });
  assert.equal(backend.pendingShells.has('pending'), true);
  assert.equal(await guard.request('pending'), true);
  assert.equal(backend.pendingShells.has('pending'), false); assert.equal(backend.terminalSessions.has('pending'), false);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(backend.shells.has('pending'), false); assert.deepEqual(dialogs, []);
});
test('repeated close clicks share one request and one channel close', async () => {
  const calls = [], closed = [], backend = { closeShell: id => calls.push(id) };
  const guard = new TerminalGuard({ getBackend: () => backend, closed: id => closed.push(id) });
  const first = guard.request('shell'), second = guard.request('shell');
  assert.equal(first, second); assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(calls, ['shell']); assert.deepEqual(closed, ['shell']);
});
test('queued close remains bound to the original SSH backend', async () => {
  const originalCalls = [], replacementCalls = [];
  let backend = { closeShell: id => originalCalls.push(id) };
  const guard = new TerminalGuard({ getBackend: () => backend, closed: () => {} });
  const pending = guard.request('same-id'); backend = { closeShell: id => replacementCalls.push(id) };
  assert.equal(await pending, true); assert.deepEqual(originalCalls, ['same-id']); assert.deepEqual(replacementCalls, []);
});
test('closing after transport loss removes the local terminal without requiring a backend', async () => {
  const closed = [], guard = new TerminalGuard({ getBackend: () => null, closed: id => closed.push(id) });
  assert.equal(await guard.request('disconnected'), true); assert.equal(await guard.all(), true); assert.deepEqual(closed, ['disconnected']);
});
