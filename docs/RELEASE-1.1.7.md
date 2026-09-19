# Remote Desktop App 1.1.7

日期：2026-09-20。本轮仅本地修改、测试、打包及提交，没有推送 GitHub，也没有操作用户当前桌面实例或生产服务器。修改前的回退点为 `checkpoint/pre-toolbox-login-1.1.6`。

## 本轮变更

1. 设置标题栏的最小化、最大化和关闭控件使用其它虚拟窗口相同的图标、尺寸和样式；传输中心右上角关闭按钮去掉强化边框和底色。内容按钮保留增强配色。
2. 应用面板更名“工具箱”，包含浏览器、传输中心、实时监听、htop、Monaco Editor、图片查看器及新视频播放器。
3. 视频播放器采用 Video.js 8.24.1，可通过虚拟资源管理器或双击文件打开。复用 SSH/SFTP 按范围读取，支持播放、暂停、seek、音量、倍速和全屏。关闭或断连会撤销临时媒体地址。具体格式和编码边界见 [VIDEO.md](VIDEO.md)。
4. 自动创建服务器 `~/.rdesktop/desktop`、`log` 和 `download`。旧版桌面偏好在首次升级时忽略一次，旧远程内容原样保留；新版在设置中重新选定任意目录后，后续连接仍恢复。日志及服务器默认下载位置固定，不随桌面位置变化。本机下载仍使用 Windows 的“下载”目录。
5. 监听默认显示全部活动，支持系统/终端与单次 CLI 筛选。保存实际 SSH 指令、终端原始输入及回复和逐条时间；CLI 原文保持独立日志，系统日志仅保留连接引用。SFTP 如实标明协议操作；二进制文件内容不进入文本日志。内部命令输出每流最多 256 KiB，超出明确记载截断，原命令的返回流不受影响。
6. 顶栏图标提示统一为模块名称。
7. 连接成功后的原生窗口标题为 `Remote Desktop - ssh 用户名@服务器IP:端口 别名`，无别名时省略。断开后恢复 `Remote Desktop`。
8. Ubuntu 风格登录卡片可切换已保存服务器，并在高级选项配置地址、端口、别名、私钥路径；用户名/密码直接在卡片编辑。保存的配置不含密码、私钥口令或私钥内容，切换服务器会清空密码和口令。

## 实际验证

以下均为本轮实际执行的测试分组；没有把历史记录计入本轮。各分组分别执行，没有声称单次运行了 `npm test`。

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 39 个源码文件通过语法检查 |
| `npm run test:backend` | 101/101，含远程目录初始化 16 项、配置/迁移 4 项 |
| `npm run test:modules` | 72/72，含日志、命令追踪及视频范围读取 |
| `npm run test:ui` | 42/42，真实桌面页面、无头 Chrome、替身 SSH API |
| `npm run test:workbench` | 11/11，Monaco/Notebook/HTML 回归 |
| `npm run test:vim` | 7/7，本机隔离的真实 Vim，非远程 Linux 验收 |
| 源码 Electron 集成 | 7/7：主应用、首次使用、完整视频、工作台、浏览器 2 项、CLI |
| `npm run test:video` | 1/1，真实 Video.js 与 Electron 生成的 VP8 WebM，SSH 读取、播放、暂停和 seek |
| 打包 EXE 集成 | 7/7，与上述主应用集成场景相同 |
| 包内核验 | 49 个应用文件、资源与许可证逐字节一致；另核验版本、入口和 Video.js 依赖 |
| `npm audit` | 0 个已知漏洞 |

首次使用场景从完全没有 `.rdesktop` 的隔离服务器目录开始，验证真实 SFTP 创建、旧桌面内容保留、配置切换清密码、保存文件无密码、窗口标题、服务器默认下载目录，以及监听窗口和远程日志内的指令、回复、时间。完整视频测试覆盖虚拟选择器、双击、真实播放/seek、窗口操作、关闭/断连撤销，并比较设置与播放器标题栏控件样式及顶栏提示。

服务器使用本机隔离 `ssh2.Server`，实际交换 SSH/SFTP 包，不等同用户 Ubuntu/OpenSSH、PAM/MFA、生产网络及 Unix 文件模式的实机验证。新目录传入 0700、日志文件传入 0600；Windows 测试不宣称验证 Linux 权限位落实。视频验证使用 VP8 WebM，不代表所有容器/编码均支持；没有服务器转码。

截图位于 `artifacts/packaged-login.png`、`packaged-toolbox.png`、`packaged-command-activity.png`、`packaged-video.png`。GUI 终端原始转录可能含用户在终端键入的敏感内容，日志具体边界见 [ACTIVITY_LOG.md](ACTIVITY_LOG.md)。

## 软件包

运行 `artifacts/electron-1.1.7/win-unpacked/Remote Desktop.exe`，保留同目录全部文件。这是 Windows x64 展开包，未发布安装器、未推送 GitHub。

构建命令：`npm.cmd run package -- --config.electronDist=node_modules/electron/dist`。

打包测试命令：

```powershell
$env:REMOTE_DESKTOP_TEST_EXE = (Resolve-Path 'artifacts/electron-1.1.7/win-unpacked/Remote Desktop.exe').Path
node --test test/electron.test.cjs test/first-use-electron.test.cjs test/video-app-electron.test.cjs test/workspace-electron.test.cjs test/browser-electron.test.cjs test/cli-packaged.test.cjs
```

SHA-256：

```text
Remote Desktop.exe
7f1cee395116872f10a565b3f31c9d225f8353a3f654b7384ed6d21c88f16a74

resources/app.asar
f8026ea74da840ea329ff17bc9a873683fc01b0ffb2837adee6565d7f8a5d833
```
