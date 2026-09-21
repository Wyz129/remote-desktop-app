'use strict';
const path = require('node:path');

function transferDirectory(value, side) {
  if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error('默认传输目录格式无效。');
  const directory = value.trim();
  if (!directory) return '';
  if (side === 'remote') {
    if (!directory.startsWith('/')) throw new Error('默认上传目录必须是服务器的绝对路径。');
    return path.posix.normalize(directory);
  }
  if (!path.isAbsolute(directory)) throw new Error('默认下载目录必须是本机的绝对路径。');
  return path.resolve(directory);
}

function transferPreferences(input = {}) {
  const result = { defaultUploadDirectory: '', defaultDownloadDirectory: '', transferUploadDirectories: {} };
  for (const [key, side] of [['defaultUploadDirectory', 'remote'], ['defaultDownloadDirectory', 'local']]) {
    try { result[key] = transferDirectory(input[key] ?? '', side); } catch { /* Invalid stored values use the system defaults. */ }
  }
  if (input.transferUploadDirectories && typeof input.transferUploadDirectories === 'object') {
    for (const [identity, value] of Object.entries(input.transferUploadDirectories)) {
      try { if (JSON.parse(identity)?.length === 4) result.transferUploadDirectories[identity] = transferDirectory(value, 'remote'); } catch {}
    }
  }
  return result;
}

module.exports = { transferDirectory, transferPreferences };
