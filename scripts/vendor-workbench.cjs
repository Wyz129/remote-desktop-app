'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'media', 'workbench');
fs.mkdirSync(target, { recursive: true });
for (const [source, destination] of [
  ['monaco-editor/min/vs', 'vs'], ['monaco-editor/LICENSE', 'monaco-LICENSE'],
  ['marked/lib/marked.umd.js', 'marked.js'], ['marked/LICENSE', 'marked-LICENSE'],
  ['dompurify/dist/purify.min.js', 'purify.js'], ['dompurify/LICENSE', 'dompurify-LICENSE'],
  ['katex/dist/katex.min.js', 'katex.js'], ['katex/dist/katex.min.css', 'katex.css'],
  ['katex/dist/contrib/auto-render.min.js', 'auto-render.js'], ['katex/dist/fonts', 'fonts'], ['katex/LICENSE', 'katex-LICENSE']
]) fs.cpSync(path.join(root, 'node_modules', source), path.join(target, destination), { recursive: true });
// Monaco 0.53's minified AMD chunks contain top-level `var` helpers outside
// their define() factory. Parallel file:// script loads otherwise overwrite
// one another before their factories run (for example css's helper becomes
// Object.defineProperty). Keep each AMD chunk's helpers private; loader and
// standalone worker entry points retain their original global bootstrap.
function isolateAmd(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) isolateAmd(filename);
    else if (entry.name.endsWith('.js') && entry.name !== 'loader.js') {
      const source = fs.readFileSync(filename, 'utf8');
      if (/\bdefine\("vs\//.test(source)) fs.writeFileSync(filename, `(function () {\n${source}\n}).call(globalThis);\n`);
    }
  }
}
isolateAmd(path.join(target, 'vs'));
console.log('Workbench browser assets copied.');
