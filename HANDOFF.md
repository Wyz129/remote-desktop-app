# Remote Desktop App 开发交接

更新日期：2026-09-18。独立应用版本：1.0.0。入口为 Electron `main.cjs`，不再依赖 VS Code。当前源码和用户的新要求优先于本文中的状态快照。

## 1. 仓库与工作边界

- 独立项目：`C:\0_myfiles\new_projects\remote-desktop-app`。
- 原扩展项目：`C:\0_myfiles\new_projects\remote-desktop`，保留不动。
- 克隆基线：原扩展 0.0.7，提交 `8c2e415f41759dca41d632c855347d539180e6ca`。
- 开发分支：`standalone-app`。`upstream` fetch 指向 `https://github.com/Wyz129/remote-desktop.git`；push 地址为 `DISABLED-UPSTREAM-PUSH`，不要恢复推送或把独立应用改动推到原 `main`。没有新建或发布 GitHub 仓库。
- 全局规则索引来自用户 AGENTS 指引；编程前读取 `C:\Users\KunYu\.codex\编程守则.md`。默认简体中文、英文标识符、UTF-8。
- 用户已明确本阶段不使用“电脑操作”技能、不操作现有 VS Code/SSH 窗口。可使用隔离进程、回环 SSH 和无头浏览器验证。
- 历史地址 `10.2.11.236` 与用户名 `yizhao.wang` 仅为旧项目交接线索；本轮没有当前凭据，不能假定当前仍连接或复用历史成功记录。

原文档全文已保存到 `docs/extension-007-README.md`、`docs/extension-007-HANDOFF.md`、`docs/extension-007-TESTING.md`。原 `extension.js`、`remote-terminal.js`、`media/desktop.*` 和旧测试是迁移参考，不属于独立应用启动链；`media/lucide*`、`media/xterm*` 仍为打包所需静态依赖。

## 2. 运行与代码地图

安装依赖、启动、测试和打包见 [README.md](README.md)、[TESTING.md](TESTING.md)。开发依赖 Electron 44.4.2、Playwright 与 electron-builder；SSH 实现使用 ssh2。当前支持目标是 Windows 本地客户端和提供 SSH/SFTP、POSIX shell 的远程服务器。

| 文件 | 职责 |
| --- | --- |
| `main.cjs` | Electron 生命周期、全屏、安全窗口、IPC 入口、主机信任原生对话框、私钥读取、应用设置、DesktopService/SSH 会话组合 |
| `preload.cjs` | `contextBridge` 暴露固定的 `window.remoteDesktop` API；不暴露 Node、任意文件读取或任意 IPC |
| `lib/ssh-backend.cjs` | ssh2 连接、主机密钥验证、真实 `$HOME`、SFTP、图片字节、下载计划与流、取消/清理、SSH PTY |
| `lib/desktop-service.cjs` | 登录主目录边界、目录项适配、统一远程配置与串行保存、文件 CRUD/复制/符号链接、固定程序、服务器信息 |
| `lib/sftp-stream.cjs` | 等待 ssh2 的远程 CLOSE 确认，保证 EOF/finish 后立即断连不会遗留读写流错误 |
| `scripts/start-app.cjs` | 源码启动器；仅清除子进程的 ELECTRON_RUN_AS_NODE |
| `app/index.html` | 独立桌面 DOM、连接/设置/缺桌面对话框、资源管理器/终端/图片模板、下载面板 |
| `app/desktop.js` | 从旧桌面迁移的多窗口交互和消息协议，加上真实连接、图片缩放/平移、下载进度 |
| `app/desktop.css` | 原桌面样式与独立应用新增窗口样式 |
| `media/lucide*`、`media/xterm*` | 随包图标、终端库与许可证；不依赖 CDN |
| `test/standalone-backend.test.cjs` | 通过 TCP 回环 SSH/SFTP 夹具验证真实协议及本地文件结果；部分元数据/名称测试明确使用替身 |
| `test/desktop-service.test.cjs` | 文件操作、配置事务、路径边界、固定程序及真实 SSH PTY 协议测试 |
| `test/helpers/ssh-fixture.cjs` | `ssh2.Server` 隔离服务端和临时本地文件夹具，不是用户服务器 |
| `test/standalone-ui.test.cjs` | 无头 Chrome，真实 app HTML/CSS/JS/xterm，注入替身 Electron/SSH API |
| `test/electron.test.cjs` | 隔离用户数据的真实 Electron 主进程/preload/渲染器与回环 SSH 端到端测试 |
| `artifacts/` | 本机截图、JSON 验证结果、展开打包目录及文本报告；仅 Markdown 报告由 Git 跟踪 |

废弃的 `app/renderer.js`、`app/styles.css` 已删除。不要重新引用早期原型，也不要恢复 `acquireVsCodeApi` 或本地 Demo 数据。

## 3. 启动、连接与安全约束

BrowserWindow 启动全屏；`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`。阻止外部导航、新窗口和默认权限请求，主进程核验 IPC 发送者及入口页面。F11/顶栏按钮切换全屏，Esc 退出全屏，前端另支持 Ctrl+Alt+F。

连接窗口只提交 host、port、username、password、privateKeyPath、passphrase。选择私钥由原生文件对话框完成；主进程仅读取本次已选择的普通文件，最大 1 MiB，并在使用后清零读取 Buffer。渲染器不能 `fetch(file://...)` 读取私钥。应用设置只保留非敏感连接信息与主机指纹，不保存密码/私钥/口令。

未知主机通过原生对话框显式确认 SHA-256 指纹；拒绝时不得认证。已知主机按 host:port 严格匹配保存指纹；变化时失败，不自动重新信任。单次连接状态受到保护；失败、断开或重连都不能回退到 Demo。

SSH 登录成功后执行 `printf '%s' "$HOME"` 获取主目录；无效、相对或多行返回应失败。连接不要求 Node.js、VS Code Server 或桌面软件安装在远程。桌面发现优先 Desktop、desktop、桌面；创建必须由用户点击确认，不能在初始化时自动写远程数据。

## 4. 前后端协议

前端入口为 `window.remoteDesktop`。`send(message)` 与 `onMessage(callback)` 保留原桌面的异步消息模型；主进程通过 `desktop:message` 回包。不要把主机消息暴露为 renderer 可伪造的 DOM `window.message` 事件。

| 前端请求/API | 后端返回或事件 |
| --- | --- |
| `connect(input)` | Promise `{username,host,home,hostFingerprint,verified}`；主进程另推 `remoteState`、`serverInfo` |
| `disconnect()` | 清理当前连接；推 `remoteState: disconnected` |
| `send({type:'ready'})` / `getServerInfo` | 当前远程桌面/服务器状态；未连接时不制造 ready 内容 |
| `readDirectory {path,requestId,windowId?,intent?}` | `remoteDirectory {path,requestId,entries|error}` |
| `refreshRemote {paths}` / `createDesktop` | 重新发现、载入配置、更新 `remoteState`；`createDesktop` 是显式创建动作 |
| `fileOperation {operation,requestId,...}` | `operationResult {requestId,success,cancelled?,paths,affectedPaths,error?}` |
| `saveDesktopConfig {requestId?,config}` | `configSaved {requestId,ok,config|error}` |
| `pinApp {app:{label,program}}` / `unpinApp {id}` | 服务端生成稳定 ID，串行更新配置，推 `configUpdated` |
| `openTerminal {id,path,program,cols,rows,filePath?}` | `terminalOpened`、`terminalData`、`terminalExit`、`terminalError` |
| `terminalInput` / `terminalResize` / `terminalClose` | 对应 SSH PTY 写入、尺寸和关闭 |
| `toggleFullscreen` | `fullscreenResult` |
| `getSettings()` / `saveSettings(patch)` | 应用 downloadThreshold/scriptEditor 及系统 downloadsPath |
| `image(path)` | `{mime,data,name}`，data 为 base64；不返回本地任意文件路径 |
| `download(path,id)` | 完成时 `{id,path,method,total}`；`onDownloadProgress` 提供 `{id,done,total,method,path,source}` |
| `cancelDownload(id)` | 取消对应任务；Promise 最终拒绝后显示取消状态 |

`remoteState` 的 ready 包含真实 rootPath/homePath/entries/config；missing/error/disconnected 明确处理。断连时前端关闭终端和图片、清空目录与请求缓存，迟到目录回复不能重建旧文件列表。目录请求沿用 requestId、窗口 pendingNavigation 和最新路径请求的关联，失败不提交新的导航历史。

## 5. 文件、配置、终端与图片

DesktopService 将操作限制在登录主目录内，并对读取目标或写入父目录执行 SFTP realpath 检查。主目录、桌面根和 `/` 为受保护根。它是应用操作边界，不能宣称对远程并发改链等所有 TOCTOU 情况具有独立文件系统沙箱保证。

文件操作使用 SFTP 接口，创建独占、移动/重命名禁止覆盖；复制和快捷方式生成可用编号名称。永久删除先原生确认，递归删除不跟随符号链接。多项目操作不是完整事务：失败前已经完成的项目可能保留，不能提示用户“全部回滚”。桌面符号链接是真实远程链接，不是本地伪文件。

远程配置唯一业务入口是 DesktopService。读取优先级为 Desktop/.remote-desktop.json、Desktop/config.json、home/.config/remote-desktop/config.json、home/.remote-desktop.json；无效配置明确报告，最大 64 KiB。保存串行回读现有 JSON，只合并允许字段并保留未知字段/旧 shortcuts，使用独占临时文件。既有文件要求 OpenSSH posix-rename 原子替换；服务器不支持时应保留旧文件并提示失败。不要退回“删除旧文件后 rename”的有损方案。

前端跳过旧 VS Code 命令快捷方式并提供迁移说明；文件符号链接与固定的 shell/vim/htop 继续支持。`remoteDesktopDemo.*`、扩展 ID 和工作区/用户设置层不再控制独立应用。

xterm 连接 SSH PTY，白名单仅 shell/vim/htop；普通文件通过 Vim 编辑，不自动运行脚本。路径使用 POSIX 引用，最大 8 个会话、单次输入 64 KiB。关闭窗口要取消 pending 启动并结束会话；最小化不结束；重连/重开不自动启动。服务器未装 Vim/htop 时不自动安装。

图片以 base64 栅格字节传入 `<img>`，支持 PNG/JPEG/GIF/WebP/BMP/AVIF，最大 25 MiB。SVG 不支持。初始 contain（不放大小图）、滚轮锚点缩放、拖动平移和 fit/100%/加减按钮均在虚拟窗口中完成。图片迟到回包必须检查窗口仍存在。

## 6. 下载行为与约束

默认 50 MiB；单文件严格按 `< threshold → SSH exec cat`、`>= threshold → SFTP` 分流。目录全部使用递归 SFTP。SFTP 是 SSH 文件传输子系统。阈值为应用设置 1–1024 MiB；不能把相同后端路径只换标签称为分流。

默认根目录由主进程 `app.getPath('downloads')` 提供，后端没有 `os.homedir()/Downloads` 假设。下载开始就暴露任务 ID，先扫描总字节，再流式写入应用自有 mkdtemp 暂存目录，支持背压和取消。

提交单文件时优先硬链接独占提交，不支持时使用 COPYFILE_EXCL；目录先独占创建新目标再移动自有内容。同名、并发和 Windows 名称冲突生成编号；不能覆盖/合并/删除已有用户目标。取消、失败、断开会清理暂存内容；远程大小发生变化也会失败。

目录计划最大深度 128、项目数 100000。直接选择的目录链接可跟随；递归内部目录链接明确拒绝以避免循环，普通文件链接下载其内容，特殊文件拒绝。不承诺保持远程 Unix 权限、所有者、时间戳或符号链接结构；交付重点是文件内容、空目录及可在 Windows 使用的名称。

## 7. 验证状态与后续实机边界

最终 `npm test` 通过：后端 49/49（SSH 29、文件/配置服务 20）、无头 UI 7/7、真实 Electron 进程集成 1/1。`npm run package` 生成 Windows x64 展开目录，直接启动打包 EXE 的同一集成场景也 1/1 通过。包内 12 个核心文件与源码一致，`npm audit` 无已知漏洞。准确边界见 [TESTING.md](TESTING.md)，产物路径与 SHA-256 见 [交付报告](artifacts/standalone-100-20260918.md)。

本轮没有用户服务器凭据，没有外部 SSH 实机验收。回环夹具确实交换 SSH/SFTP 协议包并读写隔离的本地临时数据，但服务端仍是 ssh2.Server 受控夹具；它不等同 OpenSSH/PAM/MFA、真实服务器 TUI 或长期网络环境。

后续修改运行 npm test、npm run package，并通过 `REMOTE_DESKTOP_TEST_EXE` 指向展开目录中的 EXE 重跑隔离 Electron 测试。当前 Electron 为 44.4.2，应用入口 `artifacts/electron/win-unpacked/Remote Desktop.exe`；保留完整目录。产物未签名、未发布；历史交接中的中间测试数字不作为最终验收。

外部 SSH 后续复测使用用户授权的独立测试目录：首次指纹/私钥/口令认证，真实 `$HOME` 与桌面配置、Vim/htop 交互、大小文件/递归目录下载、取消/断网清理及系统 Downloads 重定向。不得为了测试清理或覆盖用户已有远程桌面、已知主机或下载文件。
