'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');
const project = path.resolve(__dirname, '..');

test('desktop Video.js opens through the remote picker and double-click, plays, seeks and revokes closed media', { timeout: 90000 }, async t => {
  const fixture = await createSshFixture({ desktop: false }); let application;
  t.after(async () => {
    if (application && application.process().exitCode === null) {
      const timer = setTimeout(() => {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(application.process().pid), '/T', '/F'], { windowsHide: true });
        else application.process().kill('SIGKILL');
      }, 5000);
      try { await application.close(); } finally { clearTimeout(timer); }
    }
    await fixture.close();
  });
  const userData = path.join(fixture.root, 'video-app'); await fs.mkdir(userData);
  await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ host: fixture.config.host, port: fixture.config.port, username: fixture.username, knownHosts: { [`${fixture.config.host}:${fixture.config.port}`]: fixture.fingerprint } }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.REMOTE_DESKTOP_TEST_EXE;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [project]), '--smoke-test', `--user-data-dir=${userData}`], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('#sshPassword').fill(fixture.password); await page.locator('#connectSubmit').click();
  await page.locator('#connectionDialog').waitFor({ state: 'hidden' });
  const recording = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const context = canvas.getContext('2d'); let frame = 0;
    const draw = () => { context.fillStyle = frame++ % 2 ? '#286fba' : '#b15a40'; context.fillRect(0, 0, 160, 90); context.fillStyle = '#fff'; context.font = '18px sans-serif'; context.fillText('SSH video ' + frame, 10, 50); }; draw();
    const stream = canvas.captureStream(12), chunks = [], recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    recorder.ondataavailable = event => chunks.push(event.data);
    const finished = new Promise(resolve => { recorder.onstop = resolve; }); recorder.start();
    const timer = setInterval(draw, 80); await new Promise(resolve => setTimeout(resolve, 2600)); recorder.stop(); await finished;
    clearInterval(timer); stream.getTracks().forEach(track => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  const remote = await fixture.put('.rdesktop/desktop/sample.webm', Buffer.from(recording));
  await page.locator('#applicationsButton').click(); await page.locator('[data-application=video]').click();
  await page.locator('.video-window').getByRole('button', { name: '打开视频…' }).click();
  await page.locator('.server-picker-window .window-picker-path').fill(remote);
  await page.locator('.server-picker-window [data-window-action=pick]').click();
  await page.waitForFunction(() => document.querySelector('.video-window video')?.videoWidth === 160);
  await page.locator('.vjs-big-play-button').click();
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.3);
  await page.waitForFunction(() => document.querySelector('video').ended);
  await page.locator('video').evaluate(video => { video.currentTime = 0.8; });
  await page.waitForFunction(() => { const video = document.querySelector('video'); return !video.seeking && Math.abs(video.currentTime - 0.8) < 0.15; });
  const mediaUrl = await page.locator('video').evaluate(video => video.currentSrc);
  await page.locator('.video-window [data-window-action=maximize]').click();
  await page.screenshot({ path: path.join(project, 'artifacts', executablePath ? 'packaged-video.png' : 'electron-video.png') });
  await page.locator('.video-window [data-window-action=close]').click();
  assert.equal((await fetch(mediaUrl)).status, 404);
  await page.evaluate(() => window.remoteDesktop.send({ type: 'refreshRemote' }));
  await page.locator(`#icons [data-path="${remote}"]`).dblclick();
  await page.waitForFunction(() => document.querySelector('.video-window video')?.videoWidth === 160);
  const reopenedUrl = await page.locator('video').evaluate(video => video.currentSrc);
  assert.notEqual(reopenedUrl, mediaUrl);
  await page.locator('#desktopSettings').click();
  const style = selector => page.locator(selector).evaluate(button => { const s = getComputedStyle(button); return [s.borderWidth, s.borderRadius, s.backgroundColor, s.width, s.padding]; });
  assert.deepEqual(await style('#settingsDialog [data-window-action=minimize]'), await style('.video-window [data-window-action=minimize]'));
  await page.locator('#closeSettings').click(); await page.locator('#downloadsButton').click();
  assert.equal(await page.locator('#closeDownloads').evaluate(button => getComputedStyle(button).backgroundColor), 'rgba(0, 0, 0, 0)');
  for (const [id, label] of Object.entries({ connectButton: '账号与连接', downloadsButton: '传输中心', activityButton: '实时监听', browserButton: '浏览器', homeShortcut: 'Home', desktopSettings: '设置', fullscreen: '全屏' })) assert.equal(await page.locator(`#${id}`).getAttribute('title'), label);
  await page.evaluate(() => window.remoteDesktop.disconnect());
  await page.locator('.video-window').waitFor({ state: 'detached' });
  await assert.rejects(fetch(reopenedUrl));
  assert.deepEqual(errors, []);
});
