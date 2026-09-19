'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { SshBackend } = require('../lib/ssh-backend.cjs');
const { VideoService } = require('../lib/video-service.cjs');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');
const project = path.resolve(__dirname, '..');

test('real Video.js plays and seeks a generated WebM through SSH ranges in a sandboxed renderer', { timeout: 60000 }, async t => {
  const fixture = await createSshFixture(); const backend = new SshBackend();
  await backend.connect(fixture.config); const service = new VideoService(backend); let application;
  t.after(async () => {
    if (application && application.process().exitCode === null) {
      const timer = setTimeout(() => { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(application.process().pid), '/T', '/F'], { windowsHide: true }); else application.process().kill('SIGKILL'); }, 5000);
      try { await application.close(); } finally { clearTimeout(timer); }
    }
    await service.disconnect(); await backend.disconnect(); await fixture.close();
  });
  const asset = relative => pathToFileURL(path.join(project, relative)).href;
  const html = path.join(fixture.root, 'video.html');
  await fs.writeFile(html, `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src file:; style-src file: 'unsafe-inline'; font-src data:; media-src http://127.0.0.1:* blob:; img-src data:;"><link rel="stylesheet" href="${asset('media/workbench/video.css')}"><link rel="stylesheet" href="${asset('app/video-player.css')}"><div id="window" style="height:480px;display:flex;flex-direction:column"><div id="viewport" class="video-viewport"><div class="video-empty">选择视频</div></div><output id="status"></output></div><script src="${asset('media/workbench/video.js')}"></script><script src="${asset('media/workbench/video-zh-CN.js')}"></script><script src="${asset('app/video-player.js')}"></script>`);
  const env = { ...process.env, REMOTE_DESKTOP_VIDEO_TEST_HTML: html }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [path.join(__dirname, 'helpers/video-harness.cjs'), '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${path.join(fixture.root, 'electron-video')}`], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.RemoteVideoPlayer && window.videojs);
  assert.deepEqual(await page.evaluate(() => ({ require: typeof require, desktop: typeof window.remoteDesktop })), { require: 'undefined', desktop: 'undefined' });
  // Chromium's own encoder creates a tiny, original test clip: no external
  // videos, extra codecs, downloads or ffmpeg installation are needed.
  const recording = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const context = canvas.getContext('2d'); let frame = 0;
    const draw = () => { context.fillStyle = frame++ % 2 ? '#2875ce' : '#d55137'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = 'white'; context.font = '22px sans-serif'; context.fillText(`frame ${frame}`, 20, 50); };
    draw(); const stream = canvas.captureStream(12), chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    recorder.ondataavailable = event => chunks.push(event.data);
    const finished = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start(); const timer = setInterval(draw, 80);
    await new Promise(resolve => setTimeout(resolve, 2800)); recorder.stop(); await finished;
    clearInterval(timer); stream.getTracks().forEach(track => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  assert.ok(recording.length > 1000);
  const remote = await fixture.put('sample.webm', Buffer.from(recording)), media = await service.open(remote);
  await page.evaluate(value => {
    window.playerErrors = [];
    window.adapter = window.RemoteVideoPlayer.mount({ element: document.getElementById('window'), viewport: document.getElementById('viewport'), onStatus: text => { document.getElementById('status').textContent = text; }, onError: error => window.playerErrors.push(error) });
    window.adapter.load(value);
  }, media);
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth === 160);
  await page.evaluate(() => document.querySelector('video').play());
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.4);
  assert.equal(await page.locator('.video-js .vjs-control-bar').count(), 1);
  await page.waitForFunction(() => document.querySelector('video').ended);
  const duration = await page.locator('video').evaluate(video => video.duration);
  assert.ok(duration > 2 && duration < 4, `duration=${duration}`);
  await page.locator('video').evaluate(video => { video.currentTime = 0.8; });
  await page.waitForFunction(() => { const video = document.querySelector('video'); return !video.seeking && Math.abs(video.currentTime - 0.8) < 0.12; });
  await page.evaluate(() => document.querySelector('video').play());
  await page.waitForFunction(() => document.querySelector('video').currentTime > 1.1 && !document.querySelector('video').ended);
  await page.evaluate(() => window.adapter.pause());
  assert.deepEqual(await page.evaluate(() => window.playerErrors), []);
  assert.ok(fixture.calls.sftp.some(call => call[0] === 'READ' && call[2] > 0));
  await fs.mkdir(path.join(project, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(project, 'artifacts/video-player.png') });
  await page.evaluate(() => window.adapter.destroy()); assert.equal(await page.locator('.video-js').count(), 0);
  assert.equal(service.release(media.id), true); assert.deepEqual(errors, []);
});
