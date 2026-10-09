'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path').posix;
const { normalizeRemote } = require('./ssh-backend.cjs');
const TYPES = { '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.json':'application/json','.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.txt':'text/plain; charset=utf-8','.wasm':'application/wasm','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.ogg':'audio/ogg' };
const inside = (root, value) => root === '/' || value === root || value.startsWith(root + '/');
async function createPreview(backend, remotePath, options = {}) {
  const connection = backend.client;
  const service = backend.desktopService();
  const target = normalizeRemote(await service.call('realpath', normalizeRemote(remotePath)));
  const root = normalizeRemote(await service.call('realpath', normalizeRemote(options.root || path.dirname(target))));
  if (!inside(root, target)) throw new Error('预览文件不在所授权的项目根目录内。');
  const rootStats = await backend.stat(root);
  if (!rootStats.isDirectory()) throw new Error('预览项目根目录必须是目录。');
  const token = crypto.randomBytes(32).toString('hex'), sockets = new Set(), streams = new Set();
  let closed = false;
  const server = http.createServer((req, res) => {
    void (async () => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      // The parent iframe additionally uses sandbox="allow-scripts". CSP is a
      // second boundary: preview scripts cannot contact the local client network.
      const origin = `http://127.0.0.1:${server.address().port}`;
      res.setHeader('Content-Security-Policy', `default-src ${origin}; script-src ${origin} 'unsafe-inline' 'unsafe-eval'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data: blob:; font-src ${origin} data:; media-src ${origin} blob:; connect-src ${origin}; frame-src 'none'; object-src 'none'; base-uri ${origin}; form-action 'none'; sandbox allow-scripts`);
      res.setHeader('Access-Control-Allow-Origin', 'null');
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end('Only read-only preview is supported'); return; }
      if (closed || !backend.connected || backend.client !== connection) throw new Error('SSH session expired');
      const route = new URL(req.url, 'http://localhost');
      const prefix = `/${token}/`;
      if (!route.pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
      const relative = decodeURIComponent(route.pathname.slice(prefix.length));
      if (/[\x00-\x1f\x7f\\]/.test(relative)) { res.writeHead(403).end(); return; }
      let file = normalizeRemote(path.join(root, relative));
      if (!inside(root, file)) { res.writeHead(403).end('Resource is outside the authorized preview root'); return; }
      file = normalizeRemote(await service.call('realpath', file));
      if (!inside(root, file)) { res.writeHead(403).end('Resource is outside the authorized preview root'); return; }
      if (options.singleFile && file !== target) { res.writeHead(403).end('Only the selected file is authorized'); return; }
      const stats = await backend.stat(file);
      if (!stats.isFile()) { res.writeHead(404).end('Not a regular file'); return; }
      if (stats.size > 64 * 1024 * 1024) { res.writeHead(413).end('Preview resource exceeds 64 MiB'); return; }
      const size = Number(stats.size) || 0;
      let start = 0, end = Math.max(0, size - 1), status = 200;
      const range = req.headers.range;
      if (range) {
        // The PDF viewer uses single byte ranges while loading a document. Do
        // not implement multipart ranges: rejecting those keeps the endpoint
        // deterministic and avoids exposing more data than requested.
        const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        if (!match || (!match[1] && !match[2]) || (match[1] && Number(match[1]) >= size)) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return;
        }
        if (match[1]) { start = Number(match[1]); if (match[2]) end = Number(match[2]); else end = size - 1; }
        else { start = Math.max(0, size - Number(match[2])); end = size - 1; }
        end = Math.min(end, size - 1);
        if (start > end || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
        status = 206;
      }
      const length = size ? end - start + 1 : 0;
      res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', length);
      if (status === 206) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      if (path.extname(file).toLowerCase() === '.pdf') {
        res.setHeader('Content-Disposition', 'inline');
        // Chromium owns the PDF viewer sandbox. An HTML sandbox response
        // directive disables its embedded viewer, so restrict data sources
        // without applying the HTML-only sandbox to PDF responses.
        res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      }
      if (req.method === 'HEAD') { res.writeHead(status).end(); return; }
      const stream = backend.sftp.createReadStream(file, { start, end }); streams.add(stream);
      res.statusCode = status;
      stream.on('close', () => streams.delete(stream));
      stream.on('error', () => { if (!res.headersSent) { res.removeHeader('Content-Length'); res.writeHead(403); res.end('Resource could not be read'); } else res.destroy(); });
      res.on('close', () => stream.destroy()); stream.pipe(res);
    })().catch(error => { if (!res.headersSent) { res.removeHeader('Content-Length'); res.writeHead([3,'EACCES'].includes(error.code) ? 403 : 404); res.end('Preview resource unavailable'); } else res.destroy(); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/${token}/${path.relative(root, target).split('/').map(encodeURIComponent).join('/')}`;
  const prefix = `http://127.0.0.1:${server.address().port}/${token}/`;
  const close = async () => { if (closed) return; closed = true; for(const stream of streams) stream.destroy(); for(const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); };
  return { url, root, prefix, close, dispose: close };
}
module.exports = { createPreview };
