# Remote Desktop App 1.1.12

日期：2026-09-21。本轮仅本地修改、测试、打包与提交，不推送 GitHub。回退分支：`checkpoint/pre-session-layout-1.1.11`。

## 界面与连接

顶栏账号按钮改为用户名与连接状态圆点。已连接面板只显示服务器别名和 `用户名@地址:端口`，重连图标放在别名旁，底部保留切换账号及退出桌面；不再显示可编辑用户名、密码或高级配置。独立顶栏退出按钮默认隐藏，仍可在“上栏与通知”显示与排序。退出继续检查 Monaco 未保存文档。

没有已保存服务器时，登录页仅显示磁盘头像和新增服务器入口，不显示空的凭据表单。通过“切换账号”新建或选择目标后，按原流程输入用户名与密码。别名为空时先显示 `Unknown Server`，首次成功连接后从实际系统名称与 UID 自动生成 `<OS> User` 或 `<OS> Root`，手工别名保持。密码、私钥口令和私钥内容不写入本机设置。

“设置 → 连接”可调整当前保存配置的 SSH 目标端口，校验 1–65535 和当前会话身份后重新认证。使用密码时重新输入，已选私钥时尝试使用该私钥；提交认证前保留当前会话。该功能只修改客户端连接目标，不修改服务器 sshd，不要求管理员权限。

虚拟窗口最大化后贴合可用桌面边缘、使用直角。资源管理器 Home 路径以 `~` 表示，路径外空白可拖动，增加上一级按钮，视图切换合并为一个按钮，刷新使用 F5/右键。浏览器折叠按钮改为实心三角，加号和关闭使用居中 SVG，标签关闭按钮保持与标签同一行。Monaco 完整远程路径居中显示在虚拟标题栏，不重复显示应用名，未保存及只读提示保留。

左侧收藏夹和程序页使用本地固定彩色 SVG 图标，收藏夹位置仍在左侧。桌面底部状态栏移除，状态改在左上角显示；日常打开、刷新、保存和传输完成等正常操作不弹出通知，错误及本地 CLI 连接提醒继续显示。服务器时钟每个连接只校准一次，之后按本机经过时间推进，重连重新校准；保留简约/详细格式、时区提示、通知历史与日历。

## 监听、配置与归档

实时监听分为系统操作、第三方访问、虚拟终端。系统操作显示 `#操作名称`、时间、成功/失败和有界返回摘要，避免重复显示内部 SSH 实现；第三方访问保留 CLI 原始命令、stdout/stderr 和退出结果；虚拟终端保留启动命令、实际按键和服务器回复。三类独立切换，原有日志分离与颜色清理继续保留。详见 [监听与日志](ACTIVITY_LOG.md)。

远程路径新增 `~/.rdesktop/config`，默认结构为 `~/.rdesktop/{desktop,log,download,trash,config}`。远程外观、图标位置和固定终端配置按桌面路径摘要保存为 `config/desktop-<SHA-256 前 24 位>.json`。先读取新路径，不存在时按旧四级顺序回退；下一次保存合并未知字段写入新目录，旧文件只读保留，不自动删除或覆盖。配置目录及文件拒绝符号链接替换，保留 64 KiB 上限和原子写入保护。本机连接、路径、收藏和上栏偏好仍保存在 `userData/settings.json`。

文件右键增加服务器压缩/解压：创建 tar.gz 或 zip，提取 zip、tar.gz、tgz、tar。服务器需要已有 Python 3.8+ 标准库，应用不安装依赖。新输出同名编号、不覆盖，拒绝链接、特殊文件、穿越和重复冲突成员；最多 1000 个选择、100000 项、100 GiB，15 分钟截止。正常失败尝试清理本次输出，断网/超时可能遗留未完成文件，需确认后处理；无断点续传或归档专用进度条。详见 [压缩与解压](ARCHIVES.md)。Trash 仍只是目录入口，原删除行为为确认后的永久删除。

## 实际验证

完整 `npm test` 已通过。最终审查补充了归档边界及程序面板填满桌面的修正，并重新运行相应测试；下表为最终已确认结果。

| 检查 | 结果与范围 |
| --- | --- |
| 后端 | 113/113，含配置目录迁移、旧配置保留与符号链接替换防护 |
| 模块 | 85/85，含操作摘要作用域、日志与 CLI/终端分离 |
| 语法 | 50 个源码文件通过，归档 Python 另行检查 |
| 压缩/解压 | 10/10，真实 Python 标准库经回环 SSH 往返、恶意归档、目录别名与连接变化保护 |
| 本机 Vim | 7/7，隔离临时文件 |
| UI | 60/60；真实 HTML/CSS/JS、无头 Chrome 与替身 API，最终布局定向 6/6 |
| 工作台 | 14/14；Monaco、Notebook、HTML 与资源隔离 |
| 源码 Electron | 主应用、首次连接、桌面视频、收藏重启、目录设置、账号/端口、归档 7/7；工作区 1/1、浏览器 2/2、CLI 1/1 |
| Video.js 实际播放 | 1/1，生成 WebM 经 SSH 范围读取播放与 seek |
| 最终打包 EXE | 11/11；主应用、首次连接、收藏、目录设置、账号/端口、归档、桌面视频、工作区、浏览器两项及 CLI |
| 包内核验 | 258 个应用文件、资源及许可证与源码逐字节一致，另核对 3 个外部 CLI 资源及版本/入口 |

测试记录：`artifacts/full-test-1.1.12.log`、`archive-final-1.1.12.log`、`shell-final-ui-1.1.12.log`、`packaged-test-1.1.12.log`。已检查账号面板、登录、资源管理器、浏览器、Monaco、活动分栏及程序面板截图，均来自隔离测试环境。

源码与界面测试使用隔离 Chrome/Electron、临时用户数据及本机回环 SSH/SFTP；没有接入用户现有实例或生产服务器。压缩测试运行真实本机 Python，远程 Linux Python、ACL、大型归档及断网清理仍需目标环境验证。原生对话框选择由测试注入，不计作 Windows 原生窗口人工验收。

## 打包复现

目标为 `artifacts/electron-1.1.12/win-unpacked/Remote Desktop.exe`，保留同目录全部文件。这是 Windows x64 未签名展开目录，不是安装器。

```powershell
npm.cmd run package -- --config.electronDist=node_modules/electron/dist
$env:REMOTE_DESKTOP_TEST_EXE = (Resolve-Path 'artifacts\electron-1.1.12\win-unpacked\Remote Desktop.exe').Path
node --test test/electron.test.cjs test/first-use-electron.test.cjs test/programs-electron.test.cjs test/interface-electron.test.cjs test/session-electron.test.cjs test/archive-electron.test.cjs test/video-app-electron.test.cjs test/workspace-electron.test.cjs test/browser-electron.test.cjs test/cli-packaged.test.cjs
Remove-Item Env:REMOTE_DESKTOP_TEST_EXE
```

程序与 `app.asar` 的 SHA-256，以及包内逐文件核验清单，保存于 `artifacts/package-1.1.12-verification.json`。

```text
Remote Desktop.exe
bac3efb5dffe9dee8fabc740cde13ac35489280d0a862ec527ca3f29b8db460f

resources/app.asar
eb8b2a2099a5493f25e6d8f8a351b5f48077a5c43aedc4f5d2c6f152a90a59d9
```
