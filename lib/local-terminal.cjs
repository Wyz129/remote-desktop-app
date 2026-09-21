'use strict';
const path = require('node:path');
const childProcess = require('node:child_process');
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
const windowsQuote = value => `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;

function launchLocalTerminal({ executable, cliPath, userDataDir, instanceId, cwd, identity }, spawnProcess = childProcess.spawn) {
  if (process.platform !== 'win32') throw new Error('此入口目前仅支持 Windows 本机终端；其它平台请运行 rdesktop shell。');
  const args = [cliPath, 'shell', '--instance', instanceId, '--user-data-dir', userDataDir, '--cwd', cwd, '--connection-id', identity];
  // All values are literal PowerShell strings. No SSH secrets or bridge tokens
  // are passed in command arguments; the CLI reads its protected local registry.
  const script = `$ErrorActionPreference = 'Stop'; $Host.UI.RawUI.WindowTitle = 'RTerminal'; Start-Process -FilePath ${psQuote(executable)} -ArgumentList ${psQuote(args.map(windowsQuote).join(' '))} -NoNewWindow -Wait; Write-Host ''; Write-Host 'Remote session ended.'`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Direct detached spawn with ignored handles produces redirected stdin on
  // Windows. Start-Process allocates a fresh console with actual TTY handles.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const launcher = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; Start-Process -FilePath ${psQuote(powershell)} -ArgumentList @('-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', '${encoded}') -WindowStyle Normal`;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launcher, 'utf16le').toString('base64')], {
      stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve({ opened: true }) : reject(new Error(`无法启动本机终端（退出代码 ${code}）。`)));
  });
}
module.exports = { launchLocalTerminal };
