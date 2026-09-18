'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Server, utils } = require('ssh2');
let hostKey;
const HOME = '/uploads';

// Deliberately narrow SSH/SFTP server: commands are parsed from a fixed grammar,
// never executed by a local shell. All bytes stay inside this temporary tree.
async function createUploadFixture(options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rdesktop-upload-test-'));
  const remoteRoot = path.join(root, 'remote'); await fsp.mkdir(remoteRoot);
  const localRoot = path.join(root, 'local'); await fsp.mkdir(localRoot);
  if (!hostKey) hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  const calls = { exec: [], sftp: [] }, connections = new Set(); let renameQueue = Promise.resolve();
  const denied = new Set();
  const mapPath = remote => {
    const normalized = path.posix.normalize(remote);
    if (normalized !== HOME && !normalized.startsWith(HOME + '/')) throw Object.assign(new Error('Outside fixture'), { code: 'EACCES' });
    if (denied.has(normalized)) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    return path.join(remoteRoot, ...normalized.slice(HOME.length).split('/').filter(Boolean));
  };
  const attrs = stat => ({ mode: stat.mode, size: stat.size, uid: stat.uid, gid: stat.gid, mtime: Math.floor(stat.mtimeMs / 1000), atime: Math.floor(stat.atimeMs / 1000) });
  const server = new Server({ hostKeys: [hostKey] }, client => {
    connections.add(client); client.on('error', () => {}); client.once('close', () => connections.delete(client));
    client.on('authentication', context => context.method === 'password' && context.password === 'fixture-password' ? context.accept() : context.reject());
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); session.on('error', () => {});
      session.on('exec', (acceptExec, _reject, info) => {
        calls.exec.push(info.command); const stream = acceptExec(); stream.on('error', () => {});
        const finish = (code, stdout, stderr) => { if (stdout) stream.write(stdout); if (stderr) stream.stderr.write(stderr); stream.exit(code); stream.end(); };
        if (info.command === 'printf \'%s\' "$HOME"') return finish(0, HOME);
        if (info.command === 'test-success' || info.command === "cd -- '/uploads' && (\ntest-success\n)") return finish(0, '你好 output\n', 'warning\n');
        if (info.command === 'test-failure') return finish(17, '', 'remote failed\n');
        if (info.command === 'test-timeout') { stream.on('end', () => {}); return; }
        if (info.command === 'test-large-output') return finish(0, 'x'.repeat(16384));
        const prefix = 'umask 077; set -C; cat > ';
        if (!info.command.startsWith(prefix)) return finish(1, '', 'Unsupported fixture command');
        void (async () => {
          const quoted = info.command.slice(prefix.length);
          if (!quoted.startsWith("'") || !quoted.endsWith("'")) throw new Error('Unquoted target');
          const remote = quoted.slice(1, -1).replaceAll("'\\''", "'");
          const output = fs.createWriteStream(mapPath(remote), { flags: 'wx' });
          stream.pipe(output);
          output.on('error', error => finish(1, '', error.message));
          output.once('finish', () => finish(0));
          stream.once('close', () => output.destroy());
        })().catch(error => finish(1, '', error.message));
      });
      session.on('sftp', acceptSftp => {
        const sftp = acceptSftp(), handles = new Map(); let next = 0;
        sftp.on('error', () => {});
        const run = (id, name, work) => { calls.sftp.push(name); void Promise.resolve().then(work).catch(error => sftp.status(id, error.code === 'ENOENT' ? 2 : error.code === 'EACCES' ? 3 : 4, error.message)); };
        for (const kind of ['STAT', 'LSTAT']) sftp.on(kind, (id, remote) => run(id, [kind, remote], async () => sftp.attrs(id, attrs(await fsp.lstat(mapPath(remote))))));
        sftp.on('REALPATH', (id, remote) => run(id, ['REALPATH', remote], async () => { const stat = await fsp.stat(mapPath(remote)); sftp.name(id, [{ filename: remote, longname: remote, attrs: attrs(stat) }]); }));
        sftp.on('MKDIR', (id, remote) => run(id, ['MKDIR', remote], async () => { await fsp.mkdir(mapPath(remote)); sftp.status(id, 0); }));
        sftp.on('RMDIR', (id, remote) => run(id, ['RMDIR', remote], async () => { await fsp.rmdir(mapPath(remote)); sftp.status(id, 0); }));
        sftp.on('REMOVE', (id, remote) => run(id, ['REMOVE', remote], async () => { await fsp.unlink(mapPath(remote)); sftp.status(id, 0); }));
        sftp.on('RENAME', (id, source, target) => run(id, ['RENAME', source, target], async () => {
          // Model SSH_FXP_RENAME v3's no-replace semantics, not Node rename's
          // overwrite semantics. Serialize this fixture's check-and-move.
          const operation = renameQueue.catch(() => {}).then(async () => {
            try { await fsp.lstat(mapPath(target)); throw Object.assign(new Error('File exists'), { code: 'EEXIST' }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            await fsp.rename(mapPath(source), mapPath(target));
          }); renameQueue = operation;
          await operation; sftp.status(id, 0);
        }));
        sftp.on('OPEN', (id, remote, flags) => run(id, ['OPEN', remote, flags], async () => {
          const file = await fsp.open(mapPath(remote), flags & 32 ? 'wx' : 'r'); const handle = Buffer.alloc(4); handle.writeUInt32BE(++next); handles.set(next, file); sftp.handle(id, handle);
        }));
        sftp.on('WRITE', (id, handle, offset, data) => run(id, ['WRITE', offset, data.length], async () => {
          if (options.slowWrites) await new Promise(resolve => setTimeout(resolve, 15));
          await handles.get(handle.readUInt32BE()).write(data, 0, data.length, offset); sftp.status(id, 0);
        }));
        sftp.on('FSTAT', (id, handle) => run(id, ['FSTAT'], async () => sftp.attrs(id, attrs(await handles.get(handle.readUInt32BE()).stat()))));
        sftp.on('CLOSE', (id, handle) => run(id, ['CLOSE'], async () => { const key = handle.readUInt32BE(); await handles.get(key).close(); handles.delete(key); sftp.status(id, 0); }));
        sftp.on('end', () => { for (const file of handles.values()) void file.close().catch(() => {}); handles.clear(); });
      });
    }));
  });
  server.on('error', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { root, remoteRoot, localRoot, home: HOME, calls, denied, mapPath,
    config: { host: '127.0.0.1', port: server.address().port, username: 'fixture', password: 'fixture-password', hostKeyFingerprint: fingerprint },
    async close() {
      for (const client of connections) client.end();
      await new Promise(resolve => server.close(resolve));
      if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('rdesktop-upload-test-')) throw new Error('Unsafe fixture cleanup');
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

module.exports = { createUploadFixture };
