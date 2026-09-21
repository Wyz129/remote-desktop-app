'use strict';
window.ActivityTranscript = (() => {
  function rawText(value) { return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2); }
  function groups(entries) {
    const cells = [], current = new Map();
    for (const entry of entries) {
      const raw = entry.raw || {}, type = entry.type;
      const key = `${entry.scope || ''}:${raw.operationId || raw.terminalId || entry.sessionId || entry.key}`;
      let cell = current.get(key);
      if (!cell) { cell = { key, time: entry.time, command: '', output: [], protocol: raw.protocol || (entry.scope === 'system' ? '' : 'CLI'), status: '', entryIds: [] }; current.set(key, cell); cells.push(cell); }
      cell.entryIds.push(entry.key);
      if (type === 'command' || type === 'terminal-command') cell.command += (cell.command ? '\n' : '') + rawText(raw.command || raw.args?.command || raw.args || entry.content);
      else if (type === 'terminal-input') cell.command += rawText(raw.data).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, value => `\\x${value.charCodeAt(0).toString(16).padStart(2, '0')}`);
      else if (['stdout', 'stderr', 'output', 'terminal-output'].includes(type)) cell.output.push({ stream: type === 'stderr' || raw.stream === 'stderr' ? 'stderr' : 'stdout', text: rawText(raw.data ?? entry.content) });
      else if (['end', 'terminal-exit', 'result'].includes(type)) {
        const result = raw.result ?? { code: raw.code, signal: raw.signal, error: raw.error }; cell.status = rawText(result);
        if (raw.error) cell.output.push({ stream: 'stderr', text: rawText(raw.error) });
      } else if (['error', 'terminal-error', 'output-truncated'].includes(type)) cell.output.push({ stream: 'stderr', text: rawText(raw.error || raw.message || entry.content) });
      else if (type === 'operation' && raw.protocol) {
        const request = Object.fromEntries(Object.entries(raw).filter(([name]) => !['operationId', 'type', 'protocol', 'source', 'scope', 'time', 'sessionId'].includes(name)));
        cell.command = `${raw.protocol}\n${JSON.stringify(request, null, 2)}`;
      } else if (type === 'request') cell.request = rawText(raw.args || raw.command || entry.content);
      else if (!cell.command && type !== 'progress') cell.request = rawText(raw.command || raw.args || entry.content);
    }
    for (const cell of cells) if (!cell.command && cell.request) cell.command = cell.request;
    return cells;
  }
  function safeHtml(value) { return DOMPurify.sanitize(value, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class', 'style'], ALLOW_DATA_ATTR: false }); }
  function render(container, entries, time) {
    const fragment = document.createDocumentFragment();
    for (const cell of groups(entries)) {
      const row = document.createElement('section'); row.className = 'activity-entry activity-cell'; row.dataset.entryId = cell.entryIds.at(-1); row.dataset.operationId = cell.key;
      const heading = document.createElement('div'); heading.className = 'activity-entry-heading'; heading.textContent = `${time(cell.time)}${cell.protocol ? ` · ${cell.protocol}` : ''}`; row.append(heading);
      if (cell.command) {
        const input = document.createElement('div'), label = document.createElement('span'), code = document.createElement('pre'); input.className = 'activity-cell-input'; label.className = 'activity-cell-prompt'; label.textContent = 'In'; code.className = 'activity-command';
        code.innerHTML = safeHtml(shellHighlight.highlight(cell.command, { language: 'bash', ignoreIllegals: true }).value); input.append(label, code); row.append(input);
      }
      if (cell.output.length) {
        const output = document.createElement('div'), label = document.createElement('span'), pre = document.createElement('pre'); output.className = 'activity-cell-output'; label.className = 'activity-cell-prompt'; label.textContent = 'Out';
        const ansi = { stdout: new AnsiUp(), stderr: new AnsiUp() }; ansi.stdout.escape_html = ansi.stderr.escape_html = true;
        for (const chunk of cell.output) { const span = document.createElement('span'); span.className = chunk.stream === 'stderr' ? 'activity-error-output' : 'activity-stdout'; span.innerHTML = safeHtml(ansi[chunk.stream].ansi_to_html(chunk.text)); pre.append(span); }
        output.append(label, pre); row.append(output);
      }
      if (cell.status) { const result = document.createElement('pre'); result.className = 'activity-result'; result.textContent = cell.status; row.append(result); }
      fragment.append(row);
    }
    container.replaceChildren(fragment);
  }
  return { groups, render };
})();
