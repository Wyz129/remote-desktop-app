'use strict';

const http = require('node:http');

const DEFAULTS = Object.freeze({ timeout: 15000, maxHtmlBytes: 1024 * 1024, maxAssetBytes: 8 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, maxAssets: 128 });
const MIME_TYPES = Object.freeze({
  html: new Set(['text/html', 'application/xhtml+xml']),
  script: new Set(['text/javascript', 'application/javascript', 'application/x-javascript', 'text/ecmascript', 'application/ecmascript']),
  stylesheet: new Set(['text/css']),
});

function attribute(tag, name) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  if (!match) return null;
  return (match[1] ?? match[2] ?? match[3]).replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, entity => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '\ufffd';
  });
}

function resources(html, base, limit) {
  const result = new Map();
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const baseTag = clean.match(/<base\b[^>]*>/i);
  const baseHref = baseTag && attribute(baseTag[0], 'href');
  if (baseHref !== null && baseHref !== undefined) {
    const documentBase = new URL(baseHref, base);
    if (documentBase.origin !== base.origin || documentBase.username || documentBase.password) throw new Error('Xpra HTML5 引用了转发地址以外的资源，无法验证交互桌面。');
    base = documentBase;
  }
  for (const match of clean.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = match[0], script = match[1].toLowerCase() === 'script';
    if (!script && !String(attribute(tag, 'rel') || '').toLowerCase().split(/\s+/).includes('stylesheet')) continue;
    const source = attribute(tag, script ? 'src' : 'href');
    if (source === null) continue;
    let url;
    try { url = new URL(source, base); } catch { throw new Error('Xpra HTML5 含有无效的资源路径。'); }
    if (url.origin !== base.origin || url.protocol !== 'http:' || url.username || url.password) throw new Error('Xpra HTML5 引用了转发地址以外的资源，无法验证交互桌面。');
    url.hash = '';
    const type = script ? 'script' : 'stylesheet';
    result.set(`${type}:${url.href}`, { url, type });
    if (result.size > limit) throw new Error('Xpra HTML5 资源数量超出检查限制。');
  }
  if (![...result.values()].some(resource => resource.type === 'script')) throw new Error('Xpra HTML5 没有可加载的脚本，无法启用交互桌面。');
  return [...result.values()];
}

function read(url, type, limit, context) {
  return new Promise((resolve, reject) => {
    const label = url.pathname, remaining = context.deadline - Date.now();
    if (remaining <= 0) return reject(new Error('Xpra HTML5 资源检查超时。'));
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.requests.delete(request);
      if (error) { request.destroy(); reject(error); } else resolve(value);
    };
    const request = http.get(url, { headers: { Accept: '*/*', 'Accept-Encoding': 'identity' }, agent: false }, response => {
      if (response.statusCode !== 200) return finish(new Error(`Xpra HTML5 资源 ${label} 返回 HTTP ${response.statusCode}，无法启用交互桌面。`));
      const mime = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!MIME_TYPES[type].has(mime)) return finish(new Error(`Xpra HTML5 资源 ${label} 类型不正确（${mime || '未提供'}）。`));
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        context.total += chunk.length;
        if (bytes > limit || context.total > context.maxTotalBytes) return finish(new Error(`Xpra HTML5 资源 ${label} 超出检查大小限制。`));
        if (type === 'html') chunks.push(chunk);
      });
      response.on('end', () => {
        if (!bytes) return finish(new Error(`Xpra HTML5 资源 ${label} 为空。`));
        finish(null, { bytes, text: type === 'html' ? Buffer.concat(chunks).toString('utf8') : undefined });
      });
      response.on('aborted', () => finish(new Error(`Xpra HTML5 资源 ${label} 传输中断。`)));
      response.on('error', error => finish(new Error(`Xpra HTML5 资源 ${label} 读取失败：${error.message}`)));
    });
    context.requests.add(request);
    request.on('error', error => finish(new Error(`Xpra HTML5 资源 ${label} 无法读取：${error.message}`)));
    const timer = setTimeout(() => finish(new Error('Xpra HTML5 资源检查超时。')), remaining);
    timer.unref?.();
  });
}

async function validateX11Html(address, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const base = new URL(address);
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname) || base.username || base.password) throw new Error('X11 HTML5 检查只能使用本机回环转发地址。');
  const context = { deadline: Date.now() + settings.timeout, total: 0, maxTotalBytes: settings.maxTotalBytes, requests: new Set() };
  try {
    const document = await read(base, 'html', settings.maxHtmlBytes, context);
    const pending = resources(document.text, base, settings.maxAssets), checked = [];
    async function worker() {
      while (pending.length) {
        const resource = pending.shift();
        const result = await read(resource.url, resource.type, settings.maxAssetBytes, context);
        checked.push({ path: resource.url.pathname, type: resource.type, bytes: result.bytes });
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
    return { url: base.href, resources: checked, bytes: context.total };
  } finally {
    for (const request of context.requests) request.destroy();
  }
}

module.exports = { validateX11Html };
