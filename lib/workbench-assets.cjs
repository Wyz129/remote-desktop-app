'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const APP_FILES = new Set(['app/workbench.html', 'app/workbench.js', 'app/workbench.css', 'app/workbench-frame.js']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };

// A read-only, capability-addressed static origin lets Chromium run Monaco in
// an opaque sandbox. file: resources cannot load from an opaque file: frame.
// This server deliberately has no document, SSH, download or execution routes.
async function createWorkbenchAssets() {
  const token = crypto.randomBytes(32).toString('hex'), prefix = `/${token}/`, sockets = new Set();
  let closed = false;
  const server = http.createServer((req, res) => {
    void (async () => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Access-Control-Allow-Origin', 'null');
      if (closed || req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(403).end(); return; }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
      const route = new URL(req.url, 'http://127.0.0.1');
      if (!route.pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
      let relative;
      try { relative = decodeURIComponent(route.pathname.slice(prefix.length)); } catch { res.writeHead(400).end(); return; }
      if (/[\\\x00-\x1f\x7f]/.test(relative) || relative.split('/').some(part => part === '..' || part === '.')) { res.writeHead(403).end(); return; }
      if (!APP_FILES.has(relative) && !relative.startsWith('media/workbench/')) { res.writeHead(404).end(); return; }
      const type = TYPES[path.extname(relative).toLowerCase()];
      if (!type) { res.writeHead(404).end(); return; }
      const file = path.resolve(ROOT, relative);
      if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
      let stats; try { stats = await fs.promises.stat(file); } catch { res.writeHead(404).end(); return; }
      if (!stats.isFile()) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', type); res.setHeader('Content-Length', stats.size);
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
    })().catch(() => { if (!res.headersSent) res.writeHead(500).end(); else res.destroy(); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  return {
    url: `http://127.0.0.1:${server.address().port}${prefix}app/workbench.html`,
    async close() { if (closed) return; closed = true; sockets.forEach(socket => socket.destroy()); await new Promise(resolve => server.close(resolve)); }
  };
}
module.exports = { createWorkbenchAssets };
