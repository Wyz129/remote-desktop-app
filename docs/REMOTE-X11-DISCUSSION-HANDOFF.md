# Remote Desktop App：X11、Xvfb 与 xpra 实机验证交接

本文用于记录“在没有管理员权限、服务器没有可用桌面转发时，是否能通过用户目录搭建远程图形桌面”的实机检查结果、验证边界和集成架构。当前应用已经提供 X11 模式切换入口，并通过现有 SSH 连接按本文链路启动用户级会话。

## 目标与约束

- 目标服务器只能在用户目录安装组件，当前账号没有管理员权限。
- 服务器通过 Remote Desktop App 已有的 SSH 连接访问，不另开一条 SSH 连接，不读取密码、私钥或实例令牌。
- 目标是运行服务器上的 Linux 图形程序，并在 Windows Remote Desktop App 中显示和交互。
- 需要避免依赖服务器开放 X11 forwarding、RDP/VNC 公网端口或系统级桌面服务。
- 主项目已有 SSH CLI、虚拟桌面、文件传输和日志能力；后续应复用现有认证和连接，不让图形服务接触 SSH 凭据。

## 已确定的方向

完整 GNOME Shell 在 Windows 上没有成熟的原生移植路径，而且服务器端也没有 `gnome-shell`/`mutter`。更适合当前约束的路径是：

```text
用户目录中的 Xvfb
    ↓
服务器已有的 XFCE 会话
    ↓
xpra shadow/attach
    ↓
现有 SSH 连接上的本地端口转发
    ↓
Windows xpra 客户端或 HTML5 客户端
```

这条路径不依赖服务器当前 SSH 会话的 `DISPLAY`。Xvfb 自己创建一个虚拟 X11 显示器，xpra 传输这个显示器中的窗口，因此可以绕开当前 Xorg/物理控制台权限限制。

## 目标实例

实机检查使用的 Remote Desktop App 实例如下：

```text
instanceId: 7faed1d4-026b-44b9-a518-f7a2f8dc587c
host:       10.2.11.236
port:       50025
username:   yizhao.wang
home:       /home/yizhao.wang
desktop:    /home/yizhao.wang/.rdesktop/desktop
connected:  true
```

实例 ID 是应用进程句柄，后续操作前仍需执行 `list` 和 `status`，确认身份没有被切换。源 CLI 路径为：

```powershell
C:\0_myfiles\new_projects\remote-desktop-app\scripts\cli.cjs
```

所有远程检查均使用：

```powershell
node C:\0_myfiles\new_projects\remote-desktop-app\scripts\cli.cjs `
  --instance 7faed1d4-026b-44b9-a518-f7a2f8dc587c exec --json -- '命令'
```

## 服务器实机环境

检查结果：

- Ubuntu 23.10（Mantic Minotaur），内核 6.5.0-44-generic。
- `x86_64`，glibc 2.38。
- 当前账号 UID 1010，组为 `yizhao.wang` 和 `users`；没有免密 sudo。
- Home、`~/.rdesktop`、`~/.rdesktop/desktop`、`log`、`download`、`config` 和 `~/.local/bin` 均可写。
- Home 所在文件系统约 394 GB，总可用约 241 GB。
- 当前 SSH 非交互会话没有 `DISPLAY`、`WAYLAND_DISPLAY`、`XAUTHORITY`。
- `/tmp/.X11-unix/X0` 存在，但当前账号访问 `:0` 返回授权失败。
- `sshd -T` 显示 `X11Forwarding yes`，但已有 Remote Desktop App CLI 通道没有自动建立 X11 forwarding。
- Xorg 已安装，但直接启动受到 `Only console users are allowed to run the X server` 限制。
- X11 客户端库（`libX11`、`libxcb`、`libXrandr`、`libXrender`、`libXcomposite` 等）已经存在。

因此，准确结论是：

```text
X11 客户端库：有
SSH X11 forwarding 配置：有
当前会话可直接使用的 DISPLAY：没有
当前账号可直接启动的物理 Xorg：没有
用户级虚拟显示器：初始没有，已验证可由 Xvfb 提供
```

## 用户目录验证记录

验证目录保留在服务器：

```text
/home/yizhao.wang/.rdesktop/opt/x11-validation
```

下载并解包的版本：

| 组件 | 版本 | 状态 |
|---|---:|---|
| `xvfb` | `21.1.7-3ubuntu2.9` | 已解包并启动成功 |
| `xpra` | `3.1.5+dfsg1-0.2` | 已解包并启动成功 |
| `python3-rencode` | `1.0.6-2build3` | 已解包，用于完成 xpra 客户端握手 |

这些包没有使用 `apt install`、`dpkg -i` 或管理员权限，而是下载 `.deb` 后使用 `dpkg-deb -x` 解包到用户目录。

### Xvfb 与 XFCE 验证

使用普通账号启动：

```text
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -ac
dbus-run-session -- xfce4-session
```

实测结果：

- `/tmp/.X11-unix/X99` 成功创建。
- `DISPLAY=:99 xdpyinfo` 返回码为 0，并报告 X.Org 11.0、1280×800 显示器。
- `DISPLAY=:99 xset q` 返回码为 0。
- `xfce4-session`、`xfwm4`、`xfce4-panel`、`xfdesktop` 均成功运行。
- 没有遗留验证进程；验证结束后 `X99` 套接字已消失。

### xpra 验证

使用：

```text
xpra shadow :99 \
  --daemon=no \
  --bind-tcp=127.0.0.1:14500 \
  --socket-dir=$HOME/.rdesktop/opt/x11-validation/xpra-socket \
  --mdns=no \
  --html=off \
  --pulseaudio=no \
  --notifications=no \
  --opengl=no
```

实测结果：

- 日志出现 `xpra is ready`。
- 监听地址为 `127.0.0.1:14500`，没有开放公网端口。
- `xpra info tcp://127.0.0.1:14500/` 成功返回桌面能力，返回码为 0。
- `xpra screenshot ... tcp://127.0.0.1:14500/` 成功获取 1280×800 PNG，大小约 491759 字节。
- 截图显示真实 XFCE 桌面、面板、桌面图标和认证窗口，不是空白 X 服务器。
- 本机截图副本：`C:\Users\KunYu\AppData\Local\Temp\rdesktop-x11-validation\xpra-screenshot.png`。

这已经证明服务器端的 `Xvfb → XFCE → xpra` 链路成立，并且不依赖当前 SSH 会话的 X11 forwarding。

验证结束后已检查：没有残留 `Xvfb`、`xpra`、`:99` 套接字或 XFCE 验证进程。验证文件和解包组件仍保留在用户目录，便于下一步继续测试。

## 已安装的常用软件

### X11 与桌面基础

已发现的可执行入口：

```text
/usr/bin/Xorg
/usr/bin/xinit
/usr/bin/xauth
/usr/bin/xdpyinfo
/usr/bin/xrandr
/usr/bin/xprop
/usr/bin/xset
/usr/bin/xmessage
/usr/bin/xclock
/usr/bin/xeyes
/usr/bin/xfce4-session
/usr/bin/xfwm4
/usr/bin/xfdesktop
/usr/bin/xfce4-panel
/usr/bin/thunar
/usr/bin/xfce4-terminal
/usr/bin/startxfce4
/usr/bin/dbus-run-session
/usr/bin/dbus-launch
/usr/bin/xterm
/usr/bin/mousepad
/usr/bin/vim
/usr/bin/nano
/usr/bin/ristretto
/usr/bin/libreoffice
```

### 开发工具与运行时

已经存在：

```text
Python 3.11、GCC、G++、GFortran、Make、Git、Perl、CMake、Curl、Wget、Tar、Unzip、7-Zip
```

缺少：

```text
Node.js、npm、pip、Conda、Java、Rust、Go、Ruby、Emacs
```

`/snap/bin/firefox` 入口存在，但属于 Snap，尚未验证其在用户级 Xvfb 会话中的可用性。Snap 程序可能依赖系统级 snapd、沙盒和用户服务。

未发现可直接使用的 GNOME Shell、Mutter、Nautilus、GNOME Terminal、KDE Plasma、Konsole、Dolphin、Chromium、Google Chrome、VLC、mpv 和 ffplay。

## X11 软件兼容范围

通常适合：

- GTK 应用：Thunar、Mousepad、Ristretto、Gedit、Evince；
- Qt 应用：Kate、Okular、VLC、PCManFM-Qt；
- Electron、Chromium、Firefox，指定 X11 后端时通常可用；
- Java Swing/AWT、Python Tk、SDL 程序；
- 终端、编辑器、图片查看器、PDF 阅读器、普通视频播放器；
- XFCE、Openbox、Fluxbox 等轻量桌面或窗口管理器。

不能保证：

- 只支持 Wayland 的应用；
- GNOME Shell、Mutter、完整 KDE 等强依赖合成器、GPU、systemd/logind 的桌面；
- 依赖 DRM、GPU、摄像头、USB、物理音频设备或硬件视频解码的程序；
- 高性能 3D、游戏和 GPU 加速软件；
- 强依赖 Snap/Flatpak 沙盒和系统级服务的程序。

Ubuntu 23.10 上“能够安装”的软件不等于“能够在 Xvfb 中运行”。判断依据应是显示后端、硬件依赖、系统服务依赖和沙盒限制。

## 用户目录可安装的软件

### 已实际验证

以下方案已经在用户目录完成实际验证：

- `Xvfb`；
- `xpra`；
- `python3-rencode`。

### 包源中存在候选版本

当前 apt 索引中可见候选版本的软件包括：

```text
openbox
lxqt-session
pcmanfm
gedit
nautilus
vlc
mpv
ffmpeg
```

这些软件尚未全部解包和启动验证。Ubuntu 23.10 已进入旧版本归档，当前普通包源中的部分 URL 会返回 404；下载时需要使用 `old-releases.ubuntu.com`，并逐项检查依赖。

### 用户目录安装方式

用户可以：

1. 下载 tar.gz、AppImage 或便携版程序到 `~/.rdesktop/opt`；
2. 下载 `.deb` 后用 `dpkg-deb -x` 解包，不注册系统包；
3. 使用预编译 Node、浏览器或媒体播放器便携包；
4. 将脚本、启动器和配置放入 `~/.rdesktop/config`、`~/.rdesktop/opt/bin`。

用户不能完成：

- `apt install`、`dpkg -i`；
- 写入 `/usr`、`/etc`、`/run`；
- 注册 systemd 系统服务；
- 安装系统级 Snap/Flatpak；
- 直接使用受限的 Xorg；
- 取得 GPU、摄像头、USB 或物理音频设备的管理员权限。

## 本地客户端启动建议

正式集成应由 Remote Desktop App 使用已有 SSH 连接完成：

1. 通过 SSH CLI 检查并启动用户级 Xvfb 会话；
2. 用 `dbus-run-session` 启动 XFCE 或指定图形应用；
3. 启动 xpra，远端只绑定 `127.0.0.1`；
4. 在已有 SSH 连接上建立本地临时端口到远程 `127.0.0.1:14500` 的 direct-tcpip 转发；
5. 启动随应用打包的 Windows `xpra.exe`，连接 `tcp://127.0.0.1:<本地临时端口>/`；
6. 把 xpra 客户端窗口嵌入虚拟桌面窗口，或提供独立窗口模式；
7. 断开时关闭本地客户端和端口转发，按用户设置决定是否保留服务器会话。

手动测试原理可以写成：

```powershell
ssh -N -L 14500:127.0.0.1:14500 -p 50025 yizhao.wang@10.2.11.236
xpra.exe attach tcp://127.0.0.1:14500/
```

这段命令只说明协议关系，正式应用不应再建立第二条 SSH 连接，也不应让 xpra 读取私钥或密码。应用需要调用现有连接的端口转发能力。如果不打包原生 Windows xpra 客户端，也可以考虑 xpra HTML5/WebSocket 客户端，但原生窗口嵌入、快捷键和剪贴板体验通常较弱。

## 当前验证边界

已经验证：

- 普通用户可在用户目录运行 Xvfb；
- XFCE 可运行在 Xvfb 中；
- xpra 可附着 Xvfb 显示器；
- xpra 可通过回环 TCP 返回桌面信息和截图；
- 验证进程可在结束后清理。

尚未验证：

- Remote Desktop App 内的 SSH direct-tcpip 端口转发实现；
- Windows 原生 xpra 客户端打包和窗口嵌入；
- 从 Windows 到服务器的完整键盘、鼠标、剪贴板往返；
- xpra 会话断线重连、认证令牌和多实例管理；
- 浏览器、视频、GPU、打印机和音频的完整体验；
- 所有候选 `.deb` 在 Ubuntu 23.10 旧归档上的依赖闭包。

## 推荐后续顺序

1. 在应用中增加用户级图形会话管理器，固定使用 `~/.rdesktop/opt` 和 `~/.rdesktop/log`。
2. 实现现有 SSH 连接的本地端口转发，不开放远端公网端口。
3. 先打包一个最小 Windows xpra 客户端或验证 HTML5 客户端。
4. 以 XFCE、Thunar、XFCE Terminal、Mousepad、Ristretto 为第一批应用进行窗口嵌入测试。
5. 增加剪贴板、键盘布局、缩放、断线重连和日志记录。
6. 再逐项评估浏览器、视频播放器、Jupyter、Qt 和 Electron 应用。
7. 对需要系统服务、GPU 或 Wayland 的程序明确显示“不支持”或切换到现有 Web/RPC 方案。

## 应用内集成状态

- 登录界面中，切换账号按钮右侧的显示器符号用于选择 X11 模式；连接后再次点击可启动或停止 X11 会话。
- 主进程复用当前 `ssh2` 连接的 `forwardOut` 建立本机回环临时端口，不会创建第二条 SSH 连接，也不会把密码、私钥或实例令牌交给 xpra。
- 服务器端 Xvfb、XFCE 与 xpra 的运行目录为 `~/.rdesktop/x11/run`，日志目录为 `~/.rdesktop/log/x11`；xpra 只绑定远程 `127.0.0.1`。
- 组件查找同时覆盖系统安装、`~/.rdesktop/opt/bin` 以及本次服务器验证使用的 `~/.rdesktop/opt/x11-validation/root/usr/bin` 和 `xpra-root/usr/bin`；解包版 xpra 会自动加入对应的 Python 模块路径。
- 当前集成使用 xpra HTML5 页面嵌入虚拟桌面窗口。Windows 原生 xpra 客户端、完整剪贴板往返、断线重连策略和多实例并行仍需单独验证。
- X11 启动脚本使用 `remote-desktop-x11-v4`：启动前会检查用户级 xpra HTML5 包中的 `jquery.js`。如果解包产生失效符号链接，会从服务器现有的可读 JavaScript 包复制到用户目录；缺失时明确报错，不会再打开只有背景的假就绪页面。启动 xpra 后仍会轮询其进程和回环端口，只有端口真正可连接才返回 `ready` 与 `port=<实际端口>`。默认端口被占用时会在后续 20 个端口中选择可用端口；启动失败不会再误报就绪，管理器也会清理已启动的 Xvfb、XFCE 和 xpra 进程。
- 管理器在建立本机端口转发后会检查 xpra 根 HTML 以及其中所有同源 JavaScript/CSS 资源的 HTTP 状态、MIME、大小和内容；资源不完整时会关闭转发、停止远程会话并显示明确错误。这样不会把“端口已监听但网页脚本缺失”误报为可用桌面。
- 本地 CLI 增加 `rdesktop screenshot [本地 PNG 路径]`，通过实例接口截取应用主窗口，便于复查 X11 窗口和其他 UI；该操作不建立 SSH 连接，也不读取服务器凭据。
