'use strict';
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

function openInteractiveShell(backend, input, context) {
  return new Promise((resolve, reject) => {
    const id = `local-${crypto.randomUUID()}`, client = backend.client;
    const decoder = new StringDecoder('utf8');
    let done = false, ready = false, removeInput = () => {};
    const timeout = setTimeout(() => finish(new Error('远程终端启动超时。')), 15000);
    const finish = (error, code = 0) => {
      if (done) return; done = true; clearTimeout(timeout);
      removeInput(); context.signal?.removeEventListener('abort', abort); client?.off('close', disconnected);
      backend.closeShell(id);
      const tail = decoder.end(); if (tail) context.onProgress({ kind: 'stdout', data: tail });
      error ? reject(error) : resolve({ code });
    };
    const abort = () => finish(Object.assign(new Error('本机终端连接已关闭。'), { code: 'ABORT_ERR' }));
    const disconnected = () => finish(new Error('SSH 已断开，本机终端会话已结束。'));
    if (context.signal?.aborted) { abort(); return; }
    context.signal?.addEventListener('abort', abort, { once: true }); client?.once('close', disconnected);
    try {
      removeInput = context.onInput(frame => {
        if (done || !ready) return;
        try {
          if (backend.client !== client || !backend.connected) throw new Error('SSH 连接已改变。');
          if (frame.type === 'input') backend.writeShell(id, frame.data);
          else if (frame.type === 'resize') backend.resizeShell(id, frame.cols, frame.rows);
          else if (frame.type === 'close') finish();
        } catch (error) { finish(error); }
      });
      backend.openShell(id, input.cwd || backend.home, chunk => {
        if (!done) { const data = decoder.write(chunk); if (data) context.onProgress({ kind: 'stdout', data }); }
      }, finish, { cols: input.cols, rows: input.rows, program: 'shell',
        onCommand: data => context.onProgress({ kind: 'command', data }),
        onInput: data => context.onProgress({ kind: 'terminal-input', data }),
        onReady: () => { if (done) return; ready = true; clearTimeout(timeout); context.onProgress({ kind: 'ready' }); }
      });
    } catch (error) { finish(error); }
  });
}
module.exports = { openInteractiveShell };
