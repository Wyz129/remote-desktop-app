'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { ActivityLog } = require('../lib/activity-log.cjs');
const { SshBackend } = require('../lib/ssh-backend.cjs');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');

const options = { timeout: 30000 };
const readLines = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('evicted active sessions and failed contexts release bounded bookkeeping', async () => {
  const log = new ActivityLog({ maxSessions: 1 });
  const first = log.beginCli({ id: 'first' }), second = log.beginCli({ id: 'second' });
  log.cli(first.id, { type: 'end' }); log.cli(second.id, { type: 'end' });
  assert.equal(log.sessionContexts.size, 0);
  const fixture = memoryBackend(); fixture.sftp.chmod = (_path, _mode, callback) => callback(new Error('denied'));
  await log.attach(fixture.backend, '/desktop');
  for (let index = 0; index < 150; index++) { const session = log.beginCli({}); log.cli(session.id, { type: 'end' }); }
  assert.equal(log.context.writers.size, 0); assert.equal(log.sessionContexts.size, 0);
  await log.disconnect();
});

test('an in-flight GUI operation finishes in its original desktop log after a desktop switch', async () => {
  const { createAuditor } = require('../lib/activity-audit.cjs');
  const fixture = memoryBackend(), log = new ActivityLog(), audit = createAuditor(log);
  await log.attach(fixture.backend, '/desktop');
  const originalPath = log.snapshot().systemLogPath; let finish;
  const operation = audit('fileOperation', { path: '/desktop/a' }, () => new Promise(resolve => { finish = resolve; }));
  await log.attach(fixture.backend, '/other');
  const newPath = log.snapshot().systemLogPath;
  finish({ success: true }); await operation; await log.flush();
  assert.ok(fixture.lines(originalPath).some(record => record.type === 'result' && record.result.success));
  assert.ok(!fixture.lines(newPath).some(record => record.action === 'fileOperation'));
  assert.equal(log.contexts.size, 1);
  await log.disconnect();
});

test('commands and CLI requests started while a log target initializes retain complete transcripts', async () => {
  const fixture = memoryBackend(), log = new ActivityLog();
  await log.attach(fixture.backend, '/desktop');
  const original = log.capture(), originalPath = log.snapshot().systemLogPath;
  const realpath = fixture.sftp.realpath;
  let resume, started;
  const initializing = new Promise(resolve => { started = resolve; });
  fixture.sftp.realpath = (name, callback) => {
    if (name === '/other') { resume = () => realpath(name, callback); started(); }
    else realpath(name, callback);
  };
  const changing = log.attach(fixture.backend, '/other');
  await initializing;
  assert.equal(log.capture(), original, 'initializing targets must not hide the usable current log');
  const release = log.retain(log.capture());
  assert.equal(log.system({ type: 'command', operationId: 'during-change', command: 'printf migration' }, original), true);
  const cli = log.beginCli({ id: 'during-change-cli' });
  log.cli(cli.id, { type: 'command', command: 'printf cli-migration' });
  fixture.sftp.realpath = realpath; resume();
  await changing;
  assert.equal(log.system({ type: 'stdout', operationId: 'during-change', data: 'migration' }, original), true);
  log.system({ type: 'end', operationId: 'during-change', code: 0 }, original); release();
  log.cli(cli.id, { type: 'stdout', data: 'cli-migration' }); log.cli(cli.id, { type: 'end', result: { code: 0 } });
  await log.flush();
  assert.deepEqual(fixture.lines(originalPath).filter(record => record.operationId === 'during-change').map(record => record.type), ['command', 'stdout', 'end']);
  assert.deepEqual(fixture.lines(cli.logPath).map(record => record.type), ['connection', 'command', 'stdout', 'end']);
  assert.ok(!fixture.allLines('/other/.log/').some(record => record.operationId === 'during-change' || record.operationId === cli.id));
  assert.equal(log.contexts.size, 1);
  await log.disconnect();
});

test('failed or stale log relocation leaves the previous writable context intact', async () => {
  const fixture = memoryBackend(), log = new ActivityLog();
  await log.attach(fixture.backend, '/desktop');
  const original = log.capture(), originalPath = log.snapshot().systemLogPath;
  const chmod = fixture.sftp.chmod;
  fixture.sftp.chmod = (name, mode, callback) => name.startsWith('/other/') ? callback(new Error('denied')) : chmod(name, mode, callback);
  assert.match((await log.attach(fixture.backend, '/other')).error, /denied/);
  assert.equal(log.capture(), original);
  fixture.sftp.chmod = chmod;
  let valid = true;
  const write = fixture.sftp.write;
  fixture.sftp.write = (...args) => { valid = false; write(...args); };
  assert.match((await log.attach(fixture.backend, '/other', { isCurrent: () => valid })).error, /连接已改变/);
  assert.equal(log.capture(), original);
  assert.equal(log.system({ type: 'command', command: 'still-recording' }), true);
  await log.flush();
  assert.ok(fixture.lines(originalPath).some(record => record.command === 'still-recording'));
  assert.equal(log.contexts.size, 1);
  await log.disconnect();
});

// Fault-injection SFTP models POSIX modes and exact handles. Actual encrypted
// SFTP I/O is exercised independently below; Windows fixtures cannot enforce
// remote Unix chmod semantics.
function memoryBackend() {
  const nodes = new Map(['/desktop', '/other'].map(name => [name, { kind: 'directory', mode: 0o755 }]));
  const handles = new Map(), calls = []; let nextHandle = 0;
  const noEntry = () => Object.assign(new Error('No such file'), { code: 2 });
  const node = name => { const value = nodes.get(name); if (!value) throw noEntry(); return value; };
  const attrs = value => ({ mode: value.mode, isDirectory: () => value.kind === 'directory', isFile: () => value.kind === 'file', isSymbolicLink: () => value.kind === 'link' });
  const respond = (callback, action) => queueMicrotask(() => { try { callback(null, action()); } catch (error) { callback(error); } });
  const sftp = {
    realpath(name, callback) { respond(callback, () => { const value = node(name); return value.kind === 'link' ? value.target : name; }); },
    lstat(name, callback) { respond(callback, () => attrs(node(name))); },
    mkdir(name, attrs, callback) { respond(callback, () => { calls.push(['mkdir', name, attrs]); if (nodes.has(name)) throw new Error('exists'); nodes.set(name, { kind: 'directory', mode: attrs.mode }); }); },
    chmod(name, mode, callback) { respond(callback, () => { node(name).mode = mode; calls.push(['chmod', name, mode]); }); },
    open(name, flags, attrs, callback) { respond(callback, () => {
      calls.push(['open', name, flags, attrs]); if (nodes.has(name)) throw new Error('File exists');
      assert.equal(flags, 'wx'); const value = { kind: 'file', mode: attrs.mode, bytes: Buffer.alloc(0), name };
      nodes.set(name, value); const handle = Buffer.from(String(++nextHandle)); handles.set(handle.toString(), value); return handle;
    }); },
    fstat(handle, callback) { respond(callback, () => attrs(handles.get(handle.toString()))); },
    fchmod(handle, mode, callback) { respond(callback, () => { handles.get(handle.toString()).mode = mode; }); },
    write(handle, bytes, offset, length, position, callback) { respond(callback, () => {
      const value = handles.get(handle.toString()); const result = Buffer.alloc(Math.max(value.bytes.length, position + length)); value.bytes.copy(result); bytes.copy(result, position, offset, offset + length); value.bytes = result;
    }); },
    close(handle, callback) { respond(callback, () => { handles.delete(handle.toString()); }); }
  };
  return { backend: { sftp }, sftp, nodes, handles, calls,
    lines(name) { return readLines(node(name).bytes.toString('utf8')); },
    allLines(prefix) { return [...nodes].filter(([name, value]) => name.includes(prefix) && value.kind === 'file').flatMap(([, value]) => readLines(value.bytes.toString('utf8'))); }
  };
}

async function realContext(t, logOptions = {}) {
  const fixture = await createSshFixture();
  const backend = new SshBackend();
  const events = [], log = new ActivityLog({ ...logOptions, onEvent: event => events.push(event) });
  t.after(async () => { await log.disconnect(); await backend.disconnect(); await fixture.close(); });
  await backend.connect(fixture.config);
  return { fixture, backend, log, events, desktop: `${fixture.home}/Desktop` };
}

test('real SFTP records CLI streams separately and system logs retain only connection references', options, async t => {
  const { fixture, backend, log, events, desktop } = await realContext(t);
  await log.attach(backend, desktop);
  const session = log.beginCli({ id: 'request-one', ip: '192.0.2.1', time: '2026-09-19T08:00:00.000Z', action: 'exec', password: 'connection-secret' });
  log.cli(session.id, { type: 'command', args: { command: 'printf 测试', cwd: desktop, password: 'auth-secret' } });
  log.cli(session.id, { type: 'stdout', data: '测试结果\n' });
  log.cli(session.id, { type: 'stderr', data: 'diagnostic\n' });
  log.cli(session.id, { type: 'end', result: { code: 7 } });
  log.system({ type: 'terminal-output', data: 'user-command\r\nreply\r\n', token: 'gui-secret' });
  await log.flush();
  assert.equal(log.snapshot().error, null);
  const cliText = await fs.readFile(fixture.mapPath(session.logPath), 'utf8');
  const systemText = await fs.readFile(fixture.mapPath(log.snapshot().systemLogPath), 'utf8');
  const cliRecords = readLines(cliText), systemRecords = readLines(systemText);
  assert.deepEqual(cliRecords.map(record => record.type), ['connection', 'command', 'stdout', 'stderr', 'end']);
  assert.equal(cliRecords.at(-1).result.code, 7);
  const reference = systemRecords.find(record => record.type === 'cli-connection');
  assert.deepEqual(reference, { type: 'cli-connection', operationId: session.id, time: session.time, ip: '192.0.2.1', logPath: session.logPath });
  assert.ok(!systemText.includes('printf')); assert.ok(!systemText.includes('测试结果'));
  assert.ok(systemText.includes('user-command')); assert.ok(!(cliText + systemText).includes('secret'));
  assert.equal(events.filter(event => event.type === 'connection').length, 1);
  assert.ok(events.filter(event => event.type === 'entry').every(event => event.entry.id && event.entry.seq && event.entry.operationId && ['cli', 'system'].includes(event.entry.scope)));
  assert.ok(events.some(event => event.type === 'entry' && event.entry.scope === 'system' && event.entry.type === 'terminal-output'));
  assert.ok(fixture.calls.sftp.filter(call => call[0] === 'OPEN' && call[1].includes('/.log/')).every(call => (call[2] & 32) !== 0));
});

test('real SFTP refuses symlink log directories and reports denied creation without breaking callers', options, async t => {
  const { fixture, backend, log, desktop } = await realContext(t);
  fixture.link(`${desktop}/.log`, '/outside');
  const linked = await log.attach(backend, desktop);
  assert.match(linked.error, /符号链接/);
  assert.equal(log.system({ type: 'should-not-write' }), false);
  assert.ok(!fixture.calls.sftp.some(call => call[0] === 'OPEN' && call[1].startsWith('/outside')));
  await log.disconnect(); fixture.links.delete(`${desktop}/.log`); fixture.readOnlyPaths.add(desktop);
  const denied = await log.attach(backend, desktop);
  assert.match(denied.error, /Permission denied/);
  const session = log.beginCli({ action: 'exec' });
  assert.equal(session.status, 'error'); log.cli(session.id, { type: 'end' });
});

test('records rotate at complete JSON lines and use private exclusive files', async () => {
  const fixture = memoryBackend(), log = new ActivityLog({ rotateBytes: 550 });
  await log.attach(fixture.backend, '/desktop');
  const session = log.beginCli({ id: '../../not-a-file-name', ip: null });
  for (let index = 0; index < 8; index += 1) log.cli(session.id, { type: 'stdout', data: `${index}:${'中'.repeat(70)}` });
  log.cli(session.id, { type: 'end' });
  await log.flush();
  const saved = log.snapshot().sessions[0];
  assert.ok(saved.logPaths.length > 2);
  const data = saved.logPaths.flatMap(name => fixture.lines(name));
  assert.equal(data.filter(record => record.type === 'stdout').length, 8);
  assert.ok(data.filter(record => record.type === 'stdout').every((record, index) => record.data === `${index}:${'中'.repeat(70)}`));
  const refs = fixture.allLines('/system-').filter(record => record.type === 'cli-connection');
  assert.deepEqual(refs.map(record => record.logPath), saved.logPaths);
  for (const [name, value] of fixture.nodes) if (name.includes('/.log')) assert.equal(value.mode, value.kind === 'file' ? 0o600 : 0o700);
  assert.ok(fixture.calls.filter(call => call[0] === 'open').every(call => call[2] === 'wx' && call[3].mode === 0o600));
  await log.disconnect(); assert.equal(fixture.handles.size, 0);
});

test('desktop change guards stale GUI results and running CLI stays in original log', async () => {
  const fixture = memoryBackend(), log = new ActivityLog();
  await log.attach(fixture.backend, '/desktop');
  const old = log.capture(), session = log.beginCli({ id: 'long-running' });
  log.cli(session.id, { type: 'command', command: 'long-command' });
  await log.attach(fixture.backend, '/other');
  assert.equal(log.system({ type: 'old-gui-result' }, old), false);
  assert.equal(log.system({ type: 'new-gui-result' }), true);
  assert.equal(log.cli(session.id, { type: 'stdout', data: 'late-original-result' }), true);
  log.cli(session.id, { type: 'end' });
  await log.flush();
  assert.ok(fixture.lines(session.logPath).some(record => record.data === 'late-original-result'));
  assert.ok(!fixture.allLines('/other/.log/').some(record => record.data === 'late-original-result' || record.type === 'old-gui-result'));
  assert.ok(fixture.allLines('/other/.log/').some(record => record.type === 'new-gui-result'));
  assert.equal(log.contexts.size, 1);
  await log.disconnect(); assert.equal(fixture.handles.size, 0);
});

test('reconnect never transfers old CLI output or GUI capture to another backend', async () => {
  const first = memoryBackend(), second = memoryBackend(), log = new ActivityLog();
  await log.attach(first.backend, '/desktop');
  const old = log.capture(), session = log.beginCli({ id: 'old-connection' });
  await log.attach(second.backend, '/desktop');
  assert.equal(log.system({ type: 'late-old-gui' }, old), false);
  assert.equal(log.cli(session.id, { type: 'stdout', data: 'late-old-cli' }), false);
  await log.flush();
  assert.ok(!second.allLines('/.log/').some(record => record.type === 'late-old-gui' || record.data === 'late-old-cli'));
  assert.equal(first.handles.size, 0);
  await log.disconnect();
});

test('queue overflow visibly stops logging while UI ring stays bounded', async () => {
  const fixture = memoryBackend(), log = new ActivityLog({ maxQueueBytes: 1800, maxEntries: 3, maxEntryBytes: 5000, maxSessions: 2 });
  await log.attach(fixture.backend, '/desktop');
  const session = log.beginCli({ id: 'flood' });
  for (let index = 0; index < 10; index += 1) log.cli(session.id, { type: 'stdout', data: 'x'.repeat(600) });
  log.cli(session.id, { type: 'end' });
  await log.flush();
  const snapshot = log.snapshot();
  assert.match(snapshot.error, /内存上限/); assert.equal(snapshot.sessions[0].status, 'error');
  assert.ok(snapshot.entries.length <= 3); assert.equal(log.context.queuedBytes, 0);
  assert.ok(snapshot.entries.at(-1).seq > snapshot.entries[0].seq);
  assert.equal(log.system({ type: 'post-failure' }), false);
  await log.disconnect(); assert.equal(fixture.handles.size, 0);
});

test('write failure after end is still visible on session and closes remote handles', async () => {
  const fixture = memoryBackend(), events = [], log = new ActivityLog({ onEvent: event => events.push(event) });
  await log.attach(fixture.backend, '/desktop');
  const session = log.beginCli({ id: 'disk-failure' });
  await log.flush();
  fixture.sftp.write = (...args) => queueMicrotask(() => args.at(-1)(new Error('disk full')));
  log.cli(session.id, { type: 'end', result: { code: 0 } });
  await log.flush();
  assert.match(log.snapshot().sessions[0].error, /disk full/);
  assert.ok(events.some(event => event.type === 'session' && event.session.status === 'error'));
  await log.disconnect(); assert.equal(fixture.handles.size, 0);
});

test('replacement of log directory with symlink is caught before opening a new file', async () => {
  const fixture = memoryBackend(), log = new ActivityLog();
  await log.attach(fixture.backend, '/desktop');
  fixture.nodes.set('/desktop/.log', { kind: 'link', target: '/other', mode: 0o777 });
  const session = log.beginCli({ id: 'changed-directory' });
  log.cli(session.id, { type: 'end' });
  await log.flush();
  assert.match(log.snapshot().error, /符号链接/);
  assert.ok(!fixture.nodes.has(session.logPath));
  await log.disconnect();
});

test('stalled SFTP calls time out and expose failure instead of hanging app shutdown', async () => {
  const fixture = memoryBackend(), log = new ActivityLog({ operationTimeout: 20 });
  fixture.sftp.realpath = () => {};
  const snapshot = await log.attach(fixture.backend, '/desktop');
  assert.match(snapshot.error, /超时/);
  await log.disconnect();
});

test('explicit storage directory keeps desktop changes away from legacy desktop log folders', async () => {
  const fixture = memoryBackend(), log = new ActivityLog();
  fixture.nodes.set('/storage', { kind: 'directory', mode: 0o700 });
  await log.attach(fixture.backend, '/desktop', { directory: '/storage/log' });
  const first = log.capture();
  assert.match(log.snapshot().systemLogPath, /^\/storage\/log\/system-/);
  assert.equal(fixture.nodes.has('/desktop/.log'), false);
  await log.attach(fixture.backend, '/desktop', { directory: '/storage/log' });
  assert.equal(log.capture(), first, 'repeated attach to same desktop and directory does not create a new session');
  await log.attach(fixture.backend, '/other', { directory: '/storage/log' });
  log.system({ type: 'command', command: 'uname -r', operationId: 'query' });
  await log.flush();
  assert.equal(fixture.nodes.has('/other/.log'), false);
  assert.ok(fixture.allLines('/storage/log/').some(record => record.command === 'uname -r'));
  await log.disconnect();
});

test('system commands and PTY input enter the ordered bounded live stream with matching persisted timestamps', async () => {
  const fixture = memoryBackend(), events = [], log = new ActivityLog({ maxEntries: 4, onEvent: event => events.push(event) });
  await log.attach(fixture.backend, '/desktop');
  const records = [
    { type: 'command', command: 'printf 测试', operationId: 'command-1' },
    { type: 'stdout', data: '测试', operationId: 'command-1' },
    { type: 'end', code: 0, operationId: 'command-1' },
    { type: 'terminal-input', terminalId: 'term', data: 'echo raw\u0003\r', password: 'omit-credential' },
    { type: 'terminal-output', terminalId: 'term', data: 'reply\r\n' }
  ];
  for (const record of records) assert.equal(log.system(record), true);
  await log.flush();
  const live = events.filter(event => event.type === 'entry').map(event => event.entry);
  const persisted = fixture.lines(log.snapshot().systemLogPath).slice(1);
  assert.equal(live.length, records.length);
  assert.deepEqual(live.map(record => record.type), records.map(record => record.type));
  assert.equal(log.snapshot().entries.length, 4);
  assert.ok(live.every(record => record.scope === 'system' && record.source === 'system' && record.sessionId === 'system' && record.operationId && Number.isFinite(Date.parse(record.time))));
  assert.deepEqual(live.map(record => record.time), persisted.map(record => record.time));
  assert.equal(persisted[3].data, 'echo raw\u0003\r');
  assert.equal(persisted[3].password, undefined);
  assert.equal(persisted[4].operationId, 'term');
  assert.ok(!JSON.stringify(log.snapshot()).includes('omit-credential'));
  await log.disconnect();
});
