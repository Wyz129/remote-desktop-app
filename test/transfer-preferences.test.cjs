'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { transferDirectory, transferPreferences } = require('../lib/transfer-preferences.cjs');

test('transfer defaults accept absolute directories and reject malformed locations', () => {
  assert.equal(transferDirectory('/shared/projects/../uploads', 'remote'), '/shared/uploads');
  assert.equal(transferDirectory('  ', 'remote'), '');
  assert.equal(transferDirectory(path.resolve('downloads'), 'local'), path.resolve('downloads'));
  for (const value of ['relative', '~/folder', '/home/test\n/tmp', null, 'a'.repeat(4097)]) assert.throws(() => transferDirectory(value, 'remote'));
  assert.throws(() => transferDirectory('relative', 'local'));
});

test('invalid stored defaults fall back independently without discarding valid settings', () => {
  assert.deepEqual(transferPreferences({ defaultUploadDirectory: 'relative', defaultDownloadDirectory: path.resolve('downloads') }), { defaultUploadDirectory: '', defaultDownloadDirectory: path.resolve('downloads'), transferUploadDirectories: {} });
  assert.deepEqual(transferPreferences({ defaultUploadDirectory: '/shared', defaultDownloadDirectory: '/invalid\0' }), { defaultUploadDirectory: '/shared', defaultDownloadDirectory: '', transferUploadDirectories: {} });
});
