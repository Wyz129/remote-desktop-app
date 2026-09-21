# 1.1.13 本地交付

日期：2026-09-21。Windows x64 独立应用，本轮不推送 GitHub。回退检查点为 `checkpoint/pre-terminal-transfer-1.1.12`。

程序：`artifacts/electron-1.1.13/win-unpacked/Remote Desktop.exe`。保留整个 `win-unpacked` 目录；本版仍为展开包，不是安装器。

## 本机终端

连接 SSH 后，右键左侧快捷栏的图标、运行窗口标签或空白处 → **打开本机终端**。资源管理器目录空白右键也提供入口。新终端在 Windows 控制台打开，通过当前实例的本地命名管道转发到现有 SSH PTY，无需重新认证或安装额外 Node.js。

命令和回复实时显示；目录变化和会话状态可持续保持，支持中文、ANSI、尺寸变化与 Ctrl+C。Ctrl+] 仅结束当前终端，桌面 SSH 保持。断开桌面连接或切换账号会结束相应终端。启动参数不含 SSH 密码或本地接口令牌。Activity Monitor 第三方访问与独立 CLI 日志记录原始输入、回复及时间，系统日志只记录连接信息和日志引用。

Windows 启动使用 PowerShell `Start-Process` 分配控制台并等待 CLI。针对 Electron 的 Windows GUI 子系统，CLI 在真实控制台条件下重开 `CONIN$` 获取 raw mode；不会将重定向管道当成交互终端。使用方法与边界见 [CLI.md](CLI.md#本机交互终端)。

## 同轮修改

- RTerminal 默认拖选本机文字；有选区 Ctrl+C 复制，无选区保留中断，Ctrl+V / Shift+Insert 粘贴本机剪贴板。Ctrl+鼠标保留远程 TUI 鼠标操作。
- 使用现有 Marked、DOMPurify、KaTeX 提供 Reading 分栏，渲染 Markdown 与公式；原始终端保持可交互。TUI alternate screen 需手动开启阅读，不能还原终端已丢弃或未输出的 Markdown。见 [TERMINAL.md](TERMINAL.md)。
- 路径空白热区悬停高亮；仅 F11 快捷键切换应用全屏，Esc 和 Ctrl+Alt+F 交给当前程序。
- Programs 与顶栏模块名统一英文，取消侧栏“收藏夹”悬停标题。文件/目录右键和空白右键按上下文精简，Settings → 右键菜单可控制内建项目显隐。
- Transfer Center 改为独立单例虚拟窗口；任务页为服务器上传目录、本机下载目录两个输入框，保留浏览、保存、拖放与历史。服务器默认上传位置为 `~/.rdesktop/download`，按服务器身份隔离；见 [TRANSFERS.md](TRANSFERS.md)。
- Exit 在连接切换期间等待或取消挂起握手，重复点击合并，清理有期限并显示具体失败。保留 Monaco 未保存确认，终端不再弹保存确认。

## 验证记录

源码按测试脚本各模块完成回归。初次总运行的归档菜单旧断言仍检查“禁用”，已按新要求改为检查“隐藏”，归档端到端重跑通过；最终原生终端启动器修改后重跑模块与相关 Electron 测试。

| 范围 | 结果 | 记录 |
| --- | --- | --- |
| 语法 | 55 个文件 | `artifacts/check-final-1.1.13.log` |
| 后端 | 113/113 | `artifacts/full-test-1.1.13.log` |
| 模块（含本机终端、菜单） | 92/92 | `artifacts/modules-final-1.1.13.log` |
| 归档、Vim、UI、工作台 | 10/10、7/7、73/73、14/14 | `artifacts/full-test-1.1.13.log` |
| 源码 Electron | 13/13，含归档修订后专项 | 总日志及 `archive-final-1.1.13.log`、`local-terminal-final-1.1.13.log` |
| 工作区、浏览器、CLI、视频 | 1/1、2/2、1/1、1/1 | 对应 `artifacts/*-final-1.1.13.log` |

所有验证使用隔离 Electron/Chrome、临时用户数据与回环 SSH/SFTP。原生窗口启动 IPC 测试使用受控进程替身；另外实际启动了隔离的隐藏 Windows 控制台，验证打包运行时的 TTY、raw mode 和带空格/引号路径传递。没有向用户现有窗口注入键盘事件，没有连接实际服务器。剪贴板测试使用替身，不读写用户剪贴板。截图已检查，不能替代不同显示缩放、服务器权限、Codex/TUI 版本和长期连接的实际使用验收。

最终包 `REMOTE_DESKTOP_TEST_EXE` 集成 **18/18**，原生控制台 **1/1**，分别见 `artifacts/packaged-test-1.1.13.log` 与 `artifacts/packaged-native-console-1.1.13.log`。包内 **264** 个文件与 **3** 个外部 CLI 资源逐字节一致，详情在 `artifacts/package-1.1.13-verification.json`。`git diff --check` 通过。

- `Remote Desktop.exe` SHA-256：`3310b6584218e92369a368bcfa1ed9132244edd529031396043be20843c1fd00`
- `resources/app.asar` SHA-256：`276d3d1fe8ccbc3cf5abb274cc29770e866efe5be11b8e61b89e7200e0c9c2ee`
