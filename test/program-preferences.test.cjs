'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PROGRAM_IDS, MAX_LAUNCH_COUNT, normalizeProgramPreferences, updateProgramPreferences } = require('../lib/program-preferences.cjs');

test('missing and malformed preferences have empty local defaults', () => {
  for (const input of [undefined, null, [], 'browser', 42, {}, { favorites: 'browser', usage: [] }]) {
    assert.deepEqual(normalizeProgramPreferences(input), { favorites: [], usage: {} });
  }
});

test('loading preferences preserves known favorites in order and strips invalid or secret fields', () => {
  const input = {
    favorites: ['image', 'browser', 'image', '__proto__', 'unknown', null, 2, 'settings'],
    usage: { browser: 42, image: '3', terminal: -1, video: 0, editor: 1.5, home: NaN, activity: Infinity, htop: Number.MAX_SAFE_INTEGER + 1, transfer: 3, unknown: 4 },
    password: 'must-discard', privateKey: 'must-discard'
  };
  const normalized = normalizeProgramPreferences(input);
  assert.deepEqual(normalized, { favorites: ['image', 'browser', 'settings'], usage: { browser: 42, transfer: 3 } });
  normalized.favorites.push('editor'); normalized.usage.browser++;
  assert.equal(input.favorites.includes('editor'), false);
  assert.equal(input.usage.browser, 42);
  assert.deepEqual(normalizeProgramPreferences({ usage: Object.create({ browser: 12 }) }).usage, {});
});

test('favorite operations deduplicate, remove safely, and preserve launch history without mutating input', () => {
  const original = { favorites: ['video'], usage: { browser: 7 } };
  const added = updateProgramPreferences(original, 'add', 'browser');
  assert.deepEqual(added, { favorites: ['video', 'browser'], usage: { browser: 7 } });
  assert.deepEqual(updateProgramPreferences(added, 'add', 'browser'), added);
  assert.deepEqual(updateProgramPreferences(added, 'remove', 'image'), added);
  assert.deepEqual(updateProgramPreferences(added, 'remove', 'browser'), original);
  assert.deepEqual(original, { favorites: ['video'], usage: { browser: 7 } });
});

test('launch counts accumulate per program and saturate at the persistence bound', () => {
  let prefs = updateProgramPreferences(undefined, 'launch', 'browser');
  prefs = updateProgramPreferences(prefs, 'launch', 'browser');
  prefs = updateProgramPreferences(prefs, 'launch', 'terminal');
  assert.deepEqual(prefs, { favorites: [], usage: { browser: 2, terminal: 1 } });
  const loaded = normalizeProgramPreferences({ favorites: [...PROGRAM_IDS], usage: { browser: Number.MAX_SAFE_INTEGER, terminal: MAX_LAUNCH_COUNT - 1 } });
  assert.equal(loaded.usage.browser, MAX_LAUNCH_COUNT);
  assert.equal(updateProgramPreferences(loaded, 'launch', 'browser').usage.browser, MAX_LAUNCH_COUNT);
  assert.equal(updateProgramPreferences(loaded, 'launch', 'terminal').usage.terminal, MAX_LAUNCH_COUNT);
  assert.equal(loaded.favorites.length, PROGRAM_IDS.length);
});

test('updates reject unsupported actions and program IDs without coercion', () => {
  for (const action of ['', null, undefined, 'replace', 'ADD', {}, ['add']]) assert.throws(() => updateProgramPreferences({}, action, 'browser'), /操作无效/);
  for (const id of ['', null, undefined, 'Browser', '__proto__', 'constructor', 'toString', {}, ['browser']]) assert.throws(() => updateProgramPreferences({}, 'add', id), /标识无效/);
});
