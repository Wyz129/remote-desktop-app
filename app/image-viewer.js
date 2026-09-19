'use strict';

// Viewer.js owns all image geometry and pointer gestures. Keyboard controls are
// scoped to this virtual window instead of Viewer.js's document-wide listener.
window.RemoteImageViewer = Object.freeze({
  mount({ element, viewport, isActive = () => true, onStatus = () => {} }) {
    let viewer = null, source = null, destroyed = false, generation = 0, lastWidth = 0, lastHeight = 0;
    const controls = [...element.querySelectorAll('[data-image-action]:not([data-image-action="open"])')];
    const scale = element.querySelector('.image-scale');
    const empty = viewport.querySelector('.image-empty');
    const enable = value => { for (const control of controls) control.disabled = !value; };
    const update = () => {
      if (!viewer?.viewed || destroyed) return;
      scale.textContent = Math.round(viewer.imageData.ratio * 100) + '%';
    };
    const run = action => {
      if (!viewer?.viewed || destroyed) return;
      if (action === 'fit') viewer.reset();
      else if (action === 'actual') viewer.zoomTo(1);
      else if (action === 'in') viewer.zoom(0.25);
      else if (action === 'out') viewer.zoom(-0.25);
      else if (action === 'rotate') viewer.rotate(90);
      else if (action === 'flip') viewer.scaleX(-viewer.imageData.scaleX || -1);
      update();
    };
    const keydown = event => {
      event.stopPropagation();
      if (!isActive() || event.target.closest('input, textarea, [contenteditable="true"]')) return;
      if (event.ctrlKey || event.metaKey || event.altKey || !viewer?.viewed) return;
      const actions = { '+': 'in', '=': 'in', '-': 'out', '0': 'actual', f: 'fit', r: 'rotate', h: 'flip' };
      const action = actions[event.key.toLowerCase()];
      const move = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
      if (!action && !move) return;
      event.preventDefault();
      if (action) run(action); else viewer.move(...move);
    };
    const resize = () => {
      const width = viewport.clientWidth, height = viewport.clientHeight;
      if (!viewer?.viewed || !width || !height || (width === lastWidth && height === lastHeight)) return;
      lastWidth = width; lastHeight = height;
      viewer.resize(); update();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    element.addEventListener('keydown', keydown);
    enable(false); scale.textContent = '—';
    return {
      run, resize,
      async load(dataUrl, name, remotePath) {
        const request = ++generation;
        const image = new Image(); image.alt = name; image.draggable = false;
        image.className = 'image-source'; image.src = dataUrl;
        try { await image.decode(); }
        catch { if (!destroyed && request === generation) throw new Error('图片无法解码，可下载原文件后使用其他程序打开。'); return false; }
        if (destroyed || request !== generation) return false;
        viewer?.destroy(); source?.remove(); viewer = null; source = image;
        viewport.append(image); empty.hidden = true; enable(false);
        viewer = new Viewer(image, {
          inline: true, button: false, navbar: false, navigation: false, title: false, toolbar: false,
          keyboard: false, focus: false, fullscreen: false, backdrop: false, transition: false,
          initialCoverage: 1, minWidth: 0, minHeight: 0, zIndexInline: 1,
          minZoomRatio: 0.02, maxZoomRatio: 32, tooltip: false,
          viewed() {
            if (destroyed || request !== generation) return;
            lastWidth = viewport.clientWidth; lastHeight = viewport.clientHeight;
            enable(true); update(); onStatus(`${image.naturalWidth} × ${image.naturalHeight} · ${remotePath}`);
          },
          zoomed: update, moved: update, rotated: update, scaled: update,
        });
        return true;
      },
      destroy() {
        if (destroyed) return;
        destroyed = true; generation++; observer.disconnect();
        element.removeEventListener('keydown', keydown);
        viewer?.destroy(); source?.remove(); viewer = null; source = null;
      },
    };
  },
});
