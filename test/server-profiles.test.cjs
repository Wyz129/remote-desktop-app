'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serverProfile, profilesFromSettings, upsertProfile, storagePreferences, connectionTitle } = require('../lib/server-profiles.cjs');
const profile = { host: '192.0.2.10', port: 2222, username: 'tester', alias: '计算服务器', privateKeyPath: 'C:\\keys\\id' };
test('profiles exclude all credentials and preserve the selected public settings', () => {
  const patch = upsertProfile([], { ...profile, password: 'secret', passphrase: 'key-secret', privateKey: 'bytes', token: 'token' });
  assert.equal(patch.serverProfiles.length, 1);
  assert.deepEqual(Object.keys(patch.serverProfiles[0]).sort(), ['id', ...Object.keys(profile)].sort());
  assert.equal(patch.selectedServerId, patch.serverProfiles[0].id);
  const changed = upsertProfile(patch.serverProfiles, { ...profile, alias: '新别名' });
  assert.equal(changed.serverProfiles.length, 1); assert.equal(changed.selectedServerId, patch.selectedServerId);
  assert.equal(changed.serverProfiles[0].alias, '新别名');
});
test('profile validation prevents invalid endpoints and unbounded saved configuration', () => {
  for (const patch of [{ host: '' }, { host: 'host\nname' }, { port: 65536 }, { port: 0 }, { port: 2.5 }, { username: '' }, { alias: 'bad\nname' }]) assert.throws(() => serverProfile({ ...profile, ...patch }));
  assert.throws(() => upsertProfile(Array.from({ length: 100 }, (_, id) => ({ ...profile, id: String(id), host: `host${id}` })), profile), /100/);
});
test('legacy server settings migrate without credentials; old desktop locations do not migrate', () => {
  const legacy = { ...profile, password: 'discard', desktopLocations: { '["host",22,"user","fingerprint"]': '/somewhere' } };
  const profiles = profilesFromSettings(legacy); assert.equal(profiles.length, 1); assert.equal(profiles[0].password, undefined);
  assert.deepEqual(storagePreferences(legacy), { storageVersion: 2, desktopLocations: {} });
  assert.deepEqual(storagePreferences({ storageVersion: 2, desktopLocations: { '["host",22,"user","fingerprint"]': '/somewhere' } }), { storageVersion: 2, desktopLocations: { '["host",22,"user","fingerprint"]': '/somewhere' } });
  assert.equal(profilesFromSettings({ serverProfiles: [{ ...profile, password: 'discard' }, { host: '' }] }).length, 1);
});
test('window title uses the connected address, port and optional alias', () => {
  assert.equal(connectionTitle(profile, '::ffff:192.0.2.11'), 'Remote Desktop - ssh tester@192.0.2.11:2222 计算服务器');
  assert.equal(connectionTitle({ ...profile, alias: '' }, '2001:db8::1'), 'Remote Desktop - ssh tester@[2001:db8::1]:2222');
});
