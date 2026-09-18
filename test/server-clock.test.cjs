'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable, PassThrough } = require('node:stream');
const { existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { getServerInfo, SERVER_CLOCK_COMMAND } = require('../lib/server-clock.cjs');

const epochMs = Date.UTC(2026, 8, 18, 4, 5, 6);
function reply({ username = 'tester', hostname = 'compute-01', epoch = epochMs / 1000, localTime = '2026-09-18T12:05:06', utcOffset = '+0800', abbreviation = 'CST', timeZone = 'Asia/Shanghai' } = {}) {
  return `${username}\0${hostname}\0${epoch}|${localTime}|${utcOffset}|${abbreviation}\0${timeZone}\0`;
}
function backendFor(output, options = {}) {
  const calls = [];
  return { calls, async _execStream(command, signal) {
    calls.push({ command, signal });
    return { stream: Readable.from([Buffer.from(output)]), completion: options.completion || Promise.resolve() };
  } };
}

test('server clock uses a validated remote IANA timezone and local date snapshot', async () => {
  const backend = backendFor(reply());
  const info = await getServerInfo(backend);
  assert.deepEqual(info, { type: 'serverInfo', remote: true, available: true, username: 'tester', hostname: 'compute-01', epochMs, localTime: '2026-09-18T12:05:06', timeZone: 'Asia/Shanghai', utcOffset: '+0800', utcOffsetMinutes: 480, timeZoneLabel: 'Asia/Shanghai (UTC+08:00)' });
  assert.equal(backend.calls[0].command, SERVER_CLOCK_COMMAND);
  assert.equal(backend.calls[0].signal.aborted, false);
});

test('ambiguous abbreviations, POSIX TZ rules and unknown zones retain the server offset', async () => {
  for (const timeZone of ['CST', 'CST-8', 'Unknown/Remote', '']) {
    const info = await getServerInfo(backendFor(reply({ timeZone })));
    assert.equal(info.timeZone, null);
    assert.equal(info.utcOffsetMinutes, 480);
    assert.equal(info.localTime, '2026-09-18T12:05:06');
    assert.equal(info.timeZoneLabel, `${timeZone || 'CST'} (UTC+08:00)`);
  }
});

test('timezone names inconsistent with the measured local clock fall back to the remote offset', async () => {
  const info = await getServerInfo(backendFor(reply({ timeZone: 'Europe/London', abbreviation: 'CUSTOM' })));
  assert.equal(info.timeZone, null);
  assert.equal(info.utcOffsetMinutes, 480);
  assert.equal(info.timeZoneLabel, 'Europe/London (UTC+08:00)');
});

test('TZ colon and zoneinfo paths resolve without executing their contents', async () => {
  for (const timeZone of [':Asia/Shanghai', ':/usr/share/zoneinfo/Asia/Shanghai', '/usr/share/zoneinfo/posix/Asia/Shanghai']) {
    const info = await getServerInfo(backendFor(reply({ timeZone })));
    assert.equal(info.timeZone, 'Asia/Shanghai');
  }
  const backend = backendFor(reply({ timeZone: '$(touch /tmp/do-not-create)' }));
  const info = await getServerInfo(backend);
  assert.equal(info.timeZone, null);
  assert.equal(backend.calls[0].command.includes('do-not-create'), false);
});

test('server clock preserves fractional-hour offsets and date rollover west of UTC', async () => {
  for (const entry of [
    { localTime: '2026-09-18T09:50:06', utcOffset: '+0545', abbreviation: '+0545', timeZone: 'Asia/Kathmandu', minutes: 345 },
    { localTime: '2026-09-17T19:35:06', utcOffset: '-0830', abbreviation: 'CUSTOM', timeZone: 'CUSTOM8:30', minutes: -510 },
    { localTime: '2026-09-18T04:05:06', utcOffset: '+0000', abbreviation: 'UTC', timeZone: 'UTC', minutes: 0 },
  ]) {
    const info = await getServerInfo(backendFor(reply(entry)));
    assert.equal(info.localTime, entry.localTime);
    assert.equal(info.utcOffsetMinutes, entry.minutes);
    if (entry.timeZone === 'UTC') assert.equal(info.timeZone, 'UTC');
  }
});

test('server clock rejects malformed, impossible or inconsistent time data without UTC fallback', async () => {
  const invalid = [
    '', 'tester\ncompute-01\n1234\nUTC', reply({ epoch: 'NaN' }), reply({ epoch: '99999999999999999999' }),
    reply({ localTime: '2026-02-30T12:05:06' }), reply({ localTime: '2026-09-18T12:05:07' }),
    reply({ utcOffset: '' }), reply({ utcOffset: '+0860' }), reply({ utcOffset: '+2400' }),
    reply({ username: '' }), reply({ hostname: 'host\nforged' }), reply({ timeZone: 'UTC\nEtc/UTC' }),
    `${reply()}extra`,
  ];
  for (const output of invalid) {
    const backend = backendFor(output);
    await assert.rejects(getServerInfo(backend), /格式无效/);
    assert.equal(backend.calls[0].signal.aborted, true);
  }
});

test('server clock caps output and propagates SSH failures', async () => {
  const backend = backendFor(Buffer.alloc(8193));
  await assert.rejects(getServerInfo(backend), /8 KiB/);
  assert.equal(backend.calls[0].signal.aborted, true);
  const failed = backendFor(reply(), { completion: Promise.reject(new Error('SSH permission denied')) });
  await assert.rejects(getServerInfo(failed), /SSH permission denied/);
  assert.equal(failed.calls[0].signal.aborted, true);
});

test('server clock timeout aborts only its SSH command', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = new PassThrough(); let commandSignal;
  const backend = { async _execStream(_command, signal) {
    commandSignal = signal;
    const completion = new Promise((_, reject) => signal.addEventListener('abort', () => { stream.destroy(); reject(new Error('aborted')); }, { once: true }));
    return { stream, completion };
  } };
  const rejection = assert.rejects(getServerInfo(backend), /超时/);
  await Promise.resolve();
  t.mock.timers.tick(8000);
  await rejection;
  assert.equal(commandSignal.aborted, true);
  assert.equal(stream.destroyed, true);
});

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
test('fixed query executes with TZ taking precedence over host timezone files', { skip: !existsSync(shell) }, async () => {
  // POSIX rules do not depend on an installed zoneinfo database (Git Bash
  // typically does not ship one). IANA interpretation is verified above.
  for (const [tz, offset] of [['CST-8', '+0800'], ['NPT-5:45', '+0545'], ['CUSTOM8:30', '-0830'], ['', '+0000']]) {
    const output = execFileSync(shell, ['-c', SERVER_CLOCK_COMMAND], { env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 5000, windowsHide: true });
    const info = await getServerInfo(backendFor(output));
    assert.equal(info.utcOffset, offset);
    assert.equal(info.timeZoneLabel.startsWith(`${tz || 'UTC'} (`), true);
    assert.match(info.localTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  }
});
