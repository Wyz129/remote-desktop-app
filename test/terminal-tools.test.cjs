'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { clipboardText } = require('../lib/terminal-clipboard.cjs');
const root = path.resolve(__dirname, '..');
let browser, server, origin;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/') {
      const template = fs.readFileSync(path.join(root, 'app/index.html'), 'utf8').match(/<template id="terminalTemplate">([\s\S]*?)<\/template>/)[1];
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><html><head>${['media/xterm.css','app/desktop.css','media/workbench/katex.css','app/terminal-tools.css'].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}<style>body{margin:0;background:#221e27}.terminal-window{position:static;width:1160px;height:750px;margin:20px;display:flex;flex-direction:column}</style></head><body>${template}${['media/xterm.js','media/xterm-addon-fit.js','media/workbench/purify.js','media/workbench/marked.js','media/workbench/katex.js','app/terminal-tools.js'].map(file => `<script src="/${file}"></script>`).join('')}</body></html>`);
    }
    const file = req.url.split('?')[0];
    if (!/^\/(app|media)\/[\w./-]+$/.test(file) || file.includes('..')) return res.writeHead(404).end();
    const target = path.join(root, file);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return res.writeHead(404).end();
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'application/javascript'); res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });
async function scenario(t) {
  const page = await browser.newPage({ viewport: { width: 1240, height: 800 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(6000);
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.goto(origin);
  await page.evaluate(() => {
    window.input = []; window.copied = []; window.reads = 0; window.clipboard = 'local clipboard'; window.active = true; window.failures = [];
    window.term = new Terminal({ fontFamily: 'Consolas, monospace', fontSize: 15, scrollback: 1500 });
    window.fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(document.querySelector('.terminal-surface')); fit.fit(); term.focus();
    window.tools = RemoteTerminalTools.attach({ terminal: term, element: document.querySelector('.terminal-window'), api: {
      async readTerminalClipboard() { window.reads++; if(window.deferRead) return new Promise(resolve => window.finishRead = resolve); return window.clipboard; },
      async writeTerminalClipboard(text) { window.copied.push(text); }
    }, onResize: () => fit.fit(), onError: error => window.failures.push(error), isActive: () => window.active });
    term.onData(data => window.input.push(data));
    window.write = text => new Promise(resolve => term.write(text, resolve));
  });
  return page;
}

test('clipboard bridge accepts only bounded UTF-8 text', () => {
  assert.equal(clipboardText('中文\nhello'), '中文\nhello');
  assert.equal(clipboardText('x'.repeat(60000)).length, 60000);
  assert.throws(() => clipboardText('中'.repeat(20001)), /60 KB/);
  assert.throws(() => clipboardText({ text: 'invalid' }), /必须为文本/);
});

test('Ctrl V and Shift Insert use local clipboard and xterm bracketed paste; selection Ctrl C copies without SIGINT', async t => {
  const page = await scenario(t);
  await page.evaluate(() => write('select me\r\n\x1b[?2004h'));
  await page.keyboard.press('Control+v');
  await page.waitForFunction(() => input.length > 0);
  assert.deepEqual(await page.evaluate(() => input), ['\x1b[200~local clipboard\x1b[201~']);
  await page.evaluate(() => { input.length = 0; window.clipboard = 'two\nlines'; });
  await page.keyboard.press('Shift+Insert');
  await page.waitForFunction(() => input.length > 0);
  assert.deepEqual(await page.evaluate(() => input), ['\x1b[200~two\rlines\x1b[201~']);
  await page.evaluate(() => { input.length = 0; term.select(0,0,9); });
  await page.keyboard.press('Control+c');
  assert.deepEqual(await page.evaluate(() => copied), ['select me']); assert.deepEqual(await page.evaluate(() => input), []);
  await page.evaluate(() => term.clearSelection()); await page.keyboard.press('Control+c');
  assert.deepEqual(await page.evaluate(() => input), ['\x03']);
});

test('drag selection remains local with remote mouse reporting while Ctrl mouse is explicitly forwarded', async t => {
  const page = await scenario(t);
  await page.evaluate(() => write('mouse selection text\r\n\x1b[?1000h\x1b[?1002h\x1b[?1006h'));
  const screen = await page.locator('.xterm-screen').boundingBox();
  await page.mouse.move(screen.x + 2, screen.y + 8); await page.mouse.down(); await page.mouse.move(screen.x + 145, screen.y + 8, { steps: 8 }); await page.mouse.up();
  assert.match(await page.evaluate(() => term.getSelection()), /mouse selection/);
  assert.deepEqual(await page.evaluate(() => input), [], 'selecting does not send control bytes or mouse reports');
  await page.keyboard.press('Control+c'); assert.match(await page.evaluate(() => copied[0]), /mouse selection/);
  await page.keyboard.down('Control'); await page.mouse.click(screen.x + 25, screen.y + 10); await page.keyboard.up('Control');
  assert.ok((await page.evaluate(() => input)).some(value => value.startsWith('\x1b[<')), 'explicit Ctrl click preserves remote mouse mode');
});

test('Markdown and LaTeX automatically appear in a reading pane without changing terminal bytes', async t => {
  const page = await scenario(t);
  await page.evaluate(() => write('### 1. 输入表示\r\n\r\n输入文本先被分成 **Token**。\r\n\r\n\\[\r\nX = E_{\\text{token}} + E_{\\text{position}}\r\n\\]\r\n\r\n### 2. 自注意力机制\r\n\r\n[\r\n\\operatorname{Attention}(Q,K,V) = \\operatorname{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V\r\n]\r\n\r\n行内公式 $x^2$ 与 \\(y^2\\)。\r\n'));
  await page.locator('.terminal-reader:not([hidden])').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.terminal-reader .katex').length === 4);
  assert.equal(await page.locator('.terminal-reader h3').count(), 2); assert.equal(await page.locator('.terminal-reader strong').textContent(), 'Token');
  assert.deepEqual(await page.evaluate(() => input), []);
  await page.screenshot({ path: path.join(root,'artifacts','terminal-reading-1.1.13.png') });
});

test('alternate TUI screen does not auto-open reading; manual reading is available and sanitized without executing or loading remote HTML', async t => {
  const page = await scenario(t);
  await page.evaluate(() => write('\x1b[?1049h### TUI heading\r\n\\[x^2\\]\r\n'));
  await page.waitForTimeout(300); assert.equal(await page.locator('.terminal-reader').isVisible(), false);
  await page.locator('[data-terminal-reading]').click(); await page.locator('.terminal-reader:not([hidden])').waitFor();
  assert.match(await page.locator('.terminal-reader-mode').textContent(), /TUI 屏幕/);
  const requests = []; page.on('request', request => { if(!request.url().startsWith(origin)) requests.push(request.url()); });
  await page.evaluate(() => RemoteTerminalTools.renderMarkdown(document.querySelector('.terminal-reader-content'), '# safe\n<img src="https://example.invalid/pixel" onerror="window.pwned=true">\n\n<script>window.pwned=true</script>\n\n[bad](javascript:alert(1))\n\n$$\\href{javascript:alert(1)}{bad}$$\n\n```python\nprint("$x^2$")\n```\n`\\(code\\)`'));
  assert.equal(await page.locator('.terminal-reader img, .terminal-reader script, .terminal-reader a[href]').count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.pwned)), false); assert.deepEqual(requests, []);
  assert.match(await page.locator('.terminal-reader pre').textContent(), /\$x\^2\$/);
  assert.equal(await page.locator('.terminal-reader pre .katex, .terminal-reader code .katex').count(), 0);
});

test('reading selection freezes a snapshot; closing suppresses auto-reopen and pending clipboard never reaches a closed terminal', async t => {
  const page = await scenario(t);
  await page.evaluate(() => write('**first**\r\n')); await page.locator('.terminal-reader:not([hidden])').waitFor();
  await page.evaluate(() => term.select(0,0,9)); await page.locator('[data-terminal-selection]').click();
  await page.evaluate(() => write('second\r\n')); await page.waitForTimeout(250);
  assert.equal(await page.locator('.terminal-reader-content').textContent(), 'first\n');
  await page.locator('[data-terminal-live]').click(); assert.match(await page.locator('.terminal-reader-content').textContent(), /second/);
  await page.locator('[data-terminal-reader-close]').click(); await page.evaluate(() => write('### next\r\n')); await page.waitForTimeout(250);
  assert.equal(await page.locator('.terminal-reader').isVisible(), false);
  await page.evaluate(() => { term.clearSelection(); term.focus(); window.deferRead = true; }); await page.keyboard.press('Control+v');
  await page.waitForFunction(() => Boolean(window.finishRead));
  await page.evaluate(() => { tools.dispose(); window.active = false; window.finishRead('must not send'); });
  assert.deepEqual(await page.evaluate(() => input), []);
});
