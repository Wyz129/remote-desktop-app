'use strict';

// A real loopback SSH/SFTP endpoint. It exposes only this fixture's temporary
// tree, accepts one generated test identity, and never executes arbitrary text.
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { Server, utils } = require('ssh2');

const HOME = '/srv/fixture-user';
const STATUS = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, OP_UNSUPPORTED: 8 };
let hostKey;

function attrs(stats) {
  return { mode: stats.mode, uid: stats.uid, gid: stats.gid, size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000), mtime: Math.floor(stats.mtimeMs / 1000) };
}

function unquote(value) {
  if (!value.startsWith("'") || !value.endsWith("'")) throw new Error('Expected quoted fixture path');
  return value.slice(1, -1).replaceAll("'\\''", "'").replaceAll("'\"'\"'", "'");
}

async function createSshFixture(options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'remote-desktop-ssh-test-'));
  const serverRoot = path.join(root, 'server');
  const downloads = path.join(root, 'downloads');
  const outsideRoot = path.join(root, 'outside');
  await fsp.mkdir(serverRoot); await fsp.mkdir(downloads); await fsp.mkdir(outsideRoot);
  const calls = { exec: [], auth: [], sftp: [], shell: [], pty: [], resize: [], errors: [] };
  const connections = new Set();
  const username = 'fixture-user';
  const password = crypto.randomBytes(20).toString('hex');
  const failReads = new Set();
  const slowReads = new Set();
  const failRenames = new Set();
  // POSIX symlinks are modeled by the endpoint rather than requiring Windows
  // SeCreateSymbolicLinkPrivilege. All data still stays in the isolated tree.
  const links = new Map();
  const canonical = (remote, followFinal = true, depth = 0) => {
    if (typeof remote !== 'string' || remote.includes('\0')) throw new Error('Invalid fixture path');
    const normal = path.posix.normalize(remote);
    if (depth > 40) throw new Error('Fixture symlink loop');
    const segments = normal.split('/').filter(Boolean);
    for (let index = 0; index < segments.length; index++) {
      if (!followFinal && index === segments.length - 1) break;
      const prefix = '/' + segments.slice(0, index + 1).join('/');
      if (links.has(prefix)) {
        const target = path.posix.resolve(path.posix.dirname(prefix), links.get(prefix));
        return canonical(path.posix.join(target, ...segments.slice(index + 1)), true, depth + 1);
      }
    }
    return normal;
  };
  const mapPath = (remote, followFinal = true) => {
    const normal = canonical(remote, followFinal);
    const base = normal === HOME || normal.startsWith(`${HOME}/`) ? HOME : normal === '/outside' || normal.startsWith('/outside/') ? '/outside' : null;
    if (!base) throw Object.assign(new Error('Outside fixture root'), { code: 'EACCES' });
    return path.join(base === HOME ? serverRoot : outsideRoot, ...normal.slice(base.length).split('/').filter(Boolean));
  };
  const remoteStat = async (remote, follow = true) => {
    const resolved = canonical(remote, follow);
    if (!follow && links.has(resolved)) return { mode: 0o120777, uid: 0, gid: 0, size: Buffer.byteLength(links.get(resolved)), atimeMs: Date.now(), mtimeMs: Date.now() };
    return fsp.stat(mapPath(resolved));
  };
  const link = (remote, target) => { mapPath(remote, false); links.set(path.posix.normalize(remote), target); };
  const put = async (relative, content) => {
    const target = mapPath(`${HOME}/${relative}`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
    return `${HOME}/${relative}`;
  };
  if (options.desktop !== false) await fsp.mkdir(mapPath(`${HOME}/${options.desktop || 'Desktop'}`), { recursive: true });
  if (!hostKey) hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const parsed = utils.parseKey(hostKey);
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;

  function serveSftp(sftp) {
    // ssh2 1.17's server hardcodes an extension-free VERSION response. Extend
    // that one wire packet in this test endpoint so ext_openssh_rename travels
    // across the real encrypted channel instead of stubbing the client method.
    const protocol = sftp._protocol; const originalChannelData = protocol.channelData;
    protocol.channelData = function(channel, data) {
      if (channel === sftp.outgoing.id && data.length === 9 && data[4] === 2 && data.readUInt32BE(5) === 3) {
        const text = value => { const bytes = Buffer.from(value); const out = Buffer.alloc(4 + bytes.length); out.writeUInt32BE(bytes.length); bytes.copy(out, 4); return out; };
        const extension = Buffer.concat([text('posix-rename@openssh.com'), text('1')]);
        data = Buffer.concat([data, extension]); data.writeUInt32BE(data.length - 4);
      }
      return originalChannelData.call(this, channel, data);
    };
    const handles = new Map(); let nextHandle = 1;
    const replyError = (id, error) => sftp.status(id, error.code === 'ENOENT' ? STATUS.NO_SUCH_FILE : error.code === 'EACCES' ? STATUS.PERMISSION_DENIED : STATUS.FAILURE, error.message);
    const run = (id, work) => Promise.resolve().then(work).catch(error => replyError(id, error));
    const allocate = (record) => { const handle = Buffer.alloc(4); handle.writeUInt32BE(nextHandle++); handles.set(handle.toString('hex'), record); return handle; };
    const get = (handle) => { const value = handles.get(handle.toString('hex')); if (!value) throw new Error('Invalid handle'); return value; };
    for (const event of ['STAT', 'LSTAT']) sftp.on(event, (id, remote) => run(id, async () => {
      calls.sftp.push([event, remote]); const stat = await remoteStat(remote, event !== 'LSTAT'); sftp.attrs(id, attrs(stat));
    }));
    sftp.on('FSTAT', (id, handle) => run(id, async () => sftp.attrs(id, attrs(await get(handle).file.stat()))));
    sftp.on('REALPATH', (id, remote) => run(id, async () => {
      calls.sftp.push(['REALPATH', remote]); const resolved = canonical(remote === '.' ? HOME : remote); const stat = await remoteStat(resolved);
      sftp.name(id, [{ filename: resolved, longname: resolved, attrs: attrs(stat) }]);
    }));
    sftp.on('OPENDIR', (id, remote) => run(id, async () => {
      calls.sftp.push(['OPENDIR', remote]); const entries = await fsp.readdir(mapPath(remote));
      for (const linkPath of links.keys()) if (path.posix.dirname(linkPath) === canonical(remote) && !entries.includes(path.posix.basename(linkPath))) entries.push(path.posix.basename(linkPath));
      sftp.handle(id, allocate({ remote, entries, position: 0 }));
    }));
    sftp.on('READDIR', (id, handle) => run(id, async () => {
      const record = get(handle);
      if (record.position >= record.entries.length) { sftp.status(id, STATUS.EOF); return; }
      const names = record.entries.slice(record.position, record.position += 16);
      const entries = await Promise.all(names.map(async filename => ({ filename, longname: filename, attrs: attrs(await remoteStat(path.posix.join(record.remote, filename), false)) })));
      sftp.name(id, entries);
    }));
    sftp.on('OPEN', (id, remote, flags) => run(id, async () => {
      calls.sftp.push(['OPEN', remote, flags]);
      if (flags & 32 && links.has(canonical(remote, false))) throw Object.assign(new Error('File exists'), { code: 'EEXIST' });
      const writable = Boolean(flags & 2); const mode = writable ? (flags & 32 ? 'wx+' : flags & 16 ? 'w+' : 'r+') : 'r';
      const file = await fsp.open(mapPath(remote), mode);
      sftp.handle(id, allocate({ remote, file }));
    }));
    sftp.on('READ', (id, handle, offset, length) => run(id, async () => {
      const record = get(handle); calls.sftp.push(['READ', record.remote, offset, length]);
      if (failReads.has(record.remote)) { sftp.status(id, STATUS.FAILURE, 'Injected fixture read failure'); return; }
      if (slowReads.has(record.remote)) await new Promise(resolve => setTimeout(resolve, 35));
      const buffer = Buffer.alloc(Math.min(length, 32768));
      const { bytesRead } = await record.file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) sftp.status(id, STATUS.EOF); else sftp.data(id, buffer.subarray(0, bytesRead));
    }));
    sftp.on('WRITE', (id, handle, offset, data) => run(id, async () => {
      await get(handle).file.write(data, 0, data.length, offset); sftp.status(id, STATUS.OK);
    }));
    sftp.on('CLOSE', (id, handle) => run(id, async () => {
      const record = get(handle); handles.delete(handle.toString('hex')); await record.file?.close(); sftp.status(id, STATUS.OK);
    }));
    sftp.on('MKDIR', (id, remote) => run(id, async () => { calls.sftp.push(['MKDIR', remote]); await fsp.mkdir(mapPath(remote)); sftp.status(id, STATUS.OK); }));
    sftp.on('REMOVE', (id, remote) => run(id, async () => { calls.sftp.push(['REMOVE', remote]); if (!links.delete(canonical(remote, false))) await fsp.unlink(mapPath(remote)); sftp.status(id, STATUS.OK); }));
    sftp.on('RMDIR', (id, remote) => run(id, async () => { await fsp.rmdir(mapPath(remote)); sftp.status(id, STATUS.OK); }));
    const rename = async (source, target, overwrite) => {
      if (failRenames.has(target)) throw new Error('Injected rename failure');
      if (!overwrite) { try { await remoteStat(target, false); throw Object.assign(new Error('File exists'), { code: 'EEXIST' }); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      const from = canonical(source, false), to = canonical(target, false);
      if (links.has(from)) { links.set(to, links.get(from)); links.delete(from); }
      else { await fsp.rename(mapPath(from), mapPath(to)); for (const [linkPath, value] of [...links]) if (linkPath.startsWith(`${from}/`)) { links.delete(linkPath); links.set(`${to}${linkPath.slice(from.length)}`, value); } }
    };
    sftp.on('RENAME', (id, source, target) => run(id, async () => { calls.sftp.push(['RENAME', source, target]); await rename(source, target, false); sftp.status(id, STATUS.OK); }));
    sftp.on('EXTENDED', (id, name, data) => run(id, async () => {
      if (name !== 'posix-rename@openssh.com') { sftp.status(id, STATUS.OP_UNSUPPORTED); return; }
      let offset = 0;
      const readString = () => { const size = data.readUInt32BE(offset); offset += 4; const value = data.subarray(offset, offset + size).toString(); offset += size; return value; };
      const source = readString(), target = readString(); calls.sftp.push(['POSIX_RENAME', source, target]);
      await rename(source, target, true); sftp.status(id, STATUS.OK);
    }));
    sftp.on('SETSTAT', (id) => sftp.status(id, STATUS.OK));
    sftp.on('FSETSTAT', (id) => sftp.status(id, STATUS.OK));
    sftp.on('READLINK', (id, remote) => run(id, async () => { const target = links.get(canonical(remote, false)); if (target === undefined) throw new Error('Not a symlink'); sftp.name(id, [{ filename: target, longname: target, attrs: {} }]); }));
    sftp.on('SYMLINK', (id, remote, target) => run(id, async () => {
      calls.sftp.push(['SYMLINK', target, remote]);
      try { await remoteStat(remote, false); throw Object.assign(new Error('File exists'), { code: 'EEXIST' }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      link(remote, target); sftp.status(id, STATUS.OK);
    }));
    sftp.on('end', () => { for (const record of handles.values()) void record.file?.close().catch(() => {}); handles.clear(); });
    sftp.on('error', error => calls.errors.push(error.message));
  }

  const server = new Server({ hostKeys: [hostKey] }, client => {
    connections.add(client); client.on('close', () => connections.delete(client)); client.on('error', error => calls.errors.push(error.message));
    client.on('authentication', context => {
      calls.auth.push({ method: context.method, username: context.username });
      if (context.method === 'password' && context.username === username && context.password === password) context.accept();
      else context.reject(['password']);
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); session.on('error', () => {});
      session.on('pty', (acceptPty, _reject, info) => { calls.pty.push(info); acceptPty?.(); });
      session.on('window-change', (acceptResize, _reject, info) => { calls.resize.push(info); acceptResize?.(); });
      const serveShell = stream => {
        stream.on('error', () => {});
        stream.write('fixture-shell-ready\r\n');
        stream.on('data', chunk => { const data = chunk.toString('utf8'); calls.shell.push(data); stream.write(`fixture-echo:${data}`); });
        stream.on('end', () => { stream.exit(0); stream.end(); });
      };
      session.on('shell', acceptShell => serveShell(acceptShell()));
      session.on('sftp', acceptSftp => serveSftp(acceptSftp()));
      session.on('exec', (acceptExec, _reject, info) => {
        calls.exec.push(info.command); const stream = acceptExec(); stream.on('error', () => {});
        void (async () => {
          if (info.command.startsWith('cd -- ') && / && exec (?:"\$\{SHELL:-\/bin\/sh\}" -l|vim(?: -- .*)?|htop)$/.test(info.command)) { serveShell(stream); return; }
          if (info.command.includes('$HOME') && info.command.startsWith('printf')) { stream.write(options.homeOutput === undefined ? HOME : options.homeOutput); stream.exit(0); stream.end(); return; }
          if (info.command === 'id -un; hostname; date -u +%s') { stream.write(`${username}\nfixture-host\n${Math.floor(Date.now() / 1000)}\n`); stream.exit(0); stream.end(); return; }
          if (info.command.startsWith('cat -- ')) {
            const remote = unquote(info.command.slice(7));
            if (failReads.has(remote)) throw new Error('Injected fixture read failure');
            const input = fs.createReadStream(mapPath(remote), { highWaterMark: 8192 });
            stream.on('close', () => input.destroy());
            for await (const chunk of input) {
              if (stream.destroyed) return;
              if (slowReads.has(remote)) await new Promise(resolve => setTimeout(resolve, 35));
              if (!stream.write(chunk)) await once(stream, 'drain');
            }
            stream.exit(0); stream.end(); return;
          }
          throw new Error('Unsupported fixture command');
        })().catch(error => { if (!stream.destroyed) { stream.stderr.write(error.message); stream.exit(1); stream.end(); } });
      });
    }));
  });
  server.on('error', () => {});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });

  return {
    root, serverRoot, outsideRoot, downloads, home: HOME, username, password, fingerprint, calls, failReads, slowReads, failRenames, mapPath, put, link, links,
    config: { host: '127.0.0.1', port: server.address().port, username, password, hostKeyFingerprint: fingerprint },
    async close() {
      for (const client of connections) client.end();
      await new Promise(resolve => server.close(resolve));
      const resolved = path.resolve(root); const temp = path.resolve(os.tmpdir());
      if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('remote-desktop-ssh-test-')) throw new Error('Unsafe fixture cleanup target');
      await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

module.exports = { createSshFixture };
