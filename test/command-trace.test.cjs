'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { PassThrough } = require('node:stream');
const { SshBackend } = require('../lib/ssh-backend.cjs');
const { createCommandTrace } = require('../lib/command-trace.cjs');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');

function channel() {
  const stream = new PassThrough({ autoDestroy: false });
  stream.stderr = new PassThrough({ autoDestroy: false });
  return stream;
}

test('command tracing observes split UTF-8 without draining stdout or changing stream identity', async () => {
  const events = [], stream = channel();
  const backend = new SshBackend({ onCommandActivity: record => events.push(record) });
  const client = { exec(_command, callback) { callback(null, stream); } };
  backend.client = client;
  const pending = backend._execStream('printf 中文');
  const bytes = Buffer.from('中文 reply\n');
  stream.write(bytes.subarray(0, 2)); stream.write(bytes.subarray(2));
  stream.stderr.write(Buffer.from('诊断\n'));
  assert.equal(stream.readableFlowing, null, 'audit must not start flowing mode before a consumer attaches');
  assert.equal(stream.readableLength, bytes.length);
  const execution = await pending;
  assert.equal(execution.stream, stream);
  assert.deepEqual(stream.read(), bytes);
  stream.end(); stream.stderr.end(); stream.emit('close', 0);
  await execution.completion;
  assert.deepEqual(events.map(record => record.type), ['command', 'stdout', 'stderr', 'end']);
  assert.equal(events[0].command, 'printf 中文');
  assert.equal(events.filter(record => record.type === 'stdout').map(record => record.data).join(''), bytes.toString());
  assert.equal(new Set(events.map(record => record.operationId)).size, 1);
  assert.ok(events.every(record => record.operationId && Number.isFinite(Date.parse(record.time))));
});

test('command output is bounded at UTF-8 boundaries and binary downloads never enter transcripts', () => {
  const records = [], stream = channel();
  const trace = createCommandTrace('huge-command', record => records.push(record), { maxBytes: 4 });
  trace.attach(stream);
  stream.write(Buffer.from('中中文')); trace.end({ code: 0 });
  assert.equal(records.find(record => record.type === 'stdout').data, '中');
  assert.ok(!JSON.stringify(records).includes('�'));
  assert.equal(records.filter(record => record.type === 'output-truncated').length, 1);
  assert.equal(stream.read().toString(), '中中文');
  const binaryRecords = [], binaryStream = channel();
  const binary = createCommandTrace('cat -- movie.mp4', record => binaryRecords.push(record), { binary: true });
  binary.attach(binaryStream); binaryStream.write(Buffer.from('private file contents\x00'));
  binaryStream.stderr.write('diagnostic'); binary.end({ code: 0 });
  assert.equal(binaryRecords[0].outputMode, 'binary');
  assert.ok(!binaryRecords.some(record => record.type === 'stdout'));
  assert.equal(binaryRecords.find(record => record.type === 'stderr').data, 'diagnostic');
  assert.ok(!JSON.stringify(binaryRecords).includes('private file contents'));
});

test('connection changes, observer exceptions and immediate exec failures preserve command isolation', async () => {
  const events = [], stream = channel();
  const backend = new SshBackend({ onCommandActivity: record => events.push(record) });
  backend.client = { exec(_command, callback) { callback(null, stream); } };
  const operation = await backend._execStream('old-command');
  backend.client = { exec() {} };
  stream.write('old reply'); stream.end(); stream.emit('close', 0); await operation.completion;
  assert.deepEqual(events.map(record => record.type), ['command']);
  backend.onCommandActivity = () => { throw new Error('broken audit listener'); };
  const nextStream = channel(); backend.client = { exec(_command, callback) { callback(null, nextStream); } };
  const next = await backend._execStream('still-runs'); nextStream.write('ok');
  assert.equal(nextStream.read().toString(), 'ok'); nextStream.end(); nextStream.emit('close', 0); await next.completion;
  backend.onCommandActivity = record => events.push(record);
  backend.client = { exec() { throw new Error('exec refused'); } };
  await assert.rejects(backend._execStream('rejected'), /exec refused/);
  assert.deepEqual(events.slice(-2).map(record => record.type), ['command', 'end']);
  assert.equal(events.at(-1).error, 'exec refused');
});

test('PTY input callback preserves raw input and ignores missing or closing terminals', () => {
  const backend = new SshBackend(), input = [], sent = [];
  backend.shells.set('terminal', { write: data => sent.push(data) });
  backend.terminalSessions.set('terminal', { onInput: data => input.push(data) });
  backend.writeShell('terminal', 'ec\x7fho\r\x03');
  backend.writeShell('missing', 'ignored');
  backend.terminalSessions.get('terminal').closing = Promise.resolve();
  backend.writeShell('terminal', 'ignored');
  assert.deepEqual(input, ['ec\x7fho\r\x03']); assert.deepEqual(sent, input);
});

test('real encrypted SSH trace includes actual command, stdout, stderr and exit without authentication credentials', { timeout: 30000 }, async t => {
  const fixture = await createSshFixture(), events = [];
  const backend = new SshBackend({ onCommandActivity: record => events.push(record) });
  t.after(async () => { await backend.disconnect(); await fixture.close(); });
  await backend.connect(fixture.config);
  await assert.rejects(backend.execText('fixture-command'), /退出码 7/);
  const begin = events.find(record => record.command === 'fixture-command');
  const command = events.filter(record => record.operationId === begin.operationId);
  assert.equal(command[0].type, 'command'); assert.equal(command.at(-1).type, 'end');
  assert.equal(command.at(-1).code, 7);
  assert.equal(command.filter(record => record.type === 'stdout').map(record => record.data).join(''), 'remote command reply\n');
  assert.equal(command.filter(record => record.type === 'stderr').map(record => record.data).join(''), 'fixture diagnostic\n');
  const bytes = Buffer.from('binary-transfer-content\0\x01\xff');
  const source = await fixture.put('Desktop/transfer.bin', bytes);
  const downloaded = await backend.download(source, { destination: fixture.downloads });
  assert.deepEqual(await fs.readFile(downloaded.path), bytes);
  const downloadCommand = events.find(record => record.command?.startsWith('cat -- '));
  assert.equal(downloadCommand.outputMode, 'binary');
  assert.ok(!events.some(record => record.operationId === downloadCommand.operationId && record.type === 'stdout'));
  assert.ok(!JSON.stringify(events).includes('binary-transfer-content'));
  assert.ok(!JSON.stringify(events).includes(fixture.config.password));
});
