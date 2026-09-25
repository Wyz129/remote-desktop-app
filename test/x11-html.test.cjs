'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { validateX11Html } = require('../lib/x11-html.cjs');

async function fixture(t, routes) {
  const requested = [];
  const server = http.createServer((request, response) => {
    requested.push(request.url);
    const route = routes[request.url];
    if (!route) return response.writeHead(404).end('missing');
    response.writeHead(route.status || 200, { 'Content-Type': route.type, ...route.headers });
    response.end(route.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/`, requested };
}

test('root HTTP 200 is insufficient when the jquery script is missing', async t => {
  const { url } = await fixture(t, { '/': { type: 'text/html', body: '<html><script src="js/lib/jquery.js"></script></html>' } });
  await assert.rejects(validateX11Html(url), /jquery\.js.*HTTP 404/);
});

test('validates every same-origin script and stylesheet including entity encoded queries', async t => {
  const { url, requested } = await fixture(t, {
    '/': { type: 'text/html; charset=utf-8', body: '<!-- <script src="ignored.js"></script> --><script src="js/Client.js?v=1&amp;b=2"></script><link rel="stylesheet alternate" href="css/client.css"><link rel="icon" href="ignored.ico">' },
    '/js/Client.js?v=1&b=2': { type: 'application/javascript', body: 'window.client = true;' },
    '/css/client.css': { type: 'text/css', body: 'body { color: white; }' },
  });
  const result = await validateX11Html(url);
  assert.equal(result.resources.length, 2);
  assert.ok(result.resources.every(resource => resource.bytes > 0));
  assert.deepEqual(requested.sort(), ['/', '/css/client.css', '/js/Client.js?v=1&b=2']);
});

test('rejects nonlocal resources without making an outbound request', async t => {
  const routes = { '/': { type: 'text/html', body: '<script src="https://example.invalid/jquery.js"></script>' } };
  const { url, requested } = await fixture(t, routes);
  await assert.rejects(validateX11Html(url), /转发地址以外/);
  assert.deepEqual(requested, ['/']);
  routes['/'].body = '<base href="https://example.invalid/"><script src="jquery.js"></script>';
  await assert.rejects(validateX11Html(url), /转发地址以外/);
  assert.deepEqual(requested, ['/', '/']);
  await assert.rejects(validateX11Html('http://example.invalid/'), /本机回环/);
});

test('rejects an HTML error page served as a JavaScript asset and empty CSS', async t => {
  const routes = {
    '/': { type: 'text/html', body: '<script src="client.js"></script><link rel="stylesheet" href="client.css">' },
    '/client.js': { type: 'text/html', body: '<html>not found</html>' },
    '/client.css': { type: 'text/css', body: 'body{}' },
  };
  const { url } = await fixture(t, routes);
  await assert.rejects(validateX11Html(url), /client\.js.*类型不正确/);
  routes['/client.js'] = { type: 'text/javascript', body: 'void 0;' };
  routes['/client.css'].body = '';
  await assert.rejects(validateX11Html(url), /client\.css.*为空/);
});

test('limits asset size and refuses redirects', async t => {
  const routes = {
    '/': { type: 'text/html', body: '<script src="client.js"></script>' },
    '/client.js': { type: 'text/javascript', body: 'x'.repeat(200) },
  };
  const { url, requested } = await fixture(t, routes);
  await assert.rejects(validateX11Html(url, { maxAssetBytes: 100 }), /大小限制/);
  routes['/client.js'] = { type: 'text/javascript', status: 302, headers: { Location: 'https://example.invalid/client.js' }, body: 'redirect' };
  await assert.rejects(validateX11Html(url), /HTTP 302/);
  assert.deepEqual(requested, ['/', '/client.js', '/', '/client.js']);
});
