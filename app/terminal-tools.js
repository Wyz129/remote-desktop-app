'use strict';
(() => {
  const MAX_TEXT = 60000;
  const MAX_LINES = 1200;
  function snapshot(terminal) {
    const buffer = terminal.buffer.active, lines = [];
    for (let index = Math.max(0, buffer.length - MAX_LINES); index < buffer.length; index++) {
      const line = buffer.getLine(index);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines.join('\n').trim().slice(-MAX_TEXT);
  }
  function looksFormatted(text) {
    return /(^|\n)\s{0,3}(#{1,6}\s|```|~~~|\|.+\|)|\*\*[^*\n]+\*\*|\\\[|\\\(|\$\$|(^|\n)\[\s*\n[\s\S]*?\\(?:frac|text|sum|operatorname|sqrt)/m.test(text);
  }
  function renderMarkdown(target, text) {
    const formulae = [], prefix = `RDESKTOPMATH${Math.random().toString(36).slice(2)}Z`;
    const token = (text, display) => { const placeholder = `${prefix}${formulae.length}END`; formulae.push({ text, display, placeholder }); return placeholder; };
    // Marked extensions preserve LaTeX backslashes before Markdown escaping.
    // Code spans/fences retain Marked's ordinary precedence and are never math.
    const parser = new marked.Marked({ extensions: [
      { name: 'terminalBlockMath', level: 'block', start: source => source.search(/(?:\$\$|\\\[|^\[\s*\n)/m), tokenizer(source) {
        const match = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:\n|$)/.exec(source);
        if (match) return { type: 'terminalBlockMath', raw: match[0], text: match[1] || match[2] };
        const legacy = /^\[\s*\n([\s\S]+?)\n\]\s*(?:\n|$)/.exec(source);
        if (legacy && /\\[a-zA-Z]+/.test(legacy[1])) return { type: 'terminalBlockMath', raw: legacy[0], text: legacy[1] };
      }, renderer: value => `<p>${token(value.text, true)}</p>` },
      { name: 'terminalInlineMath', level: 'inline', start: source => source.search(/\\\(|\$/), tokenizer(source) {
        const match = /^(?:\\\(([^\n]+?)\\\)|\$\$([^\n]+?)\$\$|\$(?!\s|\$)([^\n$]*?[^\s$])\$(?!\d))/.exec(source);
        if (match) return { type: 'terminalInlineMath', raw: match[0], text: match[1] || match[2] || match[3], display: Boolean(match[2]) };
      }, renderer: value => token(value.text, value.display) }
    ] });
    target.innerHTML = DOMPurify.sanitize(parser.parse(String(text).slice(-MAX_TEXT)), {
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'svg', 'math', 'link', 'base', 'meta', 'img', 'video', 'audio', 'source'],
      FORBID_ATTR: ['style', 'src', 'srcset', 'background', 'poster', 'href', 'id', 'name'], ALLOW_DATA_ATTR: false
    });
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT), nodes = [];
    while (walker.nextNode()) if (walker.currentNode.data.includes(prefix)) nodes.push(walker.currentNode);
    const pattern = new RegExp(`${prefix}(\\d+)END`, 'g');
    for (const node of nodes) {
      const fragment = document.createDocumentFragment(); let end = 0;
      for (const match of node.data.matchAll(pattern)) {
        const formula = formulae[Number(match[1])];
        fragment.append(document.createTextNode(node.data.slice(end, match.index)));
        const span = document.createElement('span');
        if (Number(match[1]) >= 100 || formula.text.length > 8192) span.textContent = formula.text;
        else {
          try { katex.render(formula.text, span, { displayMode: formula.display, throwOnError: false, trust: false, strict: 'warn', maxExpand: 1000, maxSize: 20 }); }
          catch { span.textContent = formula.text; }
        }
        fragment.append(span); end = match.index + match[0].length;
      }
      fragment.append(document.createTextNode(node.data.slice(end))); node.replaceWith(fragment);
    }
  }
  function attach({ terminal, element, api, onResize, onError, isActive }) {
    const surface = element.querySelector('.terminal-surface'), pane = element.querySelector('.terminal-reader'), content = element.querySelector('.terminal-reader-content');
    const toggle = element.querySelector('[data-terminal-reading]'), selected = element.querySelector('[data-terminal-selection]'), mode = element.querySelector('.terminal-reader-mode');
    let disposed = false, pastePending = false, forwardingMouse = false, autoOpened = false, manualMode = false, frozen = false, timer, previousText = '';
    const fail = error => { if (!disposed) onError(error?.message || String(error)); };
    async function paste() {
      if (disposed || !isActive() || pastePending) return;
      pastePending = true;
      try {
        const text = await api.readTerminalClipboard();
        if (!disposed && isActive() && typeof text === 'string' && text) terminal.paste(text);
      } catch (error) { fail(error); } finally { pastePending = false; }
    }
    async function copy() {
      const text = terminal.getSelection();
      if (!text) return;
      try { await api.writeTerminalClipboard(text); } catch (error) { fail(error); }
    }
    terminal.attachCustomKeyEventHandler(event => {
      const control = (event.ctrlKey || event.metaKey) && !event.altKey;
      const pasteKey = control && event.key.toLowerCase() === 'v' || event.shiftKey && !event.ctrlKey && !event.altKey && event.key === 'Insert';
      const copyKey = control && event.key.toLowerCase() === 'c' && (terminal.hasSelection() || event.shiftKey);
      if (!pasteKey && !copyKey) return true;
      event.preventDefault(); event.stopPropagation();
      if (event.type === 'keydown' && !event.repeat) void (pasteKey ? paste() : copy());
      return false;
    });
    function localSelection(event) {
      // xterm uses Shift to force selection when an application enables mouse
      // reporting. Default left dragging follows that public behavior; Ctrl+
      // drag deliberately leaves mouse events available to the remote TUI.
      if (forwardingMouse || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || terminal.modes.mouseTrackingMode === 'none') return;
      event.preventDefault(); event.stopImmediatePropagation(); forwardingMouse = true;
      try { event.target.dispatchEvent(new MouseEvent(event.type, { bubbles: true, cancelable: true, view: window, clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY, button: event.button, buttons: event.buttons, detail: event.detail, shiftKey: true, altKey: event.altKey })); }
      finally { forwardingMouse = false; }
    }
    surface.addEventListener('mousedown', localSelection, true);
    surface.title = '拖动选择文字；Ctrl+C 复制选区；Ctrl+V / Shift+Insert 粘贴；Ctrl+拖动操作远程鼠标';
    const stopKeys = event => event.stopPropagation(); surface.addEventListener('keydown', stopKeys);
    function show(value) {
      pane.hidden = !value; element.classList.toggle('terminal-reading', value); toggle.setAttribute('aria-pressed', String(value));
      onResize(); if (value) update();
    }
    function update() {
      if (disposed) return;
      selected.disabled = !terminal.hasSelection();
      if (frozen) return;
      const text = snapshot(terminal);
      if (!manualMode && !autoOpened && terminal.buffer.active.type !== 'alternate' && looksFormatted(text)) { autoOpened = true; show(true); return; }
      if (pane.hidden || text === previousText) return;
      const follow = content.scrollHeight - content.scrollTop - content.clientHeight < 65;
      previousText = text; renderMarkdown(content, text || '等待终端输出…');
      mode.textContent = terminal.buffer.active.type === 'alternate' ? '当前 TUI 屏幕 · 非完整对话' : '实时输出 · Markdown / LaTeX';
      if (follow) content.scrollTop = content.scrollHeight;
    }
    function schedule() { if (!timer) timer = setTimeout(() => { timer = undefined; update(); }, 180); }
    const write = terminal.onWriteParsed(schedule), selection = terminal.onSelectionChange(() => { selected.disabled = !terminal.hasSelection(); });
    toggle.addEventListener('click', () => { manualMode = true; frozen = false; show(pane.hidden); });
    selected.addEventListener('click', () => { const text = terminal.getSelection(); if (!text) return; manualMode = true; frozen = true; show(true); renderMarkdown(content, text); mode.textContent = '选区快照 · 点击 Live 返回实时输出'; });
    element.querySelector('[data-terminal-live]').addEventListener('click', () => { frozen = false; previousText = ''; update(); });
    element.querySelector('[data-terminal-reader-close]').addEventListener('click', () => { manualMode = true; show(false); });
    return { dispose() { disposed = true; clearTimeout(timer); write.dispose(); selection.dispose(); surface.removeEventListener('mousedown', localSelection, true); surface.removeEventListener('keydown', stopKeys); } };
  }
  window.RemoteTerminalTools = { attach, snapshot, looksFormatted, renderMarkdown };
})();
