# Remote Desktop App 测试与验收

更新日期：2026-09-18。对象为 `remote-desktop-app` 1.0.0，基于 Electron 的独立应用。原扩展 0.0.7 的测试记录已保存在 [docs/extension-007-TESTING.md](docs/extension-007-TESTING.md)；其 Extension Host 与历史真实 SSH 结果不算本应用验收。

## 当前验证记录

| 检查 | 已观察到的结果 | 覆盖边界 |
| --- | --- | --- |
| `npm run check` | 通过 | 主进程、preload、SSH/文件服务、独立渲染器语法 |
| `npm run test:backend` | 49/49 通过（SSH 29 + 文件/配置服务 20） | ssh2 客户端与本机隔离 ssh2.Server 的 TCP 回环 SSH/SFTP；部分纯名称与恶意元数据测试使用注入替身 |
| `npm run test:ui` | 7/7 通过 | 真实 HTML/CSS/JS/xterm，Chrome 无头运行，Electron/SSH 边界为注入替身 |
| `npm run test:electron` | 1/1 集成场景通过 | 真实 Electron 44.4.2 主进程/preload/渲染器 + 本机 TCP 回环 SSH 服务端 |
| `npm run package` 与打包后 EXE 测试 | 打包成功；EXE 集成场景 1/1 通过 | Windows x64 展开目录；包内 12 个核心文件与源码字节一致 |
| `npm audit` | 0 vulnerabilities | 全部已安装生产/开发依赖，执行日期 2026-09-18 |
| 用户真实远程服务器 | 未执行 | 本轮未提供实机凭据，未操作现有 VS Code/SSH 窗口 |

UI 结果保存在 `artifacts/standalone-ui-results.json`，已检查 `standalone-connect.png`、`standalone-desktop.png`、`standalone-image.png`。这些截图来自替身 SSH API 的无头 UI，不是用户服务器截图。真实 Electron 和打包 EXE 的结果分别为 `artifacts/electron-results.json`、`artifacts/packaged-electron-results.json`。最终交付、修复及哈希见 [交付报告](artifacts/standalone-100-20260918.md)；早期后端交接报告的 28 项结果已经被本轮最终结果取代。

## 复现命令

```powershell
Set-Location 'C:\0_myfiles\new_projects\remote-desktop-app'
npm.cmd ci
npm.cmd run check
npm.cmd run test:backend
npm.cmd run test:ui
npm.cmd run test:electron
```

也可运行 `npm.cmd test`，按 check → backend → ui → electron 顺序执行。当前无头 UI 使用 `playwright.chromium.launch({ channel: 'chrome', headless: true })`，需要本机 Google Chrome；它启动独立测试进程，不接管已有浏览器。Electron 测试使用安装的 Electron 运行时，并移除子进程的 `ELECTRON_RUN_AS_NODE`。

后端与 Electron 测试使用系统临时目录及隔离的用户数据，不需要管理员权限、用户服务器密码或远程安装软件。Electron 通过 `--smoke-test` 隐藏测试窗口并配置独立 `--user-data-dir`，不覆盖用户日常应用设置。

打包与打包产物测试：

```powershell
npm.cmd run package
$env:REMOTE_DESKTOP_TEST_EXE = (Resolve-Path 'artifacts\electron\win-unpacked\Remote Desktop.exe').Path
npm.cmd run test:electron
Remove-Item Env:REMOTE_DESKTOP_TEST_EXE
```

`package` 仅生成 Windows 展开目录，不发布 GitHub、不上传安装包、不创建安装器。请保留目录内所有依赖文件。默认打包路径的存在、可执行文件 SHA-256 和测试结果应在交付前核对。

## 后端验证内容

`test/standalone-backend.test.cjs` 使用真实 ssh2 Client 与 ssh2.Server 在 127.0.0.1 交换 SSH/SFTP 包。远程文件由夹具映射到独立临时目录。覆盖：

- 密码认证、错误密码拒绝、固定主机指纹、未知主机确认/拒绝和已知主机变化拒绝；无效登录 HOME 拒绝，不回退到本机或 Demo。
- Desktop、desktop、桌面发现；缺失时明确状态，只有显式 create 请求才创建。
- 小文件 SSH `cat` 与大文件 SFTP 的真实分流、阈值配置和等于阈值边界、空文件、包含空格/中文/单引号的名称及 SHA-256 内容一致性。
- 递归目录、空目录、并发下载、同名目标保留；取消 SSH/SFTP 活跃传输、扫描前取消、传输失败后的暂存清理。
- 图片真实远程字节与格式/大小限制、配置优先级和未知字段保留。
- Windows 名称清洗、目录项路径注入和递归符号链接限制；相关不易由标准 SFTP 夹具自然产生的元数据通过明确的注入测试覆盖。

`test/desktop-service.test.cjs` 的 20 项覆盖 SFTP 创建、重命名、递归复制/移动、冲突、删除取消/确认、符号链接及断链、路径及链接目标边界、四级配置优先级、原子替换、外部修改保留、配置损坏拒绝、串行保存、稳定固定程序 ID 与重连恢复、服务器信息、真实 SSH PTY 数据/尺寸/关闭、读取后立即断连。`lib/sftp-stream.cjs` 等待远程 CLOSE 确认后才完成读取，修复了 EOF 后立刻断连导致异步未处理错误的问题。

服务端夹具可精确制造异常。其 POSIX rename 能力通过替换 SFTP VERSION 协商包公告，后续 EXTENDED 请求真实跨 SSH 传输；符号链接映射到临时树，PTY 使用受控回显，不执行任意系统命令。不能由此声称已验证外部 OpenSSH 的所有实现差异、网络设备、PAM/MFA 或真实 Linux TUI 行为。

## 无头 UI 验证内容

`test/standalone-ui.test.cjs` 载入真正 `app/index.html`、`desktop.js`、`desktop.css` 和 vendored 库，但 `window.remoteDesktop` 为替身。当前七个场景覆盖：

1. 连接失败时桌面为空，密码字段清空；连接成功显示真实协议提供的条目；旧 VS Code 快捷方式跳过；断连关闭窗口并拒绝迟到目录回复。
2. 目录地址导航、后退、窗口拖动、八向缩放入口、最大化/还原、最小化/恢复、多窗口关闭与任务栏状态。
3. 重命名、Ctrl 多选复制粘贴、Ctrl+Alt+T 与 xterm 终端关闭、普通文件 Vim 路由。
4. 图片初始适配、滚轮以指针局部为锚点的缩放、拖动平移、100%/适配，以及图片窗口生命周期。
5. 文件/目录右键下载、任务 ID、SFTP 进度、取消和最终完成状态。
6. 私钥选择只提交 privateKeyPath、禁止 renderer fetch 读取本地文件；应用阈值保存、系统下载目录展示、全屏快捷键。
7. 缺失桌面明确显示，用户点击确认前不发送 createDesktop。

UI 替身测试只证明渲染器行为与协议输出，不证明 SSH 后端或系统全屏已经实际执行。图片指针坐标因 Chromium 鼠标整数坐标舍入使用小于一个源图像素的容差。

## 隔离 Electron 进程测试

`test/electron.test.cjs` 通过 Playwright `_electron` 启动真实主进程及 preload，使用独立 userData 和 ssh2 回环夹具，不注入 renderer API 替身。测试设计检查：

- preload API 可用，renderer 无 `require`，BrowserWindow 初始 fullScreen 为 true。
- Settings 返回真正 `app.getPath('downloads')`；随后仅在测试进程中将下载目录切换到隔离夹具位置。
- 真实 IPC 连接与桌面发现、文件夹窗口、PNG 图片读取/缩放、SSH 小文件下载及本地内容一致。
- 固定 Shell/Vim、取消固定、退出全屏、断开清空、重连后配置持久化。
- Ctrl+Alt+T 通过真实 IPC 启动 SSH PTY；中文输入/输出、尺寸调整、关闭，以及普通文件 Vim 的真实 exec 请求参数。Vim 的服务端为受控回显，不计作服务器 Vim 编辑保存验收。
- 本地 settings.json 没有密码、私钥或口令字段，renderer 没有脚本错误。

测试开始时预置夹具已知主机指纹，以免自动化点击信任用户服务器。首次原生信任对话框的完整人工体验、系统菜单视觉和操作系统快捷键冲突不由本项覆盖。进程断言通过不等于用户实机远程验收。若设置 `REMOTE_DESKTOP_TEST_EXE`，同一测试改为启动打包目录中的 EXE。

## 外部 SSH 手动验收清单

下列为未来验收步骤，尚未执行；需使用用户提供且当前有效的凭据和授权测试目录。

1. 启动完整打包目录，确认全屏和连接窗口；核对主机指纹，分别验证正确密码/私钥/加密私钥、错误密码、取消信任和主机密钥变化拒绝。检查密码/口令不出现在 settings.json 或日志。
2. 由服务器终端确认登录 `$HOME`，应用自动打开其桌面，验证 Desktop/desktop/桌面优先级及缺失时取消/确认创建。不更改用户原桌面做破坏性测试。
3. 在授权测试目录完成创建、重命名、复制、移动、符号链接和取消/确认删除；检查同名保留、无权限错误、目录外符号链接拒绝和配置保留旧字段。
4. 运行真正远程 Shell/Vim/htop，输入中文、多行粘贴、调整尺寸、最小化、关闭待启动窗口；确认没有孤儿会话、脚本未自动运行。
5. 验证不同尺寸的栅格图片、滚轮局部放大、平移和恢复适配；超限/损坏图片要明确报错。
6. 在隔离下载目录验证小于、等于和大于阈值的文件，递归/空目录、同名、并发、Unicode/Windows 不合法名称；比对校验和。下载途中取消、断网、权限错误后检查未完成内容清理，预存文件仍完整。
7. 检查 Windows 系统 Downloads 重定向、显示缩放/多屏、F11/Esc/Ctrl+Alt+F、长期 SSH 断连与重连。完成后仅清理本轮明确创建的测试内容。

实际 SSH 测试结束后另写日期、服务器/系统、应用提交、测试目录、通过项和未覆盖项；不要引用旧扩展历史结果替代。
