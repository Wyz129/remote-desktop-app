# Remote Desktop App 开发交接

更新日期：2026-09-21。独立应用版本：1.1.10。入口为 Electron `main.cjs`，不再依赖 VS Code。当前源码和用户的新要求优先于本文中的状态快照。

1.1.10：全桌面“程序”网格替代工具箱，十个内建入口、搜索、常用/全部、右键添加或移除收藏；左栏语义为收藏夹，按用户最终要求不显示栏标题和九点图标下方小字，保留悬停提示与可访问名称。收藏及使用次数由 lib/program-preferences.cjs 规范化，通过 app:program-preferences 固定 IPC 串行保存到本机 settings.json，不与远程 pinnedApps 混合；旧固定终端和动态窗口仍保留。更新偏好与重排网格时保持键盘焦点，移除最后一个收藏回到程序按钮。新增 app/programs.css、app/settings.css；设置分 desktop/files/system 三类，文件阈值表单移到 filesSettingsPanel，切换保留输入。窗口按钮默认透明、悬停显底色，保留 focus-visible。浏览器标签在地址栏之上，辅助选项默认折叠；可信工具栏上报 81–360px 的整数高度，主进程同步网页 bounds 与后台图像。回退分支 checkpoint/pre-programs-favorites-1.1.9；本地提交、打包，不推送。验证和交付入口见 docs/RELEASE-1.1.10.md。

1.1.9：炭灰/灰紫窗口主题，最小化/最大化/关闭 SVG 在 28px 控件中居中，符号尺寸分别 16/12/20px。登录样式迁至 app/login.css，普通登录保留头像与用户名/密码两框；切换账号进入 advanced，配置可保存返回登录或直接连接。connectionAdvanced 现为 section，不再是 details；测试应通过 switchAccountButton 进入高级界面，使用 advancedConnectSubmit 提交，普通登录仍用 connectSubmit。connected/reconnect 身份保护及不落盘密码保持。小高度窗口隐藏高级页重复标题并允许内部滚动。回退分支 checkpoint/pre-dark-login-1.1.8；本地提交与打包，仍不推送 GitHub。验证见 docs/RELEASE-1.1.9.md。

1.1.8：Monaco 改为虚拟桌面内的 opaque iframe，通过固定 IPC 桥接保存与关闭，断连保留草稿。lib/workbench-assets.cjs 为仅静态本地资源服务，iframe 允许脚本/表单但无同源权限，远程预览仍只有 allow-scripts。浏览器无遮挡时保持实时原生页面，遮挡时每 750ms 捕获背景图像，最小化停止；不能把该预览称为全帧率后台视频。已连接账号面板显示账号文本及断开/重连/切换账号，重连重新认证，不存密码。顶栏身份右移、传输双向图标、删除终端启动栏、Ubuntu 配色统一。回退分支 checkpoint/pre-embedded-workbench-1.1.7；本地提交与打包，仍不推送 GitHub。实际测试见 docs/RELEASE-1.1.8.md。

1.1.7：完成 Video.js 视频播放器与七项工具箱、Ubuntu 风格服务器登录和多配置切换、动态连接标题、统一窗口按钮及顶栏模块提示。首次连接自动建立 ~/.rdesktop/{desktop,log,download}；storageVersion=2 忽略旧桌面偏好，新版再次设置的位置仍恢复，不移动旧远程内容。密码和私钥口令不持久化。实时监听显示系统/终端及 CLI 的原始命令与回复；CLI 原文仍只写独立日志，系统仅保留连接引用。回退分支 checkpoint/pre-toolbox-login-1.1.6；本地提交、打包，不推送。详见 docs/RELEASE-1.1.7.md、docs/VIDEO.md 和 docs/ACTIVITY_LOG.md。下方旧版行为均作为历史快照，新版源码及本段优先。

新模块：lib/remote-storage.cjs 初始化远程路径；lib/server-profiles.cjs 校验配置、迁移桌面偏好并生成窗口标题；lib/command-trace.cjs 旁路记录 SSH 流；lib/video-service.cjs 提供 SSH 绑定的临时媒体范围读取；app/connection-profiles.js 管理登录表单；app/video-player.js/css 适配本地 Video.js。main/preload 完成固定 IPC 和连接生命周期集成。

1.1.6：仅设置与传输中心保留增强按钮配色，其余既有按钮回滚至 1.1.4；浏览器、Monaco CSS 与 435a4a4 完全一致。侧栏底部九点“应用”面板集合六个固定应用，移除 Monaco/图片的侧栏固定入口；支持搜索、键盘、断连状态与浏览器原生视图避让。显示名称统一为“浏览器”。视频方案仅探讨，没有安装或实现。回退分支 `checkpoint/pre-app-grid-1.1.5`；本地提交、打包，不推送。见 `docs/RELEASE-1.1.6.md`。

1.1.5：上传改为 Electron 原生文件多选，不再返回浮窗确认；删除旧 app/local-picker.*、PowerShell/Shell COM 脚本及打包资源。GUI 选择/拖放仅普通文件，UploadService 的 filesOnly 在规划阶段拒绝目录（防止选中后替换），CLI 递归目录上传保留。文本沿用微软 MIT Monaco Editor 0.53.0，公开文档明确 Fortran 适配与语言服务边界。统一桌面、工作台与浏览器工具栏按钮对比度，工作台 CSS 不覆盖 Monaco 内部控件。回退分支 `checkpoint/pre-native-upload-1.1.4`；仅本地提交与打包，不推送。详情见 `docs/RELEASE-1.1.5.md`。

1.1.4：传输中心改为上传/下载两按钮、按来源再目标选择、多选及双向拖放。`lib/transfer-center.cjs` 保存有上限的历史，`lib/transfer-targets.cjs` 校验本地选择授权及历史目标身份。文本/脚本统一 Monaco Editor，左侧增加 Monaco 和图片入口，支持未命名另存为与远程打开。图片使用 MIT Viewer.js 1.14.0；本地资源与许可证由 vendor 脚本打包。用户明确取消终端关闭保存提示，TerminalGuard 直接关闭 SSH 通道，Monaco 未保存确认继续保留。回退分支 `checkpoint/pre-transfer-editor-1.1.3`；本轮不推送。说明见 `docs/TRANSFERS.md`、`docs/WORKBENCH.md`、`docs/RELEASE-1.1.4.md`。下方旧版行为说明不覆盖此段与源码。

1.1.3 新增本地 CLI 自动通知、实时监听和服务器桌面 `.log`，分离 CLI/系统日志并记录 GUI 终端转录。Home 移到顶栏浏览器与设置之间，删除三个固定侧栏入口，保留动态窗口标签。新增 `lib/activity-log.cjs`（远程顺序写入、轮换、隔离与错误状态）、`lib/activity-audit.cjs`（系统操作摘要）。回退分支：`checkpoint/pre-audit-1.1.2`。说明见 `docs/ACTIVITY_LOG.md`，本轮交付见 `docs/RELEASE-1.1.3.md`。本轮不推送。

1.1.2 修正浏览器标题栏图标，并在本机 `C:\Users\KunYu\.codex\AGENTS.md` 增加 `远程桌面命令行操作规范.md` 索引，指导后续 Codex 复用已连接实例执行远程命令。全局文档不在仓库内；仍不推送 GitHub。该轮测试与打包记录见 `docs/RELEASE-1.1.2.md`。

本轮用户明确要求暂不推送 GitHub，必须等用户再次指令。1.1.1 在本地实现浏览器嵌入虚拟桌面及弹窗标签、Home 下固定浏览器、传输中心虚拟资源管理器选择路径，以及单实例方形设置窗口。回退分支为 `checkpoint/pre-desktop-windows-1.1.0`。最新测试记录见 `docs/RELEASE-1.1.1.md`，下方旧版记录保留作历史参考。

## 1. 仓库与工作边界

- 独立项目：`C:\0_myfiles\new_projects\remote-desktop-app`。
- 原扩展项目：`C:\0_myfiles\new_projects\remote-desktop`，保留不动。
- 克隆基线：原扩展 0.0.7，提交 `8c2e415f41759dca41d632c855347d539180e6ca`。
- 开发分支：`standalone-app`。`upstream` fetch 指向 `https://github.com/Wyz129/remote-desktop.git`；push 地址为 `DISABLED-UPSTREAM-PUSH`，不要恢复推送或把独立应用改动推到原 `main`。新私有仓库为 https://github.com/Wyz129/remote-desktop-app，origin 指向它；本地 standalone-app 推送到新仓库 main。
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
| `lib/terminal-guard.cjs` | Vim 保存/丢弃/取消确认、重复关闭去重，以及所有主动断开和应用退出的统一保护 |
| `lib/desktop-service.cjs` | 服务器完整文件系统访问、目录项适配、统一远程配置与串行保存、文件 CRUD/复制/符号链接、固定程序、服务器信息 |
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

SSH 登录成功后执行 `printf '%s' "$HOME"` 获取主目录；无效、相对或多行返回应失败。连接不要求 Node.js、VS Code Server 或桌面软件安装在远程。桌面发现优先 rdesktop、Desktop、desktop、桌面，先恢复按主机/端口/账号/指纹保存的任意路径；创建必须由用户点击确认，不能在初始化时自动写远程数据。

## 4. 前后端协议

前端入口为 `window.remoteDesktop`。`send(message)` 与 `onMessage(callback)` 保留原桌面的异步消息模型；主进程通过 `desktop:message` 回包。不要把主机消息暴露为 renderer 可伪造的 DOM `window.message` 事件。

| 前端请求/API | 后端返回或事件 |
| --- | --- |
| `connect(input)` | Promise `{username,host,home,hostFingerprint,verified}`；主进程另推 `remoteState`、`serverInfo` |
| `disconnect()` | 清理当前连接；推 `remoteState: disconnected` |
| `send({type:'ready'})` / `getServerInfo` | 当前远程桌面/服务器状态；未连接时不制造 ready 内容 |
| `readDirectory {path,requestId,windowId?,intent?}` | `remoteDirectory {path,requestId,entries|error}` |
| `refreshRemote {paths}` / `createDesktop` | 刷新当前桌面、载入配置、更新 `remoteState`；尚未选择时发现目录，`createDesktop` 是显式创建动作 |
| `fileOperation {operation,requestId,...}` | `operationResult {requestId,success,cancelled?,paths,affectedPaths,error?}` |
| `saveDesktopConfig {requestId?,config}` | `configSaved {requestId,ok,config|error}` |
| `pinApp {app:{label,program}}` / `unpinApp {id}` | 服务端生成稳定 ID，串行更新配置，推 `configUpdated` |
| `openTerminal {id,path,program,cols,rows,filePath?}` | `terminalOpened`、`terminalData`、`terminalExit`、`terminalError` |
| `terminalInput` / `terminalResize` / `terminalClose` | 对应 SSH PTY 写入、尺寸和关闭 |
| `toggleFullscreen` | `fullscreenResult` |
| `getSettings()` / `saveSettings(patch)` | 应用 downloadThreshold/scriptEditor 及系统 downloadsPath |
| `getSystemInfo()` | 固定只读查询的系统/磁盘/内存/网络/时间/语言信息，32 KiB 上限、8 秒超时 |
| `closeTerminal(id)` | 原生确认，成功后 `terminalClosed`；取消或失败返回 false 并保留窗口 |
| `image(path)` | `{mime,data,name}`，data 为 base64；不返回本地任意文件路径 |
| `download(path,id)` | 完成时 `{id,path,method,total}`；`onDownloadProgress` 提供 `{id,done,total,method,path,source}` |
| `cancelDownload(id)` | 取消对应任务；Promise 最终拒绝后显示取消状态 |

`remoteState` 的 ready 包含真实 rootPath/homePath/entries/config；missing/error/disconnected 明确处理。断连时前端关闭终端和图片、清空目录与请求缓存，迟到目录回复不能重建旧文件列表。目录请求沿用 requestId、窗口 pendingNavigation 和最新路径请求的关联，失败不提交新的导航历史。

## 5. 文件、配置、终端与图片

DesktopService 允许浏览和操作所有绝对路径，包含公共资源与外部符号链接，实际读写权限由服务器决定。对读取目标或写入父目录执行 SFTP realpath 检查，登录主目录、桌面根、`/` 及其上级目录不能整体修改。文件打开前以当前账号执行固定 test -r/-w 检查，不能用 mode 位推断权限；这些检查不保证远程并发权限修改期间没有 TOCTOU。

文件操作使用 SFTP 接口，创建独占、移动/重命名禁止覆盖；复制和快捷方式生成可用编号名称。永久删除先原生确认，递归删除不跟随符号链接。多项目操作不是完整事务：失败前已经完成的项目可能保留，不能提示用户“全部回滚”。桌面符号链接是真实远程链接，不是本地伪文件。

远程配置唯一业务入口是 DesktopService。读取优先级为 Desktop/.remote-desktop.json、Desktop/config.json、home/.config/remote-desktop/config.json、home/.remote-desktop.json；无效配置明确报告，最大 64 KiB。保存串行回读现有 JSON，只合并允许字段并保留未知字段/旧 shortcuts，使用独占临时文件。既有文件要求 OpenSSH posix-rename 原子替换；服务器不支持时应保留旧文件并提示失败。不要退回“删除旧文件后 rename”的有损方案。

前端跳过旧 VS Code 命令快捷方式并提供迁移说明；文件符号链接与固定的 shell/vim/htop 继续支持。`remoteDesktopDemo.*`、扩展 ID 和工作区/用户设置层不再控制独立应用。

xterm 连接 SSH PTY，白名单仅 shell/vim/htop；普通文件通过 Vim 编辑，不自动运行脚本。路径使用 POSIX 引用，最大 8 个会话、单次输入 64 KiB。关闭窗口要取消 pending 启动并结束会话；最小化不结束；重连/重开不自动启动。服务器未装 Vim/htop 时不自动安装。

1.0.2 的 Vim 关闭先由 TerminalGuard 询问保存/丢弃/取消，再使用 Ctrl-\\ Ctrl-N 与 `:wqa` / `:qa!`，等待真实退出码 0，超时不销毁会话。启动通过 `-c` 在用户 vimrc 后注册 VimEnter 的 `/dev/tty` 标记（Vim BEL 转义必须为 `\\x07`，不可用 `\\a`）；未收到标记时不向 E325 提示发送退出按键。旧 swap 不自动删除。Shell 中手动启动的 Vim 仅提供保守提示，用户在终端正常退出。此保护覆盖虚拟红叉、断开/重连、原生窗口红叉和 app.quit；断网与系统强杀无法保存。

任务栏 Home/设置为常驻内建入口，与 pinnedApps 无关。Home 使用 homePath，缺 Desktop 时仍可浏览；desktopAvailable 控制远程桌面配置保存。系统页仅展示可刷新的只读信息，SSH 连接管理与桌面/下载设置可操作。桌面刷新错误或路径变化不再销毁活跃编辑器。

图片以 base64 栅格字节传入 `<img>`，支持 PNG/JPEG/GIF/WebP/BMP/AVIF，最大 25 MiB。SVG 不支持。初始 contain（不放大小图）、滚轮锚点缩放、拖动平移和 fit/100%/加减按钮均在虚拟窗口中完成。图片迟到回包必须检查窗口仍存在。

## 6. 下载行为与约束

默认 50 MiB；单文件严格按 `< threshold → SSH exec cat`、`>= threshold → SFTP` 分流。目录全部使用递归 SFTP。SFTP 是 SSH 文件传输子系统。阈值为应用设置 1–1024 MiB；不能把相同后端路径只换标签称为分流。

默认根目录由主进程 `app.getPath('downloads')` 提供，后端没有 `os.homedir()/Downloads` 假设。下载开始就暴露任务 ID，先扫描总字节，再流式写入应用自有 mkdtemp 暂存目录，支持背压和取消。

提交单文件时优先硬链接独占提交，不支持时使用 COPYFILE_EXCL；目录先独占创建新目标再移动自有内容。同名、并发和 Windows 名称冲突生成编号；不能覆盖/合并/删除已有用户目标。取消、失败、断开会清理暂存内容；远程大小发生变化也会失败。

目录计划最大深度 128、项目数 100000。直接选择的目录链接可跟随；递归内部目录链接明确拒绝以避免循环，普通文件链接下载其内容，特殊文件拒绝。不承诺保持远程 Unix 权限、所有者、时间戳或符号链接结构；交付重点是文件内容、空目录及可在 Windows 使用的名称。

## 7. 验证状态与后续实机边界

最终 `npm test` 通过：后端 82/82、模块 30/30、真实本机 Vim 7/7、无头 UI 24/24、工作台 4/4、真实 Electron、工作区、浏览器和 CLI 集成均通过。`npm run package` 生成 Windows x64 展开目录，直接启动打包 EXE 的同一集成场景也 1/1 通过。包内 15 个核心文件及 3 个许可证与源码一致，`npm audit` 无已知漏洞。准确边界见 [TESTING.md](TESTING.md)，产物路径与 SHA-256 见 [交付报告](artifacts/standalone-110-20260919.md)。

本轮没有用户服务器凭据，没有外部 SSH 实机验收。回环夹具确实交换 SSH/SFTP 协议包并读写隔离的本地临时数据，但服务端仍是 ssh2.Server 受控夹具；它不等同 OpenSSH/PAM/MFA、真实服务器 TUI 或长期网络环境。

后续修改运行 npm test、npm run package，并通过 `REMOTE_DESKTOP_TEST_EXE` 指向展开目录中的 EXE 重跑隔离 Electron 测试。当前 Electron 为 44.4.2，应用入口 `artifacts/electron-1.1.0/win-unpacked/Remote Desktop.exe`；保留完整目录。产物未签名、未发布；历史交接中的中间测试数字不作为最终验收。

外部 SSH 后续复测使用用户授权的独立测试目录：首次指纹/私钥/口令认证，真实 `$HOME` 与桌面配置、Vim/htop 交互、大小文件/递归目录下载、取消/断网清理及系统 Downloads 重定向。不得为了测试清理或覆盖用户已有远程桌面、已知主机或下载文件。

## 1.1.0 补充交接

- `lib/desktop-preferences.cjs` 规范化桌面路径，以主机、端口、账号和已验证主机指纹隔离位置偏好；主进程保存在 userData/settings.json，不含凭据。
- `api.setDesktop(path)` 返回完整 ready state，由渲染器应用，不额外广播重复状态。切换与配置写入串行；15 秒截止覆盖排队和远程验证，进入本地保存阶段后等待实际提交结果。验证失败不改变原桌面。断连中断提交时主进程尝试恢复原本地偏好。
- 已保存桌面不可访问时保持 SSH 浏览状态，Home 和设置可用于恢复。路径切换不要求目标目录可写；同时修改外观时单独报告配置保存失败。
- `api.list(path)` 用于远程目录选择器；`api.checkFileAccess(path)` 提供实际读写结果，只读用应用内对话框确认；终端启动时再次检查。
- `lib/server-clock.cjs` 单次 date 快照校验 epoch/localTime/offset，标识优先 TZ、系统 zoneinfo、timezone，再按实际偏移回退。前端显示服务器 localtime 和时区标签，每 30 秒更新。
- 移除任务栏 +；默认显式新建 rdesktop，兼容已有 Desktop/desktop/桌面。
- Electron 回归包含公共根、权限拒绝恢复、只读文件、任意名称桌面、只读位置、刷新/重连/应用重启及已保存位置失效后的恢复。
