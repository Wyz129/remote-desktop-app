'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { LocalPicker } = require('../lib/local-picker.cjs');

function fixture() {
  const parent = new EventEmitter();
  parent.destroyed = false;
  parent.isDestroyed = () => parent.destroyed;
  const calls = [];
  const dialog = {
    showOpenDialog(owner, options) {
      return new Promise((resolve, reject) => calls.push({ owner, options, resolve, reject }));
    }
  };
  const picker = new LocalPicker({ dialog, getParent: () => parent });
  return { picker, parent, calls };
}

test('upload opens one parented native file dialog with direct multi-selection', async () => {
  const f = fixture();
  const pending = f.picker.choose();
  assert.equal(f.picker.choose('files'), pending);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].owner, f.parent);
  assert.deepEqual(f.calls[0].options.properties, ['openFile', 'multiSelections']);
  assert.equal(f.calls[0].options.title, '选择上传文件');
  assert.equal(f.parent.listenerCount('closed'), 1);
  const files = ['C:\\Work\\script.py', 'C:\\Work\\space 名称.txt'];
  f.calls[0].resolve({ canceled: false, filePaths: files });
  assert.deepEqual(await pending, files);
  assert.equal(f.parent.listenerCount('closed'), 0);
  assert.equal(f.picker.pending, null);
});

test('native cancellation returns no files and subsequent selection can proceed', async () => {
  const f = fixture();
  const first = f.picker.choose();
  f.calls[0].resolve({ canceled: true, filePaths: ['C:\\unused.txt'] });
  assert.deepEqual(await first, []);
  const second = f.picker.choose();
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve({ canceled: false, filePaths: ['C:\\chosen.txt'] });
  assert.deepEqual(await second, ['C:\\chosen.txt']);
});

test('directory and unknown modes are rejected before displaying any dialog', async () => {
  const f = fixture();
  await assert.rejects(f.picker.choose('directory'), /不支持文件夹/);
  await assert.rejects(f.picker.choose('other'), /无效/);
  assert.equal(f.calls.length, 0);
  const pending = f.picker.choose();
  await assert.rejects(f.picker.choose('directory'), /不支持文件夹/);
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve({ canceled: true, filePaths: [] });
  await pending;
});

test('disconnect ignores late native selections and permits a fresh session afterwards', async () => {
  const f = fixture();
  const stale = f.picker.choose();
  f.picker.close();
  assert.equal(f.picker.choose(), stale, 'do not open a second native dialog while the first remains visible');
  f.calls[0].resolve({ canceled: false, filePaths: ['C:\\stale.txt'] });
  assert.deepEqual(await stale, []);
  const fresh = f.picker.choose();
  f.calls[1].resolve({ canceled: false, filePaths: ['C:\\fresh.txt'] });
  assert.deepEqual(await fresh, ['C:\\fresh.txt']);
});

test('owner closing invalidates the selection without retaining close listeners', async () => {
  const f = fixture();
  const pending = f.picker.choose();
  f.parent.destroyed = true;
  f.parent.emit('closed');
  f.calls[0].resolve({ canceled: false, filePaths: ['C:\\late.txt'] });
  assert.deepEqual(await pending, []);
  assert.equal(f.parent.listenerCount('closed'), 0);
  assert.deepEqual(await f.picker.choose(), []);
  assert.equal(f.calls.length, 1, 'do not show a dialog owned by a destroyed window');
});

test('native failures are reported and clear pending state so users can retry', async () => {
  const f = fixture();
  const pending = f.picker.choose();
  const rejected = assert.rejects(pending, /native failure/);
  f.calls[0].reject(new Error('native failure'));
  await rejected;
  assert.equal(f.parent.listenerCount('closed'), 0);
  assert.equal(f.picker.pending, null);
  const retry = f.picker.choose('files');
  f.calls[1].resolve({ canceled: true, filePaths: [] });
  assert.deepEqual(await retry, []);
});
