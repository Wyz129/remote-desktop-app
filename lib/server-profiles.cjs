'use strict';
const crypto = require('node:crypto');
const { desktopLocations } = require('./desktop-preferences.cjs');
const STORAGE_VERSION = 2;
function serverProfile(input) {
  if (!input || typeof input !== 'object') throw new Error('服务器配置无效。');
  const host = String(input.host || '').trim(), username = String(input.username || '').trim();
  const port = input.port === undefined || input.port === '' ? 22 : Number(input.port);
  const alias = String(input.alias || '').trim();
  if (!host || host.length > 253 || /[\s/\\\x00-\x1f]/.test(host)) throw new Error('请输入有效的服务器 IP 或主机名。');
  if (!username || username.length > 128 || /[\x00-\x1f]/.test(username)) throw new Error('请输入有效的用户名。');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1–65535。');
  if (alias.length > 100 || /[\x00-\x1f]/.test(alias)) throw new Error('服务器别名不得超过 100 字符或包含控制字符。');
  const privateKeyPath = typeof input.privateKeyPath === 'string' ? input.privateKeyPath : '';
  if (privateKeyPath.length > 4096 || /[\x00-\x1f]/.test(privateKeyPath)) throw new Error('私钥路径无效。');
  return { id: typeof input.id === 'string' && /^[\w-]{1,80}$/.test(input.id) ? input.id : crypto.randomUUID(), host, port, username, alias, privateKeyPath };
}
function profilesFromSettings(settings) {
  const profiles = [];
  for (const item of (Array.isArray(settings.serverProfiles) ? settings.serverProfiles : []).slice(0, 100)) {
    try { const profile = serverProfile(item); if (!profiles.some(saved => saved.id === profile.id)) profiles.push(profile); } catch { /* Ignore invalid saved profiles. */ }
  }
  if (!profiles.length && settings.host && settings.username) { try { profiles.push(serverProfile(settings)); } catch {} }
  return profiles;
}
function upsertProfile(profiles, input) {
  const profile = serverProfile(input);
  const existing = profiles.find(item => item.id === input.id) || profiles.find(item => item.host.toLowerCase() === profile.host.toLowerCase() && item.port === profile.port && item.username === profile.username);
  if (existing) profile.id = existing.id;
  if (!existing && profiles.length >= 100) throw new Error('最多保存 100 个服务器配置。');
  return { serverProfiles: [...profiles.filter(item => item.id !== profile.id), profile], selectedServerId: profile.id };
}
function storagePreferences(loaded) {
  return { storageVersion: STORAGE_VERSION, desktopLocations: loaded.storageVersion === STORAGE_VERSION ? desktopLocations(loaded.desktopLocations) : {} };
}
function connectionTitle({ username, host, port, alias }, address) {
  const target = String(address || host).replace(/^::ffff:/, '');
  return `Remote Desktop - ssh ${username}@${target.includes(':') ? `[${target}]` : target}:${port}${alias ? ` ${alias}` : ''}`;
}
module.exports = { serverProfile, profilesFromSettings, upsertProfile, storagePreferences, connectionTitle, STORAGE_VERSION };
