'use strict';
const { normalizeRemote } = require('./ssh-backend.cjs');

// JSON tuples avoid separator collisions and keep accounts and verified hosts
// separate, even when they use the same address or have similarly named paths.
function desktopIdentity({ host, port = 22, username, hostFingerprint }) {
  if (!host || !username || !hostFingerprint) throw new Error('缺少已验证的服务器身份。');
  return JSON.stringify([String(host).trim().toLowerCase(), Number(port), String(username), String(hostFingerprint).replace(/=+$/, '')]);
}
function desktopLocations(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = [];
  for (const [key, target] of Object.entries(value)) {
    try {
      const identity = JSON.parse(key);
      if (!Array.isArray(identity) || identity.length !== 4 || typeof target !== 'string') continue;
      entries.push([key, normalizeRemote(target)]);
    } catch { /* Ignore malformed local preferences. */ }
  }
  return Object.fromEntries(entries);
}
module.exports = { desktopIdentity, desktopLocations };
