'use strict';
(() => {
  const CHANNEL = 'remote-desktop-workbench-v1';
  const ACTIONS = new Set(['load', 'update', 'close', 'open', 'save', 'saveAs', 'reload', 'preview', 'jupyterConnect', 'jupyterInfo', 'kernelStart', 'kernelAttach', 'execute', 'kernelInterrupt', 'kernelRestart', 'kernelShutdown']);
  const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id);
  const pageUrl = new URL('workbench.html', document.currentScript.src).href;
  if (window.parent === window) {
    // Only trusted bundled workbench code runs in this frame. Remote HTML uses
    // a separate opaque sandbox nested inside it, never this message channel.
    window.RemoteWorkbenchFrame = Object.freeze({
      mount({ iframe, id, url = pageUrl, call, onFocus, onError }) {
        if (!(iframe instanceof HTMLIFrameElement) || !validId(id) || typeof call !== 'function') throw new Error('Monaco Editor 嵌入参数无效。');
        const target = new URL(url);
        if (!target.pathname.endsWith('/app/workbench.html') || target.search || target.hash || (target.protocol !== 'file:' && (target.protocol !== 'http:' || target.hostname !== '127.0.0.1'))) throw new Error('Monaco Editor 地址无效。');
        let destroyed = false, ready = false;
        const queue = [];
        const post = message => { if (!destroyed) iframe.contentWindow?.postMessage({ channel: CHANNEL, id, ...message }, '*'); };
        const listener = async event => {
          if (destroyed || event.source !== iframe.contentWindow || event.data?.channel !== CHANNEL || event.data.id !== id) return;
          const message = event.data;
          if (message.type === 'ready') { ready = true; for (const queued of queue.splice(0)) post(queued); return; }
          if (message.type === 'focus') { onFocus?.(); return; }
          if (message.type !== 'request' || !Number.isSafeInteger(message.requestId) || message.requestId < 1 || !ACTIONS.has(message.action) || !message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) return;
          let response;
          try { response = await call(message.action, message.payload); }
          catch (error) { response = { ok: false, error: error.message || 'Monaco Editor 请求失败。' }; onError?.(error); }
          post({ type: 'response', requestId: message.requestId, response });
        };
        window.addEventListener('message', listener);
        iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        iframe.src = `${target.href}#${id}`;
        return Object.freeze({
          send(event) { if (destroyed) return; const value = { type: 'event', event }; if (ready) post(value); else queue.push(value); },
          destroy() { destroyed = true; queue.length = 0; window.removeEventListener('message', listener); iframe.removeAttribute('src'); }
        });
      }
    });
    return;
  }
  if (window.workbench) return;
  const id = location.hash.slice(1);
  if (!validId(id)) return;
  let sequence = 0;
  const requests = new Map(), subscribers = new Set(), queue = [];
  const post = message => window.parent.postMessage({ channel: CHANNEL, id, ...message }, '*');
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.channel !== CHANNEL || event.data.id !== id) return;
    const message = event.data;
    if (message.type === 'response') { const pending = requests.get(message.requestId); if (pending) { requests.delete(message.requestId); pending(message.response); } }
    if (message.type === 'event') { if (!subscribers.size) queue.push(message.event); else subscribers.forEach(callback => callback(message.event)); }
  });
  window.workbench = Object.freeze({
    call(action, payload = {}) {
      if (!ACTIONS.has(action)) return Promise.resolve({ ok: false, error: '未知工作台操作。' });
      const requestId = ++sequence;
      return new Promise(resolve => { requests.set(requestId, resolve); post({ type: 'request', requestId, action, payload }); });
    },
    onEvent(callback) { subscribers.add(callback); for (const event of queue.splice(0)) callback(event); return () => subscribers.delete(callback); }
  });
  window.addEventListener('pagehide', () => { requests.forEach(resolve => resolve({ ok: false, error: 'Monaco Editor 窗口已关闭。' })); requests.clear(); subscribers.clear(); });
  document.addEventListener('pointerdown', () => post({ type: 'focus' }), true);
  window.addEventListener('focus', () => post({ type: 'focus' }));
  post({ type: 'ready' });
})();
