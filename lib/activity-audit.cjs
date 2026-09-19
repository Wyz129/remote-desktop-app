'use strict';
const crypto = require('node:crypto');

// Metadata is deliberately selected by callers. Never serialize IPC payloads,
// settings, credentials, cookies, or file bodies into the system log.
function safeUrl(value) {
  try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`; }
  catch { return '[invalid URL]'; }
}
function resultSummary(value) {
  if (value === undefined) return { completed: true };
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return { count: value.length };
  if (typeof value !== 'object') return { completed: true };
  const keys = ['ok', 'success', 'cancelled', 'connected', 'path', 'rootPath', 'homePath', 'resolvedPath', 'status', 'readOnly', 'readable', 'writable', 'total', 'done', 'method', 'code', 'signal', 'error', 'paths', 'affectedPaths'];
  return { ...Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]])), ...(Array.isArray(value.entries) ? { count: value.entries.length } : {}) };
}
function createAuditor(log) {
  return async function audit(action, details, task, context = log.capture()) {
    const operationId = crypto.randomUUID();
    const release = log.retain?.(context);
    log.system({ type: 'operation', operationId, action, ...details }, context);
    try {
      const result = await task();
      log.system({ type: 'result', operationId, action, result: resultSummary(result) }, context);
      return result;
    } catch (error) {
      log.system({ type: 'error', operationId, action, error: { message: error.message, code: error.code } }, context);
      throw error;
    } finally { release?.(); }
  };
}
module.exports = { safeUrl, resultSummary, createAuditor };
