'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { desktopIdentity, desktopLocations } = require('../lib/desktop-preferences.cjs');

test('desktop locations stay isolated by server, port, account and verified host key', () => {
  const server = { host: 'Host.EXAMPLE', port: 22, username: 'alice', hostFingerprint: 'SHA256:first' };
  const key = desktopIdentity(server);
  const saved = desktopLocations(JSON.parse(JSON.stringify({ [key]: '/shared/arbitrary name' })));
  assert.equal(saved[desktopIdentity({ ...server, host: 'host.example' })], '/shared/arbitrary name');
  for (const change of [{ host: 'another' }, { port: 2222 }, { username: 'bob' }, { hostFingerprint: 'SHA256:second' }]) {
    assert.equal(saved[desktopIdentity({ ...server, ...change })], undefined);
  }
  assert.equal(desktopIdentity({ ...server, hostFingerprint: 'SHA256:first=' }), key);
});

test('invalid local paths cannot become desktop preferences', () => {
  const key = desktopIdentity({ host: 'host', username: 'alice', hostFingerprint: 'SHA256:first' });
  assert.deepEqual(desktopLocations({ [key]: '../relative' }), {});
  assert.deepEqual(desktopLocations({ [key]: '/bad\0path' }), {});
  assert.deepEqual(desktopLocations({ broken: '/' }), {});
  assert.deepEqual(desktopLocations(null), {});
  assert.deepEqual(desktopLocations({ [key]: '/' }), { [key]: '/' });
});
