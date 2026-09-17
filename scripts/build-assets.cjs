'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules', 'lucide');
fs.copyFileSync(path.join(source, 'dist', 'umd', 'lucide.min.js'), path.join(root, 'media', 'lucide.js'));
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(root, 'media', 'lucide-LICENSE'));
for (const [packageName, files] of [
  ['xterm', { 'lib/xterm.js': 'xterm.js', 'css/xterm.css': 'xterm.css', 'LICENSE': 'xterm-LICENSE' }],
  ['addon-fit', { 'lib/addon-fit.js': 'xterm-addon-fit.js', 'LICENSE': 'xterm-addon-fit-LICENSE' }]
]) {
  for (const [from, to] of Object.entries(files)) {
    fs.copyFileSync(path.join(root, 'node_modules', '@xterm', packageName, from), path.join(root, 'media', to));
  }
}
