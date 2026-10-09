'use strict';
// Shared by the trusted renderer and main process; preferences select built-ins only.
(function (root) {
  const entries = [
    ['open', '打开', 'item'], ['workbench', '打开方式 · Monaco Editor', 'item'], ['browser', '打开方式 · Browser', 'item'],
    ['new-file', '新建文件', 'empty'], ['new-folder', '新建文件夹', 'empty'],
    ['rename', '重命名', 'item'], ['cut', '剪切', 'item'], ['copy', '复制', 'item'],
    ['paste', '粘贴', 'empty'], ['delete', '删除', 'item'],
    ['shortcut', '发送到桌面快捷方式', 'item'], ['download', '下载到本地', 'item'],
    ['compress', '压缩', 'item'], ['extract', '解压缩', 'item'],
    ['terminal', '在此处打开 RTerminal', 'empty'], ['local-terminal', '打开本机终端', 'empty'], ['refresh', '刷新', 'empty'], ['arrange', '整理桌面', 'empty']
  ].map(([id, label, scope]) => Object.freeze({ id, label, scope }));
  const known = new Set(entries.map(entry => entry.id));
  function normalize(input, strict = false) {
    if (input == null) return { hidden: [] };
    if (typeof input !== 'object' || Array.isArray(input) || (input.hidden !== undefined && !Array.isArray(input.hidden))) {
      if (strict) throw new Error('右键菜单设置无效。');
      return { hidden: [] };
    }
    const hidden = input.hidden || [];
    if (strict && (hidden.length > entries.length || hidden.some(id => !known.has(id)))) throw new Error('只能选择内建右键菜单项目。');
    return { hidden: [...new Set(hidden.filter(id => known.has(id)))] };
  }
  function visibleActions({ selected = [], desktop = false, clipboard = false } = {}, preferences) {
    const hidden = new Set(normalize(preferences).hidden), files = selected.filter(item => item.kind !== 'command');
    return entries.filter(entry => {
      if (hidden.has(entry.id) || entry.scope !== (selected.length ? 'item' : 'empty')) return false;
      if (entry.id === 'paste') return clipboard;
      if (entry.id === 'arrange') return desktop;
      if (entry.id === 'rename') return selected.length === 1;
      if (entry.id === 'workbench') return selected.length === 1 && files.length === 1 && files[0].type !== 'folder';
      if (entry.id === 'browser') return selected.length === 1 && files.length === 1 && files[0].type !== 'folder' && /\.(?:html?|pdf)$/i.test(files[0].name);
      if (entry.id === 'extract') return selected.length === 1 && files.length === 1 && files[0].type !== 'folder' && /\.(?:zip|tar|tar\.gz|tgz)$/i.test(files[0].name);
      if (['cut', 'copy', 'shortcut', 'download', 'compress'].includes(entry.id)) return files.length > 0;
      return true;
    }).map(entry => entry.id);
  }
  const api = Object.freeze({ entries: Object.freeze(entries), normalize, visibleActions });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ContextMenuPreferences = api;
})(typeof globalThis === 'object' ? globalThis : this);
