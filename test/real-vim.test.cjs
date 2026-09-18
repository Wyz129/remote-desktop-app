'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { SshBackend } = require('../lib/ssh-backend.cjs');

// Real local Vim processes; no SSH credentials, external servers, user vimrc,
// or user files are used. --not-a-term permits interactive key input over pipes.
// This verifies Vim's actual mode/write/quit/swap behavior, not an SSH PTY.
const defaultVim = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/vim.exe' : 'vim';
const vim = process.env.REMOTE_DESKTOP_TEST_VIM || defaultVim;
const available = spawnSync(vim, ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
const options = { skip: available ? false : 'No local Vim; set REMOTE_DESKTOP_TEST_VIM to enable.', timeout: 20000 };

async function waitUntil(predicate, message, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(20);
  }
}

async function tempDirectory(t) {
  const root = await fsp.realpath(os.tmpdir());
  const directory = await fsp.mkdtemp(path.join(root, 'remote-desktop-real-vim-'));
  t.after(async () => {
    const resolved = await fsp.realpath(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), root.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('remote-desktop-real-vim-'));
    await fsp.rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

async function startVim(t, { readonly = false, unnamed = false } = {}) {
  let child;
  let completion = Promise.resolve();
  const state = { output: '', closed: false, code: null };
  // Test cleanup is limited to this child. Register before directory cleanup.
  t.after(async () => {
    if (!child || state.closed) return;
    child.stdin.write('\x1c\x0e:qa!\r');
    await Promise.race([completion, delay(1500)]);
    if (!state.closed) { child.kill(); await completion; }
  });
  const directory = await tempDirectory(t);
  await fsp.writeFile(path.join(directory, 'file.txt'), 'original\n');
  const args = ['--not-a-term', '-Nu', 'NONE', '-U', 'NONE', '-i', 'NONE', '--noplugin',
    '--cmd', 'set directory=. nobackup nowritebackup',
    '-c', 'call writefile(["ready"], "ready.txt")'];
  if (readonly) args.push('-R');
  if (!unnamed) args.push('--', 'file.txt');
  child = spawn(vim, args, { cwd: directory, windowsHide: true, env: { ...process.env, TERM: 'xterm-256color' } });
  child.stdout.on('data', chunk => { state.output += chunk; });
  child.stderr.on('data', chunk => { state.output += chunk; });
  child.stdin.on('error', () => {});
  const backend = new SshBackend();
  const id = 'real-vim';
  const session = { program: 'vim', ready: true, closing: null };
  backend.shells.set(id, { write: data => child.stdin.write(data) });
  backend.terminalSessions.set(id, session);
  completion = new Promise(resolve => {
    child.once('close', (code, signal) => {
      state.closed = true; state.code = code;
      backend.shells.delete(id); backend.terminalSessions.delete(id);
      session.finish?.(code === 0 && !signal ? null : new Error(`Vim exited: ${code}, ${signal}`));
      resolve();
    });
  });
  await waitUntil(() => fs.existsSync(path.join(directory, 'ready.txt')), 'Vim did not finish startup');
  child.stdin.write('iEDITED');
  await waitUntil(() => state.output.includes('EDITED'), 'Vim did not enter Insert mode');
  return { backend, id, child, directory, state, completion };
}

async function assertNoSwap(directory) {
  assert.deepEqual((await fsp.readdir(directory)).filter(name => /\.sw[a-z]$/.test(name)), []);
}

test('real Vim: save from Insert mode writes edits, exits normally, and removes its swap', options, async t => {
  const { backend, id, directory, state } = await startVim(t);
  assert.ok((await fsp.readdir(directory)).some(name => /\.swp$/.test(name)), 'swap must exist before close');
  await backend.closeVim(id, true, 5000);
  assert.equal(state.code, 0);
  assert.equal(await fsp.readFile(path.join(directory, 'file.txt'), 'utf8'), 'EDITEDoriginal\n');
  await assertNoSwap(directory);
});

test('real Vim: discard from Insert mode keeps disk content and removes its swap', options, async t => {
  const { backend, id, directory, state } = await startVim(t);
  await backend.closeVim(id, false, 5000);
  assert.equal(state.code, 0);
  assert.equal(await fsp.readFile(path.join(directory, 'file.txt'), 'utf8'), 'original\n');
  await assertNoSwap(directory);
});

for (const [mode, keys] of [['Visual', '\x1bggV'], ['Command-line', '\x1b:let unfinished =']]) {
  test(`real Vim: save cancels ${mode} mode before writing and quitting`, options, async t => {
    const { backend, id, child, directory, state } = await startVim(t);
    child.stdin.write(keys);
    await backend.closeVim(id, true, 5000);
    assert.equal(state.code, 0);
    assert.equal(await fsp.readFile(path.join(directory, 'file.txt'), 'utf8'), 'EDITEDoriginal\n');
    await assertNoSwap(directory);
  });
}

test('real Vim: readonly save fails without killing the editor, then discard can close it', options, async t => {
  const { backend, id, directory, state } = await startVim(t, { readonly: true });
  await assert.rejects(backend.closeVim(id, true, 800), /Vim 尚未退出/);
  assert.equal(state.closed, false);
  assert.match(state.output, /E45/);
  assert.ok(backend.shells.has(id));
  assert.ok((await fsp.readdir(directory)).some(name => /\.swp$/.test(name)));
  assert.equal(await fsp.readFile(path.join(directory, 'file.txt'), 'utf8'), 'original\n');
  await backend.closeVim(id, false, 5000);
  await assertNoSwap(directory);
});

test('real Vim: unnamed modified buffer blocks save and remains available for user input', options, async t => {
  const { backend, id, directory, state } = await startVim(t, { unnamed: true });
  await assert.rejects(backend.closeVim(id, true, 800), /Vim 尚未退出/);
  assert.equal(state.closed, false);
  assert.match(state.output, /E(?:32|141)/);
  assert.ok(backend.shells.has(id));
  backend.writeShell(id, ':file recovered.txt\r');
  await waitUntil(() => state.output.includes('recovered.txt'), 'Vim did not accept a filename after failed close');
  await backend.closeVim(id, true, 5000);
  assert.equal(await fsp.readFile(path.join(directory, 'recovered.txt'), 'utf8'), 'EDITED\n');
  await assertNoSwap(directory);
});

test('real Vim: production VimEnter expression emits the exact startup marker bytes', options, async t => {
  const directory = await tempDirectory(t);
  let command;
  const backend = new SshBackend();
  backend.client = { exec: value => { command = value; } };
  backend.sftp = {}; backend.home = '/home/test';
  backend.openShell('marker', '/home/test', () => {}, () => {}, { program: 'vim' });
  const match = command.match(/(?:--cmd|-c) '((?:[^']|'\\'')*)'/);
  assert.ok(match, 'Vim startup hook must be present');
  const hook = match[1].replaceAll("'\\''", "'");
  assert.ok(hook.includes('"/dev/tty"'), 'production hook must target the interactive terminal');
  // Only redirect its output sink to inspect exact bytes without requiring a
  // PTY. The actual production Vim expression and VimEnter event are executed.
  const capture = hook.replace('"/dev/tty"', '"marker.bin"');
  const run = spawnSync(vim, ['-Nu', 'NONE', '-i', 'NONE', '-n', '-es', '--cmd', capture,
    '--cmd', 'autocmd VimEnter * qa!'], { cwd: directory, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr || String(run.error || 'Vim marker process failed'));
  const emitted = await fsp.readFile(path.join(directory, 'marker.bin'), 'utf8');
  assert.equal(emitted.trimEnd(), backend.terminalSessions.get('marker').marker);
});
