'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createPreview } = require('../lib/preview-server.cjs');

function request(url, options = {}) { return new Promise((resolve, reject) => { const call = http.request(url, options, response => { const chunks = []; response.on('data', data => chunks.push(data)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() })); }); call.on('error', reject); call.end(); }); }
async function fixture(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'remote-preview-test-'));
  const map = value => path.join(directory, value.replace(/^\//, ''));
  await fsp.mkdir(map('/project/site'), { recursive: true }); await fsp.mkdir(map('/project/assets')); await fsp.mkdir(map('/private'));
  await fsp.writeFile(map('/project/site/index.html'), '<script src="../assets/app.js"></script><link rel="stylesheet" href="style.css?v=2"><img src="../assets/icon.svg">');
  await fsp.writeFile(map('/project/site/report.pdf'), Buffer.from('%PDF-1.7\n0123456789\n%%EOF\n'));
  await fsp.writeFile(map('/project/site/style.css'), 'body{color:green}'); await fsp.writeFile(map('/project/assets/app.js'), 'document.body.dataset.loaded="yes"'); await fsp.writeFile(map('/project/assets/icon.svg'), '<svg/>'); await fsp.writeFile(map('/private/secret.txt'), 'outside root');
  const backend = { connected: true, client: {}, desktopService: () => ({ call: async (method, value) => { assert.equal(method, 'realpath'); if (value === '/project/site/escape') return '/private/secret.txt'; await fsp.stat(map(value)); return value; } }), stat: value => fsp.stat(map(value)), sftp: { createReadStream: (value, options) => fs.createReadStream(map(value), options) } };
  t.after(() => fsp.rm(directory, { recursive: true, force: true })); return backend;
}
test('HTML preview serves relative CSS, script and SVG paths inside explicitly selected project root', async t => {
  const backend = await fixture(t), preview = await createPreview(backend, '/project/site/index.html', { root: '/project' }); t.after(() => preview.close());
  const html = await request(preview.url); assert.equal(html.status, 200); assert.match(html.body, /app.js/); assert.match(html.headers['content-security-policy'], /sandbox allow-scripts/); assert.match(html.headers['content-security-policy'], /form-action 'none'/); assert.equal(html.headers['referrer-policy'], 'no-referrer');
  const css = await request(new URL('style.css?v=2', preview.url)); assert.equal(css.status, 200); assert.match(css.headers['content-type'], /text\/css/);
  const js = await request(new URL('../assets/app.js', preview.url)); assert.equal(js.status, 200); assert.match(js.body, /loaded/);
  const image = await request(new URL('../assets/icon.svg', preview.url)); assert.equal(image.headers['content-type'], 'image/svg+xml');
  const head = await request(preview.url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.body, ''); assert.ok(Number(head.headers['content-length']) > 0);
});
test('preview denies symlink escape, methods and requests without capability, and expires with SSH identity', async t => {
  const backend = await fixture(t), preview = await createPreview(backend, '/project/site/index.html'); t.after(() => preview.close());
  assert.equal((await request(new URL('escape', preview.url))).status, 403);
  assert.equal((await request(preview.url, { method: 'POST' })).status, 405);
  assert.equal((await request(new URL('/index.html', preview.url))).status, 404);
  assert.equal((await request(new URL('%00secret', preview.url))).status, 403);
  assert.equal((await request(new URL('../assets/app.js', preview.url))).status, 404);
  backend.client = {}; assert.equal((await request(preview.url)).status, 404);
  await preview.close(); await preview.close();
});
test('preview rejects an HTML file outside the selected root', async t => {
  const backend = await fixture(t); await assert.rejects(createPreview(backend, '/project/site/index.html', { root: '/private' }), /授权/);
});
test('preview serves PDF inline and honors single byte ranges used by Chromium PDF viewer', async t => {
  const backend = await fixture(t), preview = await createPreview(backend, '/project/site/report.pdf'); t.after(() => preview.close());
  const full = await request(preview.url); assert.equal(full.status, 200); assert.match(full.headers['content-type'], /^application\/pdf/); assert.equal(full.headers['content-disposition'], 'inline'); assert.equal(full.headers['accept-ranges'], 'bytes');
  const range = await request(preview.url, { headers: { Range: 'bytes=5-10' } }); assert.equal(range.status, 206); assert.equal(range.headers['content-range'], 'bytes 5-10/26'); assert.equal(range.body, '1.7\n01');
  const suffix = await request(preview.url, { headers: { Range: 'bytes=-5' } }); assert.equal(suffix.status, 206); assert.equal(suffix.body, '%EOF\n');
  assert.equal((await request(preview.url, { headers: { Range: 'bytes=999-' } })).status, 416);
});
