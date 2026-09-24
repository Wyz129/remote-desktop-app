'use strict';

// User-level X11 desktop orchestration.  The manager deliberately knows
// nothing about credentials: all remote commands and channels use the active
// SshBackend connection supplied by the main process.
const net = require('node:net');
const path = require('node:path');
const { posixQuote } = require('./ssh-backend.cjs');

const DEFAULTS = Object.freeze({ display: ':99', port: 14500, width: 1280, height: 800, depth: 24 });

function integer(value, fallback, min, max) {
  const result = Number(value);
  return Number.isInteger(result) && result >= min && result <= max ? result : fallback;
}

function remoteRoot(backend) {
  if (!backend?.home || typeof backend.home !== 'string' || !backend.home.startsWith('/')) throw new Error('SSH 主目录不可用。');
  return path.posix.join(backend.home, '.rdesktop');
}

function shellScript(values) {
  const root = posixQuote(values.root), run = posixQuote(values.run), log = posixQuote(values.log);
  const display = posixQuote(values.display), dimensions = posixQuote(`${values.width}x${values.height}x${values.depth}`);
  const port = String(values.port);
  // Commands are discovered on the remote host so packaged binaries under
  // ~/.rdesktop/opt/bin work alongside distribution packages.
  return `# remote-desktop-x11-v2\nset -eu\nroot=${root}; run=${run}; log=${log}; display=${display}; port=${port}\nmkdir -p -- "$run" "$log"\nvalidation="$root/opt/x11-validation"\n# Components unpacked in the validated user-level bundle take precedence over\n# the system PATH; an administrator installation remains supported as fallback.\nPATH="$root/opt/bin:$validation/xpra-root/usr/bin:$validation/root/usr/bin:$PATH"\nPYTHONPATH="$validation/xpra-root/usr/lib/python3/dist-packages:$validation/xpra-root/usr/lib/python3:$validation/xpra-root/usr/lib/xpra${'${PYTHONPATH:+:$PYTHONPATH}'}"\nexport PATH PYTHONPATH\nxvfb="$(command -v Xvfb 2>/dev/null || true)"\nxfce="$(command -v xfce4-session 2>/dev/null || true)"\nxpra="$(command -v xpra 2>/dev/null || true)"\ndbus="$(command -v dbus-run-session 2>/dev/null || true)"\ntest -n "$xvfb" || { printf '%s\\n' '缺少远程 X11 组件：Xvfb（请检查 ~/.rdesktop/opt/x11-validation 或 ~/.rdesktop/opt/bin）' >&2; exit 127; }\ntest -n "$xfce" || { printf '%s\\n' '缺少远程 X11 组件：xfce4-session' >&2; exit 127; }\ntest -n "$xpra" || { printf '%s\\n' '缺少远程 X11 组件：xpra（及其 Python 模块）' >&2; exit 127; }\ntest -n "$dbus" || { printf '%s\\n' '缺少远程 X11 组件：dbus-run-session' >&2; exit 127; }\n"$xpra" --version >/dev/null 2>&1 || { printf '%s\\n' '远程 xpra Python 依赖不可用，请检查用户目录解包组件' >&2; exit 127; }\nif test -f "$run/xvfb.pid" && kill -0 "$(cat -- "$run/xvfb.pid" 2>/dev/null)" 2>/dev/null; then :; else\n  rm -f -- "$run/xvfb.pid"\n  nohup "$xvfb" "$display" -screen 0 ${dimensions} -nolisten tcp -ac >"$log/xvfb.log" 2>&1 </dev/null & echo $! >"$run/xvfb.pid"\nfi\nfor n in $(seq 1 40); do test -S "/tmp/.X11-unix/X${'${display#:}'}" && break; sleep 0.1; done\ntest -S "/tmp/.X11-unix/X${'${display#:}'}" || { printf '%s\\n' 'Xvfb 启动后未创建 X11 显示器' >&2; exit 1; }\nif test -f "$run/xfce.pid" && kill -0 "$(cat -- "$run/xfce.pid" 2>/dev/null)" 2>/dev/null; then :; else\n  rm -f -- "$run/xfce.pid"\n  nohup env DISPLAY="$display" dbus-run-session -- "$xfce" >"$log/xfce.log" 2>&1 </dev/null & echo $! >"$run/xfce.pid"\nfi\nif test -f "$run/xpra.pid" && kill -0 "$(cat -- "$run/xpra.pid" 2>/dev/null)" 2>/dev/null; then :; else\n  rm -f -- "$run/xpra.pid"\n  nohup env DISPLAY="$display" "$xpra" shadow "$display" --daemon=no --bind-tcp=127.0.0.1:${port} --socket-dir="$run/xpra-socket" --mdns=no --html=on --pulseaudio=no --notifications=no --opengl=no >"$log/xpra.log" 2>&1 </dev/null & echo $! >"$run/xpra.pid"\nfi\nprintf 'ready\\n'`;
}

function stopScript(values) {
  const run = posixQuote(values.run), display = posixQuote(values.display);
  return `# remote-desktop-x11-stop-v1\nset +e\nrun=${run}; display=${display}\nfor name in xpra xfce xvfb; do\n  file="$run/$name.pid"; test -f "$file" || continue; pid=$(cat -- "$file" 2>/dev/null); case "$pid" in ''|*[!0-9]*) ;; *) kill "$pid" 2>/dev/null || true; ;; esac; rm -f -- "$file"\ndone\nrm -rf -- "$run/xpra-socket"\nrm -f -- "/tmp/.X11-unix/X${'${display#:}'}" 2>/dev/null || true\nprintf 'stopped\\n'`;
}

class X11DesktopManager {
  constructor(backend, options = {}) {
    this.backend = backend;
    this.options = { ...DEFAULTS, ...options };
    this.state = null;
    this.forward = null;
  }

  _requireBackend() {
    if (!this.backend?.connected || !this.backend.client) throw new Error('SSH 尚未连接。');
    return this.backend;
  }

  _values(input = {}) {
    const display = typeof input.display === 'string' && /^:[0-9]+$/.test(input.display) ? input.display : this.options.display;
    const port = integer(input.port, this.options.port, 1024, 65535);
    const width = integer(input.width, this.options.width, 640, 7680);
    const height = integer(input.height, this.options.height, 480, 4320);
    const depth = integer(input.depth, this.options.depth, 8, 32);
    const root = remoteRoot(this.backend);
    return { root, run: path.posix.join(root, 'x11', 'run'), log: path.posix.join(root, 'log', 'x11'), display, port, width, height, depth };
  }

  async start(input = {}) {
    this._requireBackend();
    const values = this._values(input);
    if (this.state) await this.stop();
    const output = await this.backend.execText(shellScript(values), 4096);
    if (!/^ready\s*$/m.test(output)) throw new Error('X11 桌面启动未返回就绪标记。');
    let forwarding;
    try { forwarding = await this._openForward(values.port); }
    catch (error) { await this.backend.execText(stopScript(values), 4096).catch(() => {}); throw error; }
    this.state = { ...values, remoteHost: '127.0.0.1', localPort: forwarding.port, url: `http://127.0.0.1:${forwarding.port}/`, startedAt: new Date().toISOString() };
    return this.status();
  }

  async stop() {
    const state = this.state;
    if (this.forward) await this.forward.close().catch(() => {});
    this.forward = null; this.state = null;
    if (!state || !this.backend?.connected) return { stopped: true };
    await this.backend.execText(stopScript(state), 4096).catch(() => {});
    return { stopped: true };
  }

  status() { return this.state ? { active: true, ...this.state } : { active: false }; }

  async _openForward(remotePort) {
    const backend = this._requireBackend();
    const client = backend.client, sockets = new Set();
    let closed = false;
    const server = net.createServer(socket => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
      const finish = (error, channel) => {
        if (error || closed || !backend.connected || backend.client !== client) { socket.destroy(); channel?.destroy(); return; }
        sockets.add(channel); channel.on('error', () => socket.destroy()); channel.on('close', () => socket.destroy());
        socket.once('close', () => channel.destroy()); socket.pipe(channel); channel.pipe(socket);
      };
      try { client.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, finish); }
      catch (error) { finish(error); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const forwarding = { port: server.address().port, close: async () => {
      if (closed) return; closed = true; for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    } };
    this.forward = forwarding;
    return forwarding;
  }
}

module.exports = { X11DesktopManager, shellScript, stopScript, DEFAULT_X11_DESKTOP: DEFAULTS };
