'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeRemote } = require('./ssh-backend.cjs');

function transferIdentity(backend) {
  if (!backend?.desktopIdentity) return null;
  const [host, port, username, fingerprint] = JSON.parse(backend.desktopIdentity);
  return { host, port, username, fingerprint };
}
async function registerLocalPaths(values, selected, isCurrent = () => true) {
  if (!Array.isArray(values) || values.length > 1000) throw new Error('单次最多选择 1000 个本地项目。');
  const paths = [...new Set(values)];
  for (const value of paths) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('本地项目路径无效。');
    const stat = await fs.lstat(value);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`不支持符号链接、目录联接或特殊文件：${value}`);
  }
  if (!isCurrent()) throw new Error('SSH 连接已改变，请重新选择本地项目。');
  paths.forEach(value => selected.add(value)); return paths;
}
async function openTransferTarget(task, { getBackend, shell }) {
  if (!task || typeof task.targetDirectory !== 'string' || task.targetDirectory.includes('\0')) throw new Error('此记录没有可打开的目标目录。');
  if (task.targetSide === 'local') {
    if (!path.isAbsolute(task.targetDirectory)) throw new Error('本地目标目录无效。');
    if (!(await fs.stat(task.targetDirectory)).isDirectory()) throw new Error('本地目标目录已不存在。');
    const error = await shell.openPath(task.targetDirectory);
    if (error) throw new Error(`无法打开本地目标目录：${error}`);
    return { side: 'local' };
  }
  if (task.targetSide !== 'remote') throw new Error('目标类型无效。');
  const backend = getBackend(), identity = transferIdentity(backend);
  if (!identity || !task.serverIdentity || ['host', 'port', 'username', 'fingerprint'].some(key => identity[key] !== task.serverIdentity[key])) throw new Error('请先连接此传输记录对应的服务器账号。');
  const target = normalizeRemote(task.targetDirectory);
  await backend.list(target);
  if (getBackend() !== backend || !backend.connected) throw new Error('SSH 连接已改变。');
  return { side: 'remote', path: target };
}
module.exports = { transferIdentity, registerLocalPaths, openTransferTarget };
