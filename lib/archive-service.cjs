'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { posixQuote } = require('./ssh-backend.cjs');
const helper = fs.readFileSync(path.join(__dirname, 'remote-archive.py'), 'utf8');
const MAX_OUTPUT = 65536;
async function archiveOperation(service, input) {
  if (!input || !['compress', 'extract'].includes(input.operation) || !Array.isArray(input.paths) || !input.paths.length || input.paths.length > 1000 || input.paths.some(target => typeof target !== 'string' || /[\x00-\x1f]/.test(target))) throw new Error('压缩或解压选择无效。');
  const format = input.format || 'tar.gz';
  if (!['tar.gz', 'zip'].includes(format)) throw new Error('压缩格式仅支持 .tar.gz 和 .zip。');
  const backend = service.backend, { client, sftp, home } = backend;
  const assertActive = () => { if (!client || !sftp || !home || service.backend !== backend || backend.client !== client || backend.sftp !== sftp || backend.home !== home) throw new Error('SSH 连接已改变，压缩或解压操作已取消。'); };
  assertActive();
  const parent = await service.checked(input.parent);
  assertActive();
  const paths = [...new Set(input.paths)];
  for (const target of paths) {
    if (path.posix.dirname(target) !== parent) throw new Error('请在同一个目录内选择压缩或解压项目。');
    await service.checked(target);
    assertActive();
  }
  if (input.operation === 'extract' && (paths.length !== 1 || !/\.(?:zip|tar|tar\.gz|tgz)$/i.test(paths[0]))) throw new Error('请选择一个 .zip、.tar.gz、.tgz 或 .tar 文件解压。');
  const request = { operation: input.operation, parent, paths, format };
  const command = `# remote-desktop-archive-v1\ncommand -v python3 >/dev/null 2>&1 || { printf '%s\\n' '服务器未安装 python3，无法使用压缩与解压功能。' >&2; exit 127; }\npython3 -I -c ${posixQuote(helper)} ${posixQuote(JSON.stringify(request))}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15 * 60 * 1000);
  try {
    const { stream, completion } = await backend._execStream(command, controller.signal);
    assertActive();
    const chunks = []; let total = 0;
    const reading = (async () => { for await (const chunk of stream) { total += chunk.length; if (total > MAX_OUTPUT) { controller.abort(); throw new Error('压缩服务返回内容过大。'); } chunks.push(chunk); } })();
    await Promise.all([reading, completion]);
    assertActive();
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const target = result?.paths?.[0];
    if (!Array.isArray(result?.paths) || result.paths.length !== 1 || typeof target !== 'string' || /[\x00-\x1f]/.test(target) || path.posix.normalize(target) !== target || ['.', '..'].includes(path.posix.basename(target)) || path.posix.dirname(target) !== parent) throw new Error('压缩服务返回的目标路径无效。');
    return { success: true, ok: true, paths: result.paths, affectedPaths: [parent] };
  } catch (error) { controller.abort(); throw new Error(`${input.operation === 'compress' ? '无法压缩' : '无法解压'}：${error.message}`); }
  finally { clearTimeout(timer); }
}
module.exports = { archiveOperation, helper };
