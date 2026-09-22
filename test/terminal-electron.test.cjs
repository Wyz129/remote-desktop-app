'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');
const project = path.resolve(__dirname, '..');

test('RTerminal connects keyboard clipboard IPC to SSH and renders returned Markdown without exposing or writing the system clipboard', { timeout: 90000 }, async t => {
  const fixture = await createSshFixture({ desktop: false }); let application;
  t.after(async () => {
    if (application && application.process().exitCode === null) {
      const timer = setTimeout(() => spawnSync('taskkill', ['/pid', String(application.process().pid), '/T', '/F'], { windowsHide: true }), 5000);
      try { await application.close(); } finally { clearTimeout(timer); }
    }
    await fixture.close();
  });
  const userData = path.join(fixture.root, 'terminal-app'); await fs.mkdir(userData);
  await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ knownHosts: { [`${fixture.config.host}:${fixture.config.port}`]: fixture.fingerprint } }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; const executablePath = process.env.REMOTE_DESKTOP_TEST_EXE;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [project]), '--smoke-test', `--user-data-dir=${userData}`], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // Replace only native clipboard access in this isolated main process. The
  // user's OS clipboard is neither read nor changed by this integration test.
  await application.evaluate(({ clipboard }) => {
    globalThis.clipboardReadCount = 0; globalThis.clipboardWrites = [];
    clipboard.readText = async () => { globalThis.clipboardReadCount++; return 'clipboard via IPC'; };
    clipboard.writeText = async text => { globalThis.clipboardWrites.push(text); };
  });
  await page.locator('#switchAccountButton:not([disabled])').waitFor(); await page.locator('#switchAccountButton').click();
  await page.locator('#sshHost').fill(fixture.config.host); await page.locator('#sshPort').fill(String(fixture.config.port));
  await page.locator('#sshUsername').fill(fixture.config.username); await page.locator('#sshPassword').fill(fixture.config.password);
  await page.locator('#advancedConnectSubmit').click(); await page.locator('#connectionDialog').waitFor({ state: 'hidden' });
  await page.keyboard.press('Control+Alt+t'); await page.locator('.terminal-status').filter({ hasText: '运行中' }).waitFor();
  await page.keyboard.press('Control+v');
  await assertEventually(() => fixture.calls.shell.includes('clipboard via IPC'));
  assert.equal(await application.evaluate(() => globalThis.clipboardReadCount), 1);
  assert.ok(!fixture.calls.shell.some(text => text.includes('\x16')));
  const surface = await page.locator('.xterm-screen').boundingBox();
  await page.mouse.move(surface.x + 2, surface.y + 7); await page.mouse.down(); await page.mouse.move(surface.x + 130, surface.y + 7, { steps: 8 }); await page.mouse.up();
  const count = fixture.calls.shell.length; await page.keyboard.press('Control+c');
  assert.equal(fixture.calls.shell.length, count, 'selected Ctrl+C does not interrupt the SSH process');
  assert.match((await application.evaluate(() => globalThis.clipboardWrites))[0], /fixture/);
  const id = await page.locator('.terminal-window').getAttribute('data-window-id');
  // The fixture echoes exact bytes instead of a kernel PTY's CR/LF handling;
  // send CRLF here to exercise received output independently of paste policy.
  await page.evaluate(id => window.remoteDesktop.send({ type: 'terminalInput', id, data: '\r\n### Returned Markdown\r\n\r\n**Readable** formula:\r\n\\[\r\nE = mc^2\r\n\\]\r\n' }), id);
  await page.locator('.terminal-reader h3').waitFor(); await page.locator('.terminal-reader .katex').waitFor();
  assert.equal(await page.locator('.terminal-reader h3').textContent(), 'Returned Markdown');
  await page.screenshot({ path: path.join(project, 'artifacts', 'terminal-integrated-1.1.13.png') });
  const writesBefore = await application.evaluate(() => globalThis.clipboardWrites.length);
  await page.evaluate(id => window.remoteDesktop.send({ type: 'terminalInput', id, data: '\x1b]52;c;bXVzdC1ub3QtY29weQ==\x07' }), id);
  await page.waitForTimeout(250);
  assert.equal(await application.evaluate(() => globalThis.clipboardWrites.length), writesBefore, 'remote OSC 52 does not write the local clipboard');
  assert.deepEqual(errors, []);
});
async function assertEventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if(predicate()) return; await new Promise(resolve => setTimeout(resolve,50)); }
  assert.ok(predicate(), 'expected SSH terminal input was received');
}
