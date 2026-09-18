'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  let documentInfo, sourceEditor, notebook, notebookEditors = [], dirty = false, connected = true, loading = true, language = 'plaintext', previewRoot = '', kernelConnected = false, inputResolve;
  const cellIds = new WeakMap(); let cellSequence = 0;
  function cellId(cell) { if (!cellIds.has(cell)) cellIds.set(cell, `cell-${++cellSequence}`); return cellIds.get(cell); }
  function status(text, error = false) { $('#status').textContent = text; $('#status').classList.toggle('error', error); }
  async function call(action, payload) { const response = await window.workbench.call(action, payload); if (!response.ok) { const error = new Error(response.error); error.code = response.code; throw error; } return response.value; }
  const sourceText = cell => Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
  const currentText = () => notebook ? JSON.stringify(notebook, null, 2) + '\n' : sourceEditor?.getValue() || '';
  function changed() { if (loading) return; const text = currentText(); dirty = text !== documentInfo.text; $('#dirty').textContent = dirty ? '● 未保存' : ''; call('update', { text }).catch(error => status(error.message, true)); }
  function setLanguage(value) { language = value; $('#language').value = value; if (sourceEditor) monaco.editor.setModelLanguage(sourceEditor.getModel(), value); }
  function detectLanguage(name) { const extension = name.split('.').pop().toLowerCase(); return ({ py: 'python', c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', f: 'fortran', for: 'fortran', f90: 'fortran', f95: 'fortran', f03: 'fortran', f08: 'fortran', html: 'html', htm: 'html', js: 'javascript', css: 'css', json: 'json', ipynb: 'json', md: 'markdown', sh: 'shell' })[extension] || 'plaintext'; }
  const editorOptions = () => ({ theme: 'vs-dark', automaticLayout: true, fontSize: 14, lineNumbers: 'on', folding: true, showFoldingControls: 'always', minimap: { enabled: false }, wordWrap: 'off', scrollBeyondLastLine: false, readOnly: documentInfo?.readOnly || !connected, renderWhitespace: 'selection', tabSize: 4 });
  const safeImage = source => /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(source || '');
  function sanitize(html, attachments = {}) {
    // Remove fetching attributes while DOMPurify's tree is still detached. An
    // untrusted image must never be inserted before its URL has been checked.
    DOMPurify.addHook('uponSanitizeAttribute', (_node, attribute) => {
      if (attribute.attrName !== 'src') return;
      if (attribute.attrValue.startsWith('attachment:')) {
        const data = attachments[attribute.attrValue.slice(11)];
        const mime = Object.keys(data || {}).find(key => /^image\/(png|jpeg|gif|webp)$/.test(key));
        if (mime) attribute.attrValue = `data:${mime};base64,${data[mime]}`;
      }
      if (!safeImage(attribute.attrValue)) attribute.keepAttr = false;
    });
    try { return DOMPurify.sanitize(html, { FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'svg', 'math', 'link', 'base', 'meta', 'video', 'audio', 'source'], FORBID_ATTR: ['style', 'srcset', 'background', 'poster'], ALLOW_DATA_ATTR: false }); }
    finally { DOMPurify.removeHook('uponSanitizeAttribute'); }
  }
  function cleanLinks(element) {
    element.querySelectorAll('img').forEach(img => { if (!/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(img.getAttribute('src') || '')) img.remove(); });
    element.querySelectorAll('a').forEach(link => { link.removeAttribute('target'); link.addEventListener('click', event => { event.preventDefault(); status(`链接：${link.getAttribute('href') || ''}。请在桌面浏览器中打开。`); }); });
  }
  function math(element) { renderMathInElement(element, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true }, { left: '$', right: '$', display: false }, { left: '\\(', right: '\\)', display: false }], throwOnError: false, trust: false }); }
  function markdown(element, text, attachments = {}) {
    element.innerHTML = sanitize(marked.parse(text), attachments);
    cleanLinks(element); math(element);
  }
  function renderOutput(element, output) {
    const text = value => Array.isArray(value) ? value.join('') : String(value || '');
    if (output.output_type === 'stream' || output.output_type === 'error') { const pre = document.createElement('pre'); pre.textContent = output.output_type === 'error' ? (output.traceback || [`${output.ename}: ${output.evalue}`]).join('\n').replace(/\x1b\[[0-9;]*m/g, '') : text(output.text); if (output.output_type === 'error') pre.className = 'error-output'; element.append(pre); return; }
    const data = output.data || {}, raster = Object.keys(data).find(key => /^image\/(png|jpeg|gif|webp)$/.test(key));
    if (raster && /^[a-z0-9+/=\s]+$/i.test(text(data[raster]))) { const img = document.createElement('img'); img.src = `data:${raster};base64,${text(data[raster])}`; img.alt = 'Notebook 输出图像'; element.append(img); }
    else if (data['text/html']) { const block = document.createElement('div'); block.innerHTML = sanitize(text(data['text/html'])); cleanLinks(block); math(block); element.append(block); }
    else if (data['text/markdown']) { const block = document.createElement('div'); markdown(block, text(data['text/markdown'])); element.append(block); }
    else if (data['text/latex']) { const block = document.createElement('div'); block.textContent = text(data['text/latex']); math(block); element.append(block); }
    else { const pre = document.createElement('pre'); pre.textContent = data['text/plain'] ? text(data['text/plain']) : '此输出类型不支持内嵌展示（例如交互式 Widget、SVG 或 JavaScript）；请在 Jupyter 网页中查看。'; element.append(pre); }
  }
  function showOutputs(cell, container) { container.replaceChildren(); for (const output of cell.outputs || []) renderOutput(container, output); }
  function renderNotebook() {
    notebookEditors.forEach(item => { item.editor.getModel().dispose(); item.editor.dispose(); }); notebookEditors = [];
    $('#notebook').replaceChildren();
    notebook.cells.forEach((cell, index) => {
      const id = cellId(cell), article = document.createElement('article'); article.className = 'cell'; article.dataset.cellId = id;
      const head = document.createElement('div'); head.className = 'cell-head';
      const title = document.createElement('span'); title.className = 'cell-type'; title.textContent = cell.cell_type === 'code' ? `代码 [${cell.execution_count ?? ' '}]` : cell.cell_type === 'markdown' ? 'Markdown / 公式' : '原始文本'; head.append(title);
      const button = (label, action, disabled = false) => { const control = document.createElement('button'); control.textContent = label; control.disabled = disabled; control.addEventListener('click', () => Promise.resolve(action()).catch(error => status(error.message, true))); head.append(control); return control; };
      if (cell.cell_type === 'code') button('▶ 执行', async () => {
        if (!kernelConnected) throw new Error('请先连接 Jupyter 服务并启动或选择内核。');
        cell.outputs = []; cell.execution_count = null; showOutputs(cell, output); title.textContent = '代码 [*]'; changed(); status('单元格执行中…');
        try { const result = await call('execute', { cellId: id, code: sourceText(cell) }); cell.execution_count = result.execution_count ?? null; title.textContent = `代码 [${cell.execution_count ?? ' '}]`; changed(); status(result.status === 'error' ? '执行出错，详情见单元格输出。' : '单元格执行完成。', result.status === 'error'); } catch (error) { title.textContent = '代码 [!]'; throw error; }
      }, !connected || documentInfo.readOnly);
      button('↑', () => { if (index > 0) { [notebook.cells[index-1], notebook.cells[index]] = [cell, notebook.cells[index-1]]; renderNotebook(); changed(); } }, documentInfo.readOnly || index === 0);
      button('↓', () => { if (index < notebook.cells.length-1) { [notebook.cells[index+1], notebook.cells[index]] = [cell, notebook.cells[index+1]]; renderNotebook(); changed(); } }, documentInfo.readOnly || index === notebook.cells.length-1);
      button('删除', () => { notebook.cells.splice(index, 1); renderNotebook(); changed(); }, documentInfo.readOnly);
      const source = document.createElement('div'); source.className = 'cell-source'; const rendered = document.createElement('div'); rendered.className = 'cell-markdown'; const output = document.createElement('div'); output.className = 'cell-output'; article.append(head, source, rendered, output); $('#notebook').append(article);
      const cellLanguage = cell.cell_type === 'markdown' ? 'markdown' : cell.cell_type === 'raw' ? 'plaintext' : (notebook.metadata?.language_info?.name || 'python');
      const editor = monaco.editor.create(source, { ...editorOptions(), value: sourceText(cell), language: cellLanguage, lineNumbersMinChars: 3 });
      editor.onDidChangeModelContent(() => { cell.source = editor.getValue(); if (cell.cell_type === 'markdown') markdown(rendered, sourceText(cell), cell.attachments); changed(); });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save().catch(error => status(error.message, true)));
      notebookEditors.push({ cell, editor, output, title });
      if (cell.cell_type === 'markdown') markdown(rendered, sourceText(cell), cell.attachments);
      showOutputs(cell, output);
    });
  }
  function loadDocument(value) {
    loading = true; documentInfo = value; notebook = null; dirty = false; $('#dirty').textContent = ''; $('#filePath').textContent = value.path; $('#readOnly').hidden = !value.readOnly; $('#save').disabled = value.readOnly || !connected;
    notebookEditors.forEach(item => { item.editor.getModel().dispose(); item.editor.dispose(); }); notebookEditors = [];
    if (/\.ipynb$/i.test(value.name)) { try { const parsed = JSON.parse(value.text); if (parsed.nbformat !== 4 || !Array.isArray(parsed.cells) || parsed.cells.some(cell => !cell || !['code','markdown','raw'].includes(cell.cell_type))) throw new Error('仅支持 nbformat 4 单元格结构'); notebook = parsed; } catch(error) { status(`Notebook 结构无效，已打开 JSON 源码：${error.message}`, true); } }
    $('#notebook').hidden = !notebook; $('#notebookToolbar').hidden = !notebook; $('#editor').hidden = Boolean(notebook); $('#language').disabled = Boolean(notebook); $('#htmlControls').hidden = !/\.html?$/i.test(value.name); $('#previewPanel').hidden = true; $('#workspace').dataset.mode = 'source';
    if (notebook) renderNotebook(); else { if (sourceEditor) sourceEditor.getModel().dispose(); const model = monaco.editor.createModel(value.text, detectLanguage(value.name)); if (!sourceEditor) { sourceEditor = monaco.editor.create($('#editor'), { ...editorOptions(), model }); sourceEditor.onDidChangeModelContent(changed); sourceEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save().catch(error => status(error.message, true))); } else sourceEditor.setModel(model); sourceEditor.updateOptions(editorOptions()); setLanguage(detectLanguage(value.name)); }
    $('#addCode').disabled = $('#addMarkdown').disabled = value.readOnly || !connected; loading = false;
  }
  async function save() { if (documentInfo.readOnly) throw new Error('无编辑权限，请另存为到可写位置。'); await call('update', { text: currentText() }); const saved = await call('save', { text: currentText() }); documentInfo = saved; changed(); status('已保存到服务器。'); }
  function ask(title, help, value, jupyter = false) { $('#inputTitle').textContent = title; $('#inputHelp').textContent = help; $('#inputLabel').textContent = jupyter ? '服务地址' : '远程绝对路径'; $('#inputValue').value = value; $('#tokenField').hidden = !jupyter; $('#jupyterToken').value = ''; $('#inputDialog').showModal(); $('#inputValue').focus(); return new Promise(resolve => { inputResolve = resolve; }); }
  $('#inputForm').addEventListener('submit', event => { event.preventDefault(); const value = $('#inputValue').value.trim(), token = $('#jupyterToken').value; $('#jupyterToken').value = ''; $('#inputDialog').close(); inputResolve?.({ value, token }); inputResolve = null; });
  $('#inputCancel').onclick = () => $('#inputDialog').close(); $('#inputDialog').addEventListener('close', () => { $('#jupyterToken').value = ''; if (inputResolve) { inputResolve(null); inputResolve = null; } });
  const bind = (id, action) => $(id).addEventListener('click', () => Promise.resolve(action()).catch(error => status(error.message, true)));
  bind('#save', save); bind('#saveAs', async () => { const result = await ask('另存为服务器文件', '输入新文件的完整路径。不会覆盖已经存在的文件。', documentInfo.path); if (!result) return; const saved = await call('saveAs', { path: result.value, text: currentText() }); loadDocument(saved); status('已另存为。'); });
  bind('#reload', async () => { const value = await call('reload'); if (value) { loadDocument(value); status('已重新载入远程文件。'); } });
  $('#language').onchange = () => setLanguage($('#language').value);
  async function refreshPreview() { const result = await call('preview', { root: previewRoot }); $('#preview').src = result.url; status(dirty ? '预览显示服务器已保存版本；请保存修改后刷新。' : '预览已刷新。'); }
  document.querySelectorAll('[data-mode]').forEach(button => { if (button.tagName !== 'BUTTON') return; button.onclick = async () => { const mode = button.dataset.mode; $('#workspace').dataset.mode = mode; $('#previewPanel').hidden = mode === 'source'; document.querySelectorAll('button[data-mode]').forEach(item => item.classList.toggle('selected', item === button)); if (mode !== 'source') try { await refreshPreview(); } catch(error) { status(error.message, true); } }; });
  bind('#refreshPreview', refreshPreview); bind('#previewRoot', async () => { const result = await ask('HTML 预览资源目录', '默认仅允许读取 HTML 所在目录。若页面引用 ../ 资源，可明确选择更上层的项目目录；该目录内资源会向本次预览开放。', previewRoot || documentInfo.path.slice(0, documentInfo.path.lastIndexOf('/')) || '/'); if (result) { previewRoot = result.value; await refreshPreview(); } });
  function addCell(type) { notebook.cells.push({ cell_type: type, id: `rd-${Date.now().toString(36)}-${++cellSequence}`, metadata: {}, source: '', ...(type === 'code' ? { outputs: [], execution_count: null } : {}) }); renderNotebook(); changed(); $('#notebook').lastElementChild?.scrollIntoView(); }
  bind('#addCode', () => addCell('code')); bind('#addMarkdown', () => addCell('markdown'));
  function kernelReady(value) { kernelConnected = value; for (const id of ['interruptKernel','restartKernel','shutdownKernel']) $(`#${id}`).disabled = !value; $('#kernelState').textContent = value ? '内核已连接' : '服务已连接 · 请选择内核'; }
  function showKernelInfo(info) { $('#kernelSpec').replaceChildren(...info.kernelspecs.map(item => new Option(item.displayName, item.name))); $('#runningKernel').replaceChildren(...info.kernels.map(item => new Option(`${item.name} · ${item.id.slice(0,8)}`, item.id))); $('#kernelSpec').disabled = $('#startKernel').disabled = !info.kernelspecs.length; $('#runningKernel').disabled = $('#attachKernel').disabled = !info.kernels.length; }
  bind('#connectJupyter', async () => { const result = await ask('连接服务器 Jupyter', '请求通过当前 SSH 连接发出，localhost 指服务器。先在服务器启动 Jupyter，再输入服务根地址及 Token；支持 JupyterLab 的基础路径。不会安装或自动启动服务。', 'http://127.0.0.1:8888/', true); if (!result) return; const info = await call('jupyterConnect', { endpoint: result.value, token: result.token }); result.token = ''; showKernelInfo(info); kernelReady(false); status('Jupyter 服务已连接。执行使用服务器内核，stdin 交互和交互式 Widget 请使用 Jupyter 网页。'); });
  bind('#startKernel', async () => { await call('kernelStart', { name: $('#kernelSpec').value }); kernelReady(true); showKernelInfo(await call('jupyterInfo')); });
  bind('#attachKernel', async () => { await call('kernelAttach', { id: $('#runningKernel').value }); kernelReady(true); });
  bind('#interruptKernel', async () => { await call('kernelInterrupt'); status('已向内核发送中断。'); });
  bind('#restartKernel', async () => { if (await call('kernelRestart')) { kernelReady(true); status('内核已重启。'); } });
  bind('#shutdownKernel', async () => { if (await call('kernelShutdown')) { kernelReady(false); showKernelInfo(await call('jupyterInfo')); } });
  window.workbench.onEvent(event => {
    if (event.type === 'saved') { documentInfo = event.document; $('#filePath').textContent = documentInfo.path; if (!loading) changed(); }
    if (event.type === 'disconnected') { connected = false; kernelReady(false); $('#kernelState').textContent = 'SSH 已断开'; $('#save').disabled = true; $('#notebookToolbar').querySelectorAll('button,select').forEach(item => { item.disabled = true; }); $('#notebook').querySelectorAll('button').forEach(item => { item.disabled = true; }); sourceEditor?.updateOptions({ readOnly: true }); notebookEditors.forEach(item => item.editor.updateOptions({ readOnly: true })); status('SSH 已断开，未保存内容仍保留在此窗口，可复制到本机。', true); }
    if (event.type === 'jupyterNotice') { status(event.error || 'Jupyter 状态已变化', true); if (event.error) kernelReady(false); }
    if (event.type === 'jupyterOutput') {
      const item = notebookEditors.find(value => cellId(value.cell) === event.cellId); if (!item) return;
      const outputType = event.outputType || event.messageType;
      // Manager preserves the Jupyter message type in outputType.
      if (outputType === 'clear_output') { if (event.content.wait) item.clearOnNext = true; else item.cell.outputs = []; }
      else {
        if (item.clearOnNext) { item.cell.outputs = []; item.clearOnNext = false; }
        if (outputType === 'update_display_data') { const displayId = event.content.transient?.display_id; const previous = item.cell.outputs.find(output => output.transient?.display_id === displayId); if (previous) previous.data = event.content.data; }
        else if (['stream','display_data','execute_result','error'].includes(outputType)) item.cell.outputs.push({ output_type: outputType, ...event.content });
      }
      showOutputs(item.cell, item.output); changed();
    }
  });
  require.config({ paths: { vs: '../media/workbench/vs' } });
  // Load the empty-resource NLS plugin before the editor dependency graph. This
  // avoids a race in Monaco 0.53's AMD bundle when parallel scripts finish first.
  require(['vs/nls.messages-loader'], () => require(['vs/editor/editor.main'], async () => {
    monaco.languages.register({ id: 'fortran', extensions: ['.f','.for','.f90','.f95','.f03','.f08'] });
    monaco.languages.setMonarchTokensProvider('fortran', { ignoreCase: true, keywords: ['program','module','subroutine','function','end','if','then','else','elseif','endif','do','while','enddo','select','case','where','forall','contains','use','implicit','none','integer','real','double','precision','complex','logical','character','type','class','allocate','deallocate','dimension','parameter','intent','in','out','inout','return','call','print','write','read','open','close','stop','cycle','exit','public','private','interface','procedure','result','recursive','pure','elemental'], tokenizer: { root: [[/!.*/, 'comment'], [/^\s*[cC*](?=\s).*/, 'comment'], [/'([^']|'')*'/, 'string'], [/"([^"]|"")*"/, 'string'], [/\b\d+(\.\d*)?([ed][+-]?\d+)?(_\w+)?\b/i, 'number'], [/\.[a-z]+\./i, 'operator'], [/[a-z_]\w*/i, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }], [/[=+*/<>:-]+/, 'operator']] } });
    monaco.languages.setLanguageConfiguration('fortran', { comments: { lineComment: '!' }, brackets: [['(',')'],['[',']']], autoClosingPairs: [{open:'(',close:')'},{open:'[',close:']'},{open:'"',close:'"'},{open:"'",close:"'"}], folding: { offSide: false, markers: { start: /^\s*!\s*#?region\b/i, end: /^\s*!\s*#?endregion\b/i } }, indentationRules: { increaseIndentPattern: /^\s*(?:(?:program|module|subroutine|function|do|select|type|interface)\b(?!\s*\()|if\b.*then\s*$)/i, decreaseIndentPattern: /^\s*(?:end(?:\s|$)|endif\b|enddo\b|else\b)/i } });
    monaco.languages.registerFoldingRangeProvider('fortran', { provideFoldingRanges(model) { const stack = [], ranges = []; for (let line = 1; line <= model.getLineCount(); line++) { const text = model.getLineContent(line).trim(); if (/^(?:end(?:\s|$)|enddo\b|endif\b|endselect\b)/i.test(text)) { const start = stack.pop(); if (start && line > start) ranges.push({ start, end: line }); } else if (/^(?:program|module(?!\s+procedure)|subroutine|(?:\w+\s+)?function|do|select\s+case|interface)\b|^if\b.*\bthen\s*$/i.test(text)) stack.push(line); } return ranges; } });
    try { const loaded = await call('load'); connected = loaded.connected; loadDocument(loaded.document); status(documentInfo.readOnly ? '无编辑权限，已只读打开。可搜索、复制或另存为。' : '已打开服务器文件。Ctrl+F 搜索，Ctrl+H 替换，Ctrl+S 保存。'); } catch(error) { status(error.message, true); }
  }, error => status(`编辑器加载失败：${error.message || error}`, true)), error => status(`编辑器加载失败：${error.message || error}`, true));
})();
