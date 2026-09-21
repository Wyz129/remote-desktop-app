'use strict';
// Only explicit trusted terminal key actions call this bridge. Remote OSC 52
// sequences and isolated browser/workbench contents have no clipboard bridge.
const MAX_CLIPBOARD_BYTES = 60000;
function clipboardText(value) {
  if (typeof value !== 'string') throw new Error('剪贴板内容必须为文本。');
  if (Buffer.byteLength(value, 'utf8') > MAX_CLIPBOARD_BYTES) throw new Error('终端单次复制或粘贴最多 60 KB，请分段操作或使用文件传输。');
  return value;
}
module.exports = { clipboardText, MAX_CLIPBOARD_BYTES };
