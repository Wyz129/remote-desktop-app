'use strict';

const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const DEFAULT_TRACE_BYTES = 256 * 1024;

/** Observe incoming readable bytes without adding a data listener or consuming
 * the channel. ssh2 provides the channel in the exec callback before delivering
 * its payload. Intercepting Readable.push preserves the caller's backpressure,
 * stream identity and (for uploads) writable half. Never log outbound file data.
 */
function observeReadable(stream, observe) {
  if (!stream || typeof stream.push !== 'function') return () => {};
  const original = stream.push;
  const tapped = function (chunk, encoding) {
    try { observe(chunk, encoding); } catch { /* Audit must not break SSH I/O. */ }
    return original.call(this, chunk, encoding);
  };
  stream.push = tapped;
  return () => { if (stream.push === tapped) stream.push = original; };
}

function createCommandTrace(command, onRecord, options = {}) {
  if (typeof onRecord !== 'function' || options.audit === false) return { attach() {}, end() {} };
  const operationId = crypto.randomUUID();
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_TRACE_BYTES;
  const streams = new Map();
  const untap = [];
  let ended = false;
  const emit = record => {
    try { onRecord({ action: 'ssh-exec', protocol: 'SSH exec', operationId, time: new Date().toISOString(), ...record }); }
    catch { /* Audit listeners cannot stop a remote command. */ }
  };
  emit({ type: 'command', command, ...(options.binary ? { outputMode: 'binary', outputNote: '文件传输内容不写入操作日志。' } : {}) });
  const observe = (kind, chunk, encoding) => {
    if (ended) return;
    let state = streams.get(kind);
    if (!state) { state = { decoder: new StringDecoder('utf8'), bytes: 0, truncated: false, flushed: false }; streams.set(kind, state); }
    const flush = () => {
      if (state.flushed) return;
      state.flushed = true;
      const data = state.decoder.end();
      if (data) emit({ type: kind, data });
    };
    if (chunk === null) { flush(); return; }
    if (kind === 'stdout' && options.binary) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8');
    if (state.truncated) return;
    const remaining = maxBytes - state.bytes;
    if (bytes.length <= remaining) {
      state.bytes += bytes.length;
      const data = state.decoder.write(bytes);
      if (data) emit({ type: kind, data });
      return;
    }
    if (remaining) {
      state.bytes += remaining;
      const data = state.decoder.write(bytes.subarray(0, remaining));
      if (data) emit({ type: kind, data });
    }
    // Drop any trailing incomplete UTF-8 sequence instead of manufacturing a
    // replacement character at the truncation boundary.
    state.truncated = true; state.flushed = true;
    emit({ type: 'output-truncated', stream: kind, maxBytes, capturedBytes: state.bytes,
      message: `该命令的 ${kind} 超过 ${maxBytes} 字节，后续内容未写入操作日志；命令本身继续执行。` });
  };
  return {
    attach(stream) {
      untap.push(observeReadable(stream, (chunk, encoding) => observe('stdout', chunk, encoding)));
      untap.push(observeReadable(stream.stderr, (chunk, encoding) => observe('stderr', chunk, encoding)));
    },
    end(result = {}) {
      if (ended) return;
      for (const [kind, state] of streams) {
        if (!state.flushed) { state.flushed = true; const data = state.decoder.end(); if (data) emit({ type: kind, data }); }
      }
      ended = true;
      for (const restore of untap) restore();
      emit({ type: 'end', ...result });
    }
  };
}

module.exports = { createCommandTrace, DEFAULT_TRACE_BYTES };
