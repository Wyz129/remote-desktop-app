'use strict';
const { app, BrowserWindow, dialog } = require('electron');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const moduleRoot = process.env.REMOTE_DESKTOP_BROWSER_MODULE_ROOT || path.resolve(__dirname, '../..');
const { createBrowserManager } = require(path.join(moduleRoot, 'lib/browser-manager.cjs'));
const { SshBackend } = require(path.join(moduleRoot, 'lib/ssh-backend.cjs'));
const { UploadService } = require(path.join(moduleRoot, 'lib/upload-service.cjs'));
const { createSshFixture } = require('./ssh-fixture.cjs');
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
globalThis.browserFixture = { moduleRoot, runtime: process.versions.electron, transfers: [], requests: [], uploaded: [], logs: [], savePath: path.join(app.getPath('userData'), 'result.txt') };
app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    browserFixture.requests.push({ url: request.url, cookie: request.headers.cookie, method: request.method, host: request.headers.host });
    if (request.url === '/download' || request.url === '/post') {
      if (request.headers.cookie !== 'session=fixture') { response.writeHead(403).end('Login required'); return; }
      const chunks = []; request.on('data', data => chunks.push(data)); request.on('end', () => {
        response.setHeader('Content-Disposition', 'attachment; filename="authenticated.txt"'); response.setHeader('Content-Type', 'application/octet-stream'); response.end(`authenticated:${request.method}:${Buffer.concat(chunks)}`);
      }); return;
    }
    if (request.url === '/broken') {
      response.setHeader('Accept-Ranges', 'none'); response.setHeader('Content-Disposition', 'attachment; filename="broken.bin"'); response.setHeader('Content-Length', 1024 * 1024); response.write(Buffer.alloc(1024)); setTimeout(() => response.destroy(), 100); return;
    }
    if (request.url === '/slow') {
      response.setHeader('Content-Disposition', 'attachment; filename="slow.bin"'); response.setHeader('Content-Length', 1024 * 1024); const timer = setInterval(() => response.write(Buffer.alloc(1024)), 15); response.on('close', () => clearInterval(timer)); return;
    }
    response.setHeader('Content-Type', 'text/html'); response.setHeader('Set-Cookie', 'session=fixture; HttpOnly; SameSite=Lax');
    response.end('<!doctype html><html><head><title>Remote fixture</title></head><body><a id="download" href="/download">download</a><form action="/post" method="post"><input name="payload" value="private"><button id="post" type="submit">post</button></form><a id="slow" href="/slow">slow</a><a id="broken" href="/broken">broken</a><button id="blob" onclick="const a=document.createElement(\'a\');a.href=window.URL.createObjectURL(new Blob([\'blob-content\'],{type:\'text/plain\'}));a.download=\'blob.txt\';a.click()">blob</button></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixture = await createSshFixture({ forwardTargets: { 'remote-only.invalid:8765': server.address().port, 'localhost:8765': server.address().port } });
  const backend = new SshBackend(); await backend.connect(fixture.config);
  await fs.mkdir(fixture.mapPath('/srv/downloads'), { recursive: true });
  browserFixture.forwards = fixture.calls.forwards;
  const uploader = new UploadService(backend);
  const parent = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } }); await parent.loadURL('about:blank');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: browserFixture.savePath });
  globalThis.browserManager = createBrowserManager({ getBackend: () => backend, getParent: () => parent, onTransfer: value => browserFixture.transfers.push(value), uploadFile: async options => { const result = await uploader.upload(options.localPath, options.remoteDirectory, { id: options.id, signal: options.signal, onProgress: options.onProgress }); const content = await fs.readFile(fixture.mapPath(result.path), 'utf8'); browserFixture.uploaded.push({ content, directory: options.remoteDirectory }); return result; } });
  globalThis.browserFixtureBackend = backend;
  globalThis.closeBrowserFixture = async () => { await browserManager.disconnect(); await uploader.close(); await backend.disconnect(); await fixture.close(); await new Promise(resolve => server.close(resolve)); };
  if (!process.argv.includes('--smoke-test')) parent.show();
}).catch(error => { console.error(error); app.exit(1); });
