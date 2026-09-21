'use strict';
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const auditContext = new AsyncLocalStorage();

const OPERATION_NAMES = Object.freeze({
  readDirectory: '访问目录', saveDesktopConfig: '保存桌面配置', pinApp: '添加收藏', unpinApp: '移除收藏',
  terminalClose: '关闭虚拟终端', 'terminal:close': '关闭虚拟终端',
  'app:save-settings': '保存设置', 'ssh:list': '访问目录', 'ssh:system-info': '读取系统信息',
  'ssh:set-desktop': '设置桌面目录', 'ssh:file-access': '检查文件权限', 'ssh:image': '打开图片',
  'ssh:download': '下载文件', 'transfer:upload': '上传文件', 'ssh:cancel-download': '取消传输',
  'ssh:open-local': '打开本机目录', 'workbench:open': '打开文档', 'workbench:save': '保存文档',
  'workbench:close': '关闭文档', 'workbench:reload': '重新加载文档', 'workbench:preview': '预览文档',
  'workbench:saveAs': '文档另存为', 'workbench:jupyterConnect': '连接 Jupyter', 'workbench:execute': '执行 Notebook 单元格',
  'workbench:kernelStart': '启动内核', 'workbench:kernelAttach': '连接内核', 'workbench:kernelInterrupt': '中断内核', 'workbench:kernelRestart': '重启内核', 'workbench:kernelShutdown': '关闭内核',
  'browser:open': '打开浏览器', 'browser:close': '关闭浏览器', 'browser:navigate': '访问网页',
  'browser:newTab': '新建浏览器标签页', 'browser:closeTab': '关闭浏览器标签页',
  'browser:selectTab': '切换浏览器标签页', 'browser:back': '浏览器后退', 'browser:forward': '浏览器前进',
  'browser:reload': '刷新网页', 'browser-navigation': '访问网页', 'browser-download': '浏览器下载',
  'video:open': '打开视频', 'jupyter-output': 'Notebook 输出', 'ssh-connected': '连接服务器',
  'connection-closed': '断开服务器连接', 'desktop-changed': '切换桌面目录', 'desktop-created': '创建桌面目录'
});
const FILE_OPERATION_NAMES = Object.freeze({ mkdir: '新建目录', touch: '新建文件', rename: '重命名', delete: '删除文件', copy: '复制文件', move: '移动文件', paste: '粘贴文件', compress: '压缩文件', extract: '解压缩文件' });
function operationName(action, details = {}) {
  if (action === 'fileOperation') return FILE_OPERATION_NAMES[details.operation] || '文件操作';
  return OPERATION_NAMES[action] || (String(action || '').startsWith('browser:') ? '浏览器操作' : String(action || '').startsWith('workbench:') ? '文档操作' : '系统操作');
}
function commandOperationName(command = '') {
  if (/date\s|timedatectl|localtime|timezone/.test(command)) return '读取服务器时间';
  if (/os-release|uname|hostname|id -[ug]/.test(command)) return '读取系统信息';
  if (/test -[rwx]|access\(/.test(command)) return '检查文件权限';
  if (/\b(?:tar|zip|unzip)\b/.test(command)) return '压缩或解压缩文件';
  if (/\bcat\b|\brsync\b/.test(command)) return '传输文件';
  return 'SSH 操作';
}
function operationStatus(result, error) {
  return error || result?.error || result?.signal || result?.ok === false || result?.success === false || result?.cancelled || (typeof result?.code === 'number' && result.code !== 0) ? 'failure' : 'success';
}

// GUI audit scopes follow the async task, never a global boolean. A simultaneous
// CLI request or unrelated GUI operation must keep its own complete transcript.
function currentAudit() { return auditContext.getStore(); }
function createSystemCommandLogger(log, isCurrent = () => true) {
  const operations = new Map();
  const recordCommand = record => {
    if (!isCurrent()) return;
    let operation = operations.get(record.operationId);
    if (!operation) {
      const context = log.capture(), summarizedByParent = Boolean(currentAudit());
      operation = { context, summarizedByParent, release: summarizedByParent ? null : log.retain?.(context) };
      operations.set(record.operationId, operation);
    }
    if (!operation.summarizedByParent) log.system(record, operation.context);
    if (record.type === 'end') { operation.release?.(); operations.delete(record.operationId); }
  };
  recordCommand.operations = operations;
  return recordCommand;
}
function systemRecord(record) {
  if (record.category === 'terminal' || String(record.type).startsWith('terminal-') || record.terminalId) return { ...record, category: 'terminal' };
  const value = { ...record, category: 'system' };
  if (value.type === 'jupyter-output' && value.output !== undefined) value.result = value.output;
  if (value.type === 'command') {
    value.type = 'operation'; value.operationName = commandOperationName(value.command); delete value.command;
  } else if (value.type === 'end') {
    value.type = 'result'; value.result = { code: value.code ?? null, signal: value.signal ?? null, ...(value.cancelled ? { cancelled: true } : {}), ...(value.error ? { error: value.error } : {}) };
  }
  if (!['stdout', 'stderr', 'output', 'output-truncated', 'progress'].includes(value.type)) {
    value.operationName ||= operationName(value.action || value.type, value);
    if (value.type !== 'operation') value.status = operationStatus(value.result || value, value.error);
  }
  if (value.type === 'operation') value.input = `#${value.operationName}`;
  else if (value.status) value.output = value.status === 'success' ? '#成功' : '#失败';
  return value;
}

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
  const keys = ['ok', 'success', 'cancelled', 'connected', 'path', 'rootPath', 'homePath', 'resolvedPath', 'status', 'readOnly', 'readable', 'writable', 'total', 'done', 'method', 'code', 'signal', 'error', 'paths', 'affectedPaths', 'username', 'hostname', 'home', 'os', 'kernel', 'architecture', 'cpu', 'memory', 'disk', 'dateTime', 'timeZone', 'locale', 'shell', 'network'];
  return { ...Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]])), ...(Array.isArray(value.entries) ? { count: value.entries.length } : {}) };
}
function createAuditor(log) {
  return async function audit(action, details, task, context = log.capture()) {
    const operationId = crypto.randomUUID();
    const release = log.retain?.(context);
    const name = operationName(action, details);
    log.system({ type: 'operation', operationId, action, ...details, operationName: name, input: `#${name}` }, context);
    try {
      const result = await auditContext.run({ operationId, action, context }, task);
      const status = operationStatus(result);
      log.system({ type: 'result', operationId, action, operationName: name, status, output: status === 'success' ? '#成功' : '#失败', result: resultSummary(result) }, context);
      return result;
    } catch (error) {
      log.system({ type: 'error', operationId, action, operationName: name, status: 'failure', output: '#失败', error: { message: error.message, code: error.code } }, context);
      throw error;
    } finally { release?.(); }
  };
}
module.exports = { safeUrl, resultSummary, createAuditor, createSystemCommandLogger, currentAudit, systemRecord, operationName };
