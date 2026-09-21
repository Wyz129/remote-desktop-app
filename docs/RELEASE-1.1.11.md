# Remote Desktop App 1.1.11

日期：2026-09-21。本轮仅本地修改、测试、打包与提交，未推送 GitHub。回退分支：`checkpoint/pre-navigation-notifications-1.1.10`。

## 界面与使用

1. 资源管理器左侧固定 Root、Home、Desktop、Log、Trash。Root 为 `/`，Home 为服务器账号的真实主目录。Desktop 在“设置 → 桌面与外观”修改；Log、Trash、自定义目录快捷方式及所有入口顺序在“设置 → 目录与侧栏”修改。自定义入口使用文件夹图标，最多 40 个；保存前检查目录是否可访问。偏好按主机、端口、用户名及已验证主机指纹隔离。
2. 资源管理器导航、面包屑、视图切换和窗口控件共用顶部一行。点击面包屑跳转到相应目录；空间不足时优先保留当前目录及附近的上级目录，根侧折叠为省略号。点击路径空白处或省略号，或按 Ctrl+L/F4，编辑完整路径；Enter 跳转、Esc 取消，Alt+方向键导航。目录访问失败保留原位置及内容，显示具体权限错误。详见 [资源管理器说明](EXPLORER.md)。
3. 传输中心与设置共用分类布局，侧栏提供任务、历史记录、高级设置；高级设置打开“设置 → 文件与传输”。可设置服务器默认上传目录和本机默认下载目录，前者按服务器账号隔离，后者为本机全局偏好。已完成任务移入历史，保留目标目录入口；拖入本机文件自动上传，拖入服务器文件/文件夹自动下载。界面上传仍只支持文件，CLI 保留目录上传。详见 [传输中心说明](TRANSFERS.md)。
4. 实时监听按同一请求或终端会话合并为 In/Out 代码块，显示实际发送的 SSH 指令、PTY 原始输入、stdout/stderr、时间和退出结果。使用本地打包的 highlight.js（BSD-3-Clause）进行 Bash 高亮、ansi_up（MIT）显示 ANSI 颜色，输出经过 DOMPurify 清理。SFTP 操作显示真实协议请求，不虚构 shell 指令；交互终端按原始输入记录，不猜测重建最终 shell 命令。详见 [监听与日志说明](ACTIVITY_LOG.md)。
5. 顶栏默认最右侧增加退出按钮，沿用 Monaco 未保存保护与连接关闭流程。在“设置 → 上栏与通知”勾选显示项目、上下移动排序，保存后立即生效并在重启恢复。浏览器默认不显示在顶栏，可从程序页打开，也可重新勾选。
6. 时钟默认简约月、日、时、分，可切换详细日期、秒与时区，始终依据服务器本地时间，悬停显示时区。点击时间打开通知历史与日历，历史自动滚至底部，可清除；保留本次运行最近 200 条通知，不跨重启保存。普通通知和本地 CLI 连接提示位于时间下方，使用向下滑入动画，系统减少动态效果偏好下关闭动画。日历标注服务器时区，服务器时间不可用时明确标注本机时区。

## 路径与行为边界

首次连接自动建立 `~/.rdesktop/{desktop,log,download,trash}`。Trash 是可配置的目录入口；原有文件菜单删除仍须确认并永久删除，当前没有自动回收或恢复功能。

更改 Log 后新操作使用新目录，不移动旧日志，不修改用户自选目录的权限。正在执行的命令、CLI 请求及已有终端会话继续写其原日志文件，直至结束；新建日志文件仍使用 0600。日志写入失败会明确提示，不能视为已完整落盘。正在编辑的目录/传输设置若遇到账号切换，保存会拒绝旧表单，需关闭并重新打开设置。

默认服务器网页下载目录仍为 `~/.rdesktop/download`；“默认下载目录”设置指本机保存位置，供本机保存选择器、浏览器本机下载及未指定目标的 CLI 下载使用。

## 实际验证

完整 `npm test` 通过；最终审查后补充日志切换并发与旧账号设置表单的定向回归，并使用最终软件包复测。

| 检查 | 结果与范围 |
| --- | --- |
| 语法 | 48 个源码文件通过 |
| 后端 | 103/103；SSH/SFTP、文件与权限、桌面、服务器配置及默认 Trash 初始化和冲突 |
| 模块 | 84/84；传输、文档/Jupyter、网络、日志、视频、目录/顶栏/传输偏好 |
| 本机 Vim | 7/7；隔离临时文件 |
| UI | 55/55；真实 HTML/CSS/JS，无头 Chrome、替身桌面 API |
| 工作台 | 14/14；Monaco、Notebook、HTML 与资源隔离 |
| 源码 Electron 集成 | 主应用/首次连接/桌面视频/收藏重启/目录与顶栏设置 5/5，工作区 1/1、浏览器 2/2、CLI 1/1 |
| Video.js 实际播放 | 1/1；生成 WebM 经 SSH 范围读取播放与 seek |
| 最终打包 EXE | 9/9；主应用、首次连接、收藏重启、目录/日志/顶栏设置、桌面视频、工作区、浏览器两项及 CLI |
| 包内核验 | 254 个应用文件、资源及许可证和 3 个 CLI 外部资源与源码逐字节一致；单独核对版本与入口 |

新增场景包括标题栏路径缩略及编辑、侧栏点击/排序、设置失败保留、账号路径隔离、默认传输路径、任务/历史与双向拖放、时钟模式、历史通知与日历、顶栏显示/排序/退出、原始指令合并及 ANSI/HTML 注入防护。真实 Electron 验证自定义 Log 实际落盘、跨账号及重启恢复、已有终端在日志目录切换后继续记录，并通过延迟写盘及故障注入验证并发刷新不覆盖新日志目标、保存失败恢复旧目标。日志模块补充目标初始化期间的命令/CLI 连续性和失败/过期迁移保护，最终 84 项模块测试通过。

已检查截图：`artifacts/explorer-breadcrumbs-1.1.11.png`、`places-settings-1.1.11.png`、`notifications-1.1.11.png`、`activity-cells-1.1.11.png`、`transfer-categories-next.png`、`transfer-categories-compact-next.png`。截图来自隔离测试环境。

未连接用户现有实例或生产服务器。SSH/SFTP 使用本机受控服务；原生主机确认和文件选择结果由测试注入，不计作 Windows 原生窗口人工验收，也不代表生产 Linux/OpenSSH、PAM/MFA 或第三方网站验收。

## 软件包

启动 `artifacts/electron-1.1.11/win-unpacked/Remote Desktop.exe`，请保留同目录全部文件。这是 Windows x64 未签名展开包，不是安装器。

```powershell
npm.cmd run package -- --config.electronDist=node_modules/electron/dist
$env:REMOTE_DESKTOP_TEST_EXE = (Resolve-Path 'artifacts\electron-1.1.11\win-unpacked\Remote Desktop.exe').Path
node --test test/electron.test.cjs test/first-use-electron.test.cjs test/programs-electron.test.cjs test/interface-electron.test.cjs test/video-app-electron.test.cjs test/workspace-electron.test.cjs test/browser-electron.test.cjs test/cli-packaged.test.cjs
Remove-Item Env:REMOTE_DESKTOP_TEST_EXE
```

最终包的 SHA-256 及逐文件核验清单保存在 `artifacts/package-1.1.11-verification.json`。

```text
Remote Desktop.exe
2e5b863de7052a174bd5a65fff1ba626c3a3063896bc36124f800c83de2b5c74

resources/app.asar
ce51a88ebd77b8a504827e89c84fb2e7e986ef0783859d1eee0d9b2cd9c5db7a
```
