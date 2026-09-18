'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const files = ['main.cjs','preload.cjs','workbench-preload.cjs','browser-preload.cjs', ...['lib','app','scripts'].flatMap(dir => fs.readdirSync(dir).filter(name => /\.(?:c?js)$/.test(name)).map(name => `${dir}/${name}`))];
for (const file of files) { const result = spawnSync(process.execPath, ['--check',file], { stdio:'inherit', windowsHide:true }); if(result.status !== 0) process.exit(result.status || 1); }
console.log(`Syntax checked: ${files.length} files`);
