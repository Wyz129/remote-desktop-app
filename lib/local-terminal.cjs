'use strict';
const path = require('node:path');
const childProcess = require('node:child_process');
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
const windowsQuote = value => `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;

// Node preserves the spelling of environment keys on Windows. Electron and
// launchers can therefore expose both `Path` and `PATH`, but PowerShell builds
// a case-insensitive environment dictionary and rejects that duplicate block.
// Keep one canonical key before starting the hidden PowerShell bootstrap.
function windowsEnvironment(source = process.env) {
  const environment = {}, pathEntries = [];
  for (const [key, value] of Object.entries(source)) {
    if (key.toLowerCase() === 'path') { pathEntries.push(String(value)); continue; }
    environment[key] = value;
  }
  if (pathEntries.length) environment.Path = pathEntries.find(value => value.length > 0) || pathEntries[0];
  environment.ELECTRON_RUN_AS_NODE = '1';
  return environment;
}

function launchLocalTerminal({ executable, cliPath, userDataDir, instanceId, cwd, identity }, spawnProcess = childProcess.spawn) {
  if (process.platform !== 'win32') throw new Error('此入口目前仅支持 Windows 本机终端；其它平台请运行 rdesktop shell。');
  for (const [name, value] of Object.entries({ executable, cliPath, userDataDir, instanceId, cwd, identity })) {
    if (typeof value !== 'string' || !value) throw new Error(`无法打开本机终端：${name} 参数无效。`);
  }
  const args = [cliPath, 'shell', '--instance', instanceId, '--user-data-dir', userDataDir, '--cwd', cwd, '--connection-id', identity];
  // All values are literal PowerShell strings. No SSH secrets or bridge tokens
  // are passed in command arguments; the CLI reads its protected local registry.
  const workingDirectory = path.dirname(executable);
  const script = `$ErrorActionPreference = 'Stop'; $Host.UI.RawUI.WindowTitle = 'RTerminal'; Start-Process -FilePath ${psQuote(executable)} -ArgumentList ${psQuote(args.map(windowsQuote).join(' '))} -WorkingDirectory ${psQuote(workingDirectory)} -NoNewWindow -Wait; Write-Host ''; Write-Host 'Remote session ended.'`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Direct detached spawn with ignored handles produces redirected stdin on
  // Windows. Start-Process allocates a fresh console with actual TTY handles.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const launcher = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; try { Start-Process -FilePath ${psQuote(powershell)} -ArgumentList @('-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', '${encoded}') -WorkingDirectory ${psQuote(workingDirectory)} -WindowStyle Normal } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(launcher, 'utf16le').toString('base64')], {
      cwd: workingDirectory,
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: windowsEnvironment()
    });
    let stderr = '';
    child.stderr?.on('data', chunk => {
      if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length);
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) return resolve({ opened: true });
      const detail = stderr.trim().replace(/\s+/g, ' ');
      reject(new Error(`无法启动本机终端（PowerShell 退出代码 ${code}）${detail ? `：${detail}` : '。'}`));
    });
  });
}
module.exports = { launchLocalTerminal, windowsEnvironment };
