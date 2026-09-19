'use strict';

// Video.js owns playback, seeking, volume, rate and fullscreen controls. The
// adapter receives only a temporary URL for a single authorized remote video.
window.RemoteVideoPlayer = Object.freeze({
  mount({ element, viewport, isActive = () => true, onStatus = () => {}, onError = () => {} }) {
    const empty = viewport.querySelector('.video-empty');
    const video = document.createElement('video');
    video.className = 'video-js vjs-big-play-centered';
    video.setAttribute('playsinline', ''); video.setAttribute('disablePictureInPicture', '');
    video.setAttribute('aria-label', '视频播放器'); video.preload = 'metadata';
    viewport.append(video);
    const player = videojs(video, {
      controls: true, autoplay: false, preload: 'metadata', language: 'zh-CN', responsive: true,
      fill: true, playbackRates: [0.5, 1, 1.25, 1.5, 2],
      controlBar: { pictureInPictureToggle: false },
      html5: { nativeTextTracks: true, vhs: { overrideNative: false } },
      userActions: { hotkeys: false },
    });
    let destroyed = false, media = null;
    player.el().hidden = true;
    const report = () => {
      if (!media || destroyed) return;
      const width = player.videoWidth(), height = player.videoHeight(), seconds = player.duration();
      const duration = Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '—';
      onStatus(`${width} × ${height} · ${duration} · ${media.path || media.name}`);
    };
    player.on('loadedmetadata', report);
    player.on('error', () => {
      if (destroyed || !media) return;
      const code = player.error()?.code;
      const message = code === 3 || code === 4
        ? '此视频的编码不受当前 Electron 支持，或文件已损坏。请下载后使用 VLC 等播放器打开；当前版本不进行服务器转码。'
        : '视频读取中断。请检查 SSH 连接、文件权限或文件是否被修改，然后重新打开。';
      onStatus(message); onError(message);
    });
    const keydown = event => {
      if (!isActive() || destroyed) return;
      event.stopPropagation();
      if (!media || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      // Let Video.js controls keep their own accessible keyboard interaction.
      if (event.target.closest('.vjs-control, .vjs-menu, button')) return;
      if (event.key === ' ' || event.key.toLowerCase() === 'k') {
        event.preventDefault(); if (player.paused()) void player.play()?.catch(() => {}); else player.pause();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); const duration = player.duration();
        if (Number.isFinite(duration)) player.currentTime(Math.max(0, Math.min(duration, player.currentTime() + (event.key === 'ArrowRight' ? 5 : -5))));
      }
    };
    element.addEventListener('keydown', keydown);
    return {
      load(value) {
        if (destroyed) return false;
        if (!value || typeof value.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/.test(value.url) || !String(value.mime).startsWith('video/')) throw new Error('无效的视频播放地址。');
        player.pause(); media = value; player.el().hidden = false;
        if (empty) empty.hidden = true;
        onStatus(`正在读取视频信息 · ${value.path || value.name}`);
        player.src({ src: value.url, type: value.mime });
        return true;
      },
      pause() { if (!destroyed) player.pause(); },
      resize() { if (!destroyed) player.trigger('resize'); },
      destroy() {
        if (destroyed) return;
        destroyed = true; media = null;
        element.removeEventListener('keydown', keydown); player.dispose();
      },
    };
  },
});
