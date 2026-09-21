'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalize, visibleActions } = require('../app/context-menu.js');
test('context menus contain only operations applicable to their target', () => {
  const blank = visibleActions({ desktop: true });
  assert.deepEqual(blank, ['new-file', 'new-folder', 'terminal', 'local-terminal', 'refresh', 'arrange']);
  assert.ok(visibleActions({ clipboard: true }).includes('paste'));
  assert.ok(!visibleActions({ clipboard: true }).includes('arrange'));
  const folder = visibleActions({ selected: [{ name: 'folder', type: 'folder' }], desktop: true, clipboard: true });
  assert.deepEqual(folder, ['open', 'rename', 'cut', 'copy', 'delete', 'shortcut', 'download', 'compress']);
  const archive = visibleActions({ selected: [{ name: 'data.tar.gz', type: 'file' }] });
  assert.ok(archive.includes('extract')); assert.ok(archive.includes('workbench'));
  const multiple = visibleActions({ selected: [{ name: 'a.zip' }, { name: 'b.zip' }] });
  assert.ok(!multiple.includes('rename')); assert.ok(!multiple.includes('extract')); assert.ok(!multiple.includes('workbench'));
  assert.deepEqual(visibleActions({ selected: [{ kind: 'command' }] }), ['open', 'rename', 'delete']);
});
test('preferences keep known built-ins only and can hide every action without running custom code', () => {
  assert.deepEqual(normalize({ hidden: ['open', 'open', 'exec'] }), { hidden: ['open'] });
  assert.throws(() => normalize({ hidden: ['exec'] }, true), /内建/);
  assert.throws(() => normalize({ hidden: 'open' }, true), /无效/);
  assert.deepEqual(normalize({ hidden: ['open'], command: 'arbitrary' }, true), { hidden: ['open'] });
  assert.deepEqual(visibleActions({ desktop: true }, { hidden: ['new-file', 'new-folder', 'terminal', 'local-terminal', 'refresh', 'arrange'] }), []);
  assert.deepEqual(normalize(), { hidden: [] });
});
