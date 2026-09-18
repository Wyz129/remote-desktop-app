#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const readline = require('node:readline');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { listInstances, requestInstance, defaultUserDataDir } = require('../lib/instance-bridge.cjs');

const HELP = `Remote Desktop 命令行（复用正在运行的桌面实例和 SSH 连接）
  rdesktop list | status | focus
  rdesktop launch [--exe "C:\\路径\\Remote Desktop.exe"]
  rdesktop connect --host HOST --username USER [--port 22] [--key PATH]
                   [--fingerprint SHA256:...] [--password-stdin] [--ask-passphrase]
  rdesktop upload LOCAL_PATH REMOTE_DIRECTORY
  rdesktop download REMOTE_PATH [LOCAL_DIRECTORY]
  rdesktop exec [--cwd REMOTE_DIRECTORY] [--timeout SECONDS] -- "REMOTE COMMAND"
  rdesktop cancel TASK_ID
全局选项：--instance ID  --user-data-dir PATH  --exe PATH  --json
未绑定私钥时交互输入密码（不回显）；重定向输入需显式 --password-stdin。
同一主机、端口和用户会复用已绑定私钥；--password-stdin 可改用密码。
不接受 --password/--passphrase 参数，不保存密码。未知主机在桌面窗口确认指纹。
exec 执行远程服务器 shell 命令，默认 30 秒，上限 300 秒、输出 4 MiB。
上传目录/大文件使用 SFTP，小文件使用 SSH 流；同名自动编号，不覆盖。
`;

function parseArgs(argv) {
  const args = [], options = {};
  const values = new Set(['instance', 'user-data-dir', 'exe', 'host', 'username', 'port', 'key', 'fingerprint', 'cwd', 'timeout']);
  const flags = new Set(['json', 'password-stdin', 'ask-passphrase', 'help']);
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--') { args.push(...argv.slice(index + 1)); break; }
    if (/^--(?:password|passphrase)(?:=|$)/.test(value)) throw new Error('密码与私钥口令不能写入命令行参数，请使用交互输入。');
    if (!value.startsWith('--')) { args.push(value); continue; }
    const name = value.slice(2);
    if (flags.has(name)) options[name] = true;
    else if (values.has(name)) { const next = argv[++index]; if (next === undefined || next.startsWith('--')) throw new Error(`缺少 --${name} 的值。`); options[name] = next; }
    else throw new Error(`不支持的选项：--${name.split('=')[0]}。密码仅可交互输入或使用 --password-stdin。`);
  }
  return { args, options };
}

async function readPassword(input, output, prompt, fromStdin = false) {
  if (fromStdin) return new Promise((resolve, reject) => {
    let value = ''; input.setEncoding('utf8');
    const cleanup = () => { input.off('data', data); input.off('end', end); input.off('error', error); input.pause(); };
    const finish = () => { cleanup(); resolve(value.replace(/\r?\n[\s\S]*$/, '')); };
    const data = chunk => { value += chunk; if (Buffer.byteLength(value) > 8192) { cleanup(); reject(new Error('密码输入过长。')); } else if (value.includes('\n')) finish(); };
    const end = () => finish(); const error = caught => { cleanup(); reject(caught); };
    input.on('data', data); input.once('end', end); input.once('error', error); input.resume();
  });
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('需要交互终端输入密码；管道输入请显式使用 --password-stdin。');
  output.write(prompt); readline.emitKeypressEvents(input);
  return new Promise((resolve, reject) => {
    const wasRaw = Boolean(input.isRaw); let value = '';
    input.setRawMode(true); input.resume();
    const cleanup = () => { input.off('keypress', keypress); input.setRawMode(wasRaw); input.pause(); output.write('\n'); };
    const keypress = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') { cleanup(); reject(Object.assign(new Error('已取消密码输入。'), { code: 'ABORT_ERR' })); }
      else if (key.name === 'return' || key.name === 'enter') { cleanup(); resolve(value); }
      else if (key.name === 'backspace') value = [...value].slice(0, -1).join('');
      else if (!key.ctrl && !key.meta && text) {
        value += text.replace(/[\r\n\0]/g, '');
        if (Buffer.byteLength(value) > 8192) { cleanup(); reject(new Error('密码输入过长。')); }
      }
    };
    input.on('keypress', keypress);
  });
}

async function launchInstance(options = {}, dependencies = {}) {
  const userDataDir = path.resolve(options['user-data-dir'] || defaultUserDataDir());
  let executable, args;
  if (options.exe) {
    executable = path.resolve(options.exe);
    if (!(await fs.stat(executable)).isFile()) throw new Error('应用程序路径必须是文件。');
    args = [];
  } else {
    const scriptDirectory = dependencies.scriptDirectory || __dirname;
    const packagedExecutable = path.resolve(scriptDirectory, '../../..', 'Remote Desktop.exe');
    let packaged = false;
    try { packaged = (await fs.stat(packagedExecutable)).isFile(); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    if (packaged) { executable = packagedExecutable; args = []; }
    else {
      try { executable = require('electron'); } catch { throw new Error('无法定位桌面程序，请提供 --exe 的完整路径。'); }
      if (typeof executable !== 'string') throw new Error('无法定位桌面程序，请提供 --exe 的完整路径。');
      args = [path.resolve(scriptDirectory, '..')];
    }
  }
  args.push(`--user-data-dir=${userDataDir}`);
  const environment = { ...process.env, REMOTE_DESKTOP_USER_DATA: userDataDir }; delete environment.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = (dependencies.spawn || spawn)(executable, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false, env: environment });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const instances = await (dependencies.listInstances || listInstances)(userDataDir);
    if (instances.length) return instances;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('已启动程序，但 30 秒内未获得实例接口；请检查桌面窗口。');
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.stdout || process.stdout, errorOutput = dependencies.stderr || process.stderr, input = dependencies.stdin || process.stdin;
  const { args, options } = parseArgs(argv); const command = args.shift();
  if (!command || options.help || command === 'help') { output.write(HELP); return 0; }
  if (!['list', 'launch', 'status', 'focus', 'connect', 'exec', 'upload', 'download', 'cancel'].includes(command)) throw new Error(`未知命令：${command}`);
  const userDataDir = path.resolve(options['user-data-dir'] || defaultUserDataDir());
  const find = dependencies.listInstances || listInstances;
  const request = dependencies.requestInstance || requestInstance;
  let instances = await find(userDataDir);
  if (command === 'list') {
    // Never print registry records: those contain local authentication tokens.
    const safe = instances.map(({ instanceId, pid, startedAt, status }) => ({ instanceId, pid, startedAt, status }));
    output.write(JSON.stringify(safe, null, 2) + '\n'); return 0;
  }
  if (command === 'launch' || (!instances.length && ['connect', 'focus'].includes(command))) {
    if (!instances.length) instances = await (dependencies.launchInstance || launchInstance)({ ...options, 'user-data-dir': userDataDir }, dependencies);
  }
  if (options.instance) instances = instances.filter(entry => entry.instanceId === options.instance);
  if (!instances.length) throw new Error('未找到运行中的实例。请先使用 launch 启动应用，或检查 --instance/--user-data-dir。');
  if (instances.length > 1) throw new Error('存在多个桌面实例，请使用 list 查看并用 --instance ID 指定。');
  const entry = instances[0]; let action = command, payload = {};
  if (command === 'launch') action = 'focus';
  if (command === 'connect') {
    payload = { host: options.host || entry.status?.host, username: options.username || entry.status?.username, port: Number(options.port || entry.status?.port || 22) };
    if (!payload.host || !payload.username) throw new Error('连接需要 --host 和 --username。');
    if (options.fingerprint) payload.hostKeyFingerprint = options.fingerprint;
    if (options.key && options['password-stdin']) throw new Error('--key 与 --password-stdin 不能同时使用。');
    const sameAccount = payload.host === entry.status?.host && payload.username === entry.status?.username && payload.port === Number(entry.status?.port || 22);
    const boundKey = !options['password-stdin'] && sameAccount ? entry.status?.privateKeyPath : null;
    if (options.key || boundKey) {
      payload.privateKeyPath = path.resolve(options.key || boundKey);
      if (options['ask-passphrase']) payload.passphrase = await (dependencies.readPassword || readPassword)(input, errorOutput, '私钥口令：');
    } else {
      if (options['ask-passphrase']) throw new Error('--ask-passphrase 需要 --key 或当前账户已绑定的私钥。');
      payload.password = await (dependencies.readPassword || readPassword)(input, errorOutput, 'SSH 密码：', Boolean(options['password-stdin']));
    }
  } else if (command === 'exec') {
    if (!args.length) throw new Error('exec 需要远程命令。');
    payload = { command: args.join(' ') };
    if (options.cwd) payload.cwd = options.cwd;
    if (options.timeout) payload.timeoutMs = Number(options.timeout) * 1000;
  } else if (command === 'upload') {
    if (args.length !== 2) throw new Error('upload 需要本地路径和远程目标目录。');
    payload = { id: crypto.randomUUID(), localPath: path.resolve(args[0]), remoteDirectory: args[1] };
  } else if (command === 'download') {
    if (!args.length || args.length > 2) throw new Error('download 需要远程路径，可另指定本地目标目录。');
    payload = { id: crypto.randomUUID(), remotePath: args[0], ...(args[1] ? { destination: path.resolve(args[1]) } : {}) };
  } else if (command === 'cancel') {
    if (args.length !== 1) throw new Error('cancel 需要任务 ID。'); payload = { id: args[0] };
  }
  const controller = new AbortController();
  const stop = () => controller.abort(); process.once('SIGINT', stop);
  try {
    let lastProgress = 0;
    if (payload.id && command !== 'cancel') errorOutput.write(`任务 ${payload.id}\n`);
    const result = await request(entry, action, payload, {
      timeoutMs: command === 'connect' ? 150000 : command === 'upload' || command === 'download' ? 24 * 60 * 60 * 1000 : 360000,
      signal: controller.signal,
      onProgress: value => {
        if (command === 'exec') return; // Final buffers preserve split UTF-8 sequences.
        if (options.json) errorOutput.write(JSON.stringify({ type: 'progress', ...value }) + '\n');
        else if (Date.now() - lastProgress > 300 || value.done === value.total) { lastProgress = Date.now(); errorOutput.write(`${value.method || ''} ${value.done || 0}/${value.total || 0} 字节\n`); }
      }
    });
    if (command === 'exec' && !options.json) { output.write(result.stdout || ''); errorOutput.write(result.stderr || ''); }
    else output.write(JSON.stringify(result ?? { ok: true }, null, 2) + '\n');
    return command === 'exec' ? (Number.isInteger(result.code) ? Math.min(255, Math.max(0, result.code)) : 1) : 0;
  } finally { delete payload.password; delete payload.passphrase; process.removeListener('SIGINT', stop); }
}

if (require.main === module) runCli().then(code => { process.exitCode = code; }, error => { process.stderr.write(`${error.message}\n`); process.exitCode = error.code === 'ABORT_ERR' ? 130 : 1; });
module.exports = { runCli, parseArgs, readPassword, launchInstance, HELP };
