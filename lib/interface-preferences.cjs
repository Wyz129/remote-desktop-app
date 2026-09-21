'use strict';
const path = require('node:path');
const PLACE_IDS = ['root', 'home', 'desktop', 'log', 'trash'];
const TOOLBAR_IDS = ['connectButton', 'downloadsButton', 'activityButton', 'homeShortcut', 'desktopSettings', 'fullscreen', 'exitButton', 'browserButton'];
function absolute(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value) || value.length > 4096) throw new Error('请输入有效的服务器绝对路径。');
  return path.posix.normalize(value);
}
function workspacePreferences(input = {}, strict = false) {
  const result = { logPath: '', trashPath: '', shortcuts: [], placeOrder: [...PLACE_IDS] };
  if (!input || typeof input !== 'object' || Array.isArray(input)) { if (strict) throw new Error('目录偏好无效。'); return result; }
  for (const key of ['logPath', 'trashPath']) {
    try { if (input[key]) result[key] = absolute(input[key]); } catch (error) { if (strict) throw error; }
  }
  const ids = new Set(PLACE_IDS);
  for (const item of Array.isArray(input.shortcuts) ? input.shortcuts.slice(0, 40) : []) {
    try {
      if (!item || !/^custom-[a-zA-Z0-9-]{1,70}$/.test(item.id) || ids.has(item.id)) throw new Error('快捷方式标识无效或重复。');
      const label = String(item.label || '').trim();
      if (!label || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw new Error('快捷方式名称须为 1–80 个字符。');
      result.shortcuts.push({ id: item.id, label, path: absolute(item.path) }); ids.add(item.id);
    } catch (error) { if (strict) throw error; }
  }
  if (strict && input.shortcuts?.length > 40) throw new Error('最多保存 40 个目录快捷方式。');
  result.placeOrder = [...new Set([...(Array.isArray(input.placeOrder) ? input.placeOrder.filter(id => ids.has(id)) : []), ...ids])];
  return result;
}
function workspaceLocations(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => { try { return Array.isArray(JSON.parse(key)) && JSON.parse(key).length === 4; } catch { return false; } }).map(([key, item]) => [key, workspacePreferences(item)]));
}
function shellPreferences(input = {}) {
  const known = new Set(TOOLBAR_IDS);
  return { clockMode: input?.clockMode === 'detailed' ? 'detailed' : 'compact',
    toolbarOrder: [...new Set([...(Array.isArray(input?.toolbarOrder) ? input.toolbarOrder.filter(id => known.has(id)) : []), ...TOOLBAR_IDS])],
    toolbarHidden: [...new Set(Array.isArray(input?.toolbarHidden) ? input.toolbarHidden.filter(id => known.has(id)) : ['browserButton'])] };
}
module.exports = { PLACE_IDS, TOOLBAR_IDS, absolute, workspacePreferences, workspaceLocations, shellPreferences };
