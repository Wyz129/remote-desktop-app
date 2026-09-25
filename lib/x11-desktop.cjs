'use strict';

// User-level X11 desktop orchestration.  The manager deliberately knows
// nothing about credentials: all remote commands and channels use the active
// SshBackend connection supplied by the main process.
const net = require('node:net');
const path = require('node:path');
const { posixQuote } = require('./ssh-backend.cjs');
const { validateX11Html } = require('./x11-html.cjs');

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
  return `# remote-desktop-x11-v4
set -eu
root=${root}; run=${run}; log=${log}; display=${display}; port=${port}
mkdir -p -- "$run" "$log"
validation="$root/opt/x11-validation"
# Components unpacked in the validated user-level bundle take precedence over
# the system PATH; an administrator installation remains supported as fallback.
PATH="$root/opt/bin:$validation/xpra-root/usr/bin:$validation/root/usr/bin:$PATH"
PYTHONPATH="$validation/xpra-root/usr/lib/python3/dist-packages:$validation/xpra-root/usr/lib/python3:$validation/xpra-root/usr/lib/xpra${'${PYTHONPATH:+:$PYTHONPATH}'}"
export PATH PYTHONPATH
xvfb="$(command -v Xvfb 2>/dev/null || true)"
xfce="$(command -v xfce4-session 2>/dev/null || true)"
xpra="$(command -v xpra 2>/dev/null || true)"
dbus="$(command -v dbus-run-session 2>/dev/null || true)"
python="$(command -v python3 2>/dev/null || true)"
test -n "$xvfb" || { printf '%s\\n' '缺少远程 X11 组件：Xvfb（请检查 ~/.rdesktop/opt/x11-validation 或 ~/.rdesktop/opt/bin）' >&2; exit 127; }
test -n "$xfce" || { printf '%s\\n' '缺少远程 X11 组件：xfce4-session' >&2; exit 127; }
test -n "$xpra" || { printf '%s\\n' '缺少远程 X11 组件：xpra（及其 Python 模块）' >&2; exit 127; }
test -n "$dbus" || { printf '%s\\n' '缺少远程 X11 组件：dbus-run-session' >&2; exit 127; }
test -n "$python" || { printf '%s\\n' '缺少远程 X11 组件：python3' >&2; exit 127; }
"$xpra" --version >/dev/null 2>&1 || { printf '%s\\n' '远程 xpra Python 依赖不可用，请检查用户目录解包组件' >&2; exit 127; }

# Repair a dangling jquery.js link left by user-level dpkg extraction before serving HTML5.
web="$validation/xpra-root/usr/share/xpra/www"
jquery="$web/js/lib/jquery.js"
if test -d "$web/js/lib" && ! test -s "$jquery"; then
  jquery_source=''
  for candidate in "$validation/xpra-root/usr/share/javascript/jquery/jquery.js" /usr/share/javascript/jquery/jquery.js; do
    if test -r "$candidate" && test -s "$candidate"; then jquery_source="$candidate"; break; fi
  done
  test -n "$jquery_source" || { printf '%s\\n' 'Xpra HTML5 缺少 jquery.js，无法启用交互桌面' >&2; exit 127; }
  test ! -L "$jquery" || rm -f -- "$jquery"
  cp -- "$jquery_source" "$jquery"
fi
port_open() {
  "$python" - "$1" <<'PY'
import socket, sys
sock = socket.socket()
sock.settimeout(0.25)
try:
    sock.connect(('127.0.0.1', int(sys.argv[1])))
except OSError:
    raise SystemExit(1)
finally:
    sock.close()
PY
}
if test -f "$run/xvfb.pid" && kill -0 "$(cat -- "$run/xvfb.pid" 2>/dev/null)" 2>/dev/null; then :; else
  rm -f -- "$run/xvfb.pid"
  nohup "$xvfb" "$display" -screen 0 ${dimensions} -nolisten tcp -ac >"$log/xvfb.log" 2>&1 </dev/null & echo $! >"$run/xvfb.pid"
fi
for n in $(seq 1 40); do test -S "/tmp/.X11-unix/X${'${display#:}'}" && break; sleep 0.1; done
test -S "/tmp/.X11-unix/X${'${display#:}'}" || { printf '%s\\n' 'Xvfb 启动后未创建 X11 显示器' >&2; exit 1; }
if test -f "$run/xfce.pid" && kill -0 "$(cat -- "$run/xfce.pid" 2>/dev/null)" 2>/dev/null; then :; else
  rm -f -- "$run/xfce.pid"
  nohup env DISPLAY="$display" dbus-run-session -- "$xfce" >"$log/xfce.log" 2>&1 </dev/null & echo $! >"$run/xfce.pid"
fi
reuse_xpra=no
if test -f "$run/xpra.pid" && kill -0 "$(cat -- "$run/xpra.pid" 2>/dev/null)" 2>/dev/null && port_open "$port"; then reuse_xpra=yes; fi
if test "$reuse_xpra" != yes && port_open "$port"; then
  found_port=no
  for offset in $(seq 1 20); do
    candidate=$((port + offset))
    test "$candidate" -le 65535 || break
    if ! port_open "$candidate"; then port="$candidate"; found_port=yes; break; fi
  done
  test "$found_port" = yes || { printf '%s\\n' '没有可用的本地 X11 转发端口' >&2; exit 1; }
fi
if test "$reuse_xpra" != yes; then
  rm -f -- "$run/xpra.pid"
  nohup env DISPLAY="$display" "$xpra" shadow "$display" --daemon=no --bind-tcp="127.0.0.1:$port" --socket-dir="$run/xpra-socket" --mdns=no --html=on --pulseaudio=no --notifications=no --opengl=no >"$log/xpra.log" 2>&1 </dev/null & echo $! >"$run/xpra.pid"
fi
ready=no
for n in $(seq 1 40); do
  xpra_pid=$(cat -- "$run/xpra.pid" 2>/dev/null || true)
  if test -z "$xpra_pid" || ! kill -0 "$xpra_pid" 2>/dev/null; then break; fi
  if port_open "$port"; then ready=yes; break; fi
  sleep 0.25
done
test "$ready" = yes || { printf '%s\\n' 'xpra 启动后没有监听 HTML/WebSocket 端口' >&2; tail -30 "$log/xpra.log" >&2 || true; exit 1; }
printf 'ready\\nport=%s\\n' "$port"`;
}

function stopScript(values) {
  const run = posixQuote(values.run), display = posixQuote(values.display);
  return `# remote-desktop-x11-stop-v1\nset +e\nrun=${run}; display=${display}\nfor name in xpra xfce xvfb; do\n  file="$run/$name.pid"; test -f "$file" || continue; pid=$(cat -- "$file" 2>/dev/null); case "$pid" in ''|*[!0-9]*) ;; *) kill "$pid" 2>/dev/null || true; ;; esac; rm -f -- "$file"\ndone\nrm -rf -- "$run/xpra-socket"\nrm -f -- "/tmp/.X11-unix/X${'${display#:}'}" 2>/dev/null || true\nprintf 'stopped\\n'`;
}

class X11DesktopManager {
  constructor(backend, options = {}) {
    this.backend = backend;
    this.options = { ...DEFAULTS, ...options };
    this.validateHtml = options.validateHtml || validateX11Html;
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
    let output;
    try {
      output = await this.backend.execText(shellScript(values), 4096);
    } catch (error) {
      await this.backend.execText(stopScript(values), 4096).catch(() => {});
      throw error;
    }
    if (!/^ready[ \t]*$/m.test(output)) {
      await this.backend.execText(stopScript(values), 4096).catch(() => {});
      throw new Error('X11 桌面启动未返回就绪标记。');
    }
    const match = output.match(/^port=(\d+)\r?$/m);
    const remotePort = Number(match?.[1]);
    if (!Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535) {
      await this.backend.execText(stopScript(values), 4096).catch(() => {});
      throw new Error('X11 桌面返回了无效转发端口。');
    }
    let forwarding;
    try {
      forwarding = await this._openForward(remotePort);
      // A live port or a root HTML 200 alone does not mean the client can run.
      await this.validateHtml(`http://127.0.0.1:${forwarding.port}/`);
    } catch (error) {
      await forwarding?.close().catch(() => {});
      this.forward = null;
      await this.backend.execText(stopScript(values), 4096).catch(() => {});
      throw error;
    }
    this.state = { ...values, port: remotePort, remoteHost: '127.0.0.1', localPort: forwarding.port, url: `http://127.0.0.1:${forwarding.port}/`, startedAt: new Date().toISOString() };
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
