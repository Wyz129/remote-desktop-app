# Beta 0.9.1.1 项目交接说明

更新时间：2026-10-10（Asia/Shanghai）

## 当前基线

- 仓库：`Wyz129/remote-desktop-app`（私有）
- 本地目录：`C:\0_myfiles\new_projects\remote-desktop-app`
- 当前开发分支：`standalone-app`
- GitHub 发布分支：`main`
- 版本：`0.9.1-beta.1.1`，用户可见名称 Beta 0.9.1.1
- Git 标签：`beta0.9.1.1`
- 本版提交：以标签指向的提交为准
- 回退检查点：`checkpoint/pre-beta-0.9.1.1`
- 测试包：[Remote Desktop.exe](../artifacts/electron-beta-0.9.1.1/win-unpacked/Remote%20Desktop.exe)

## 启动、测试和打包

在 Windows PowerShell 中执行：

```powershell
Set-Location 'C:\0_myfiles\new_projects\remote-desktop-app'
npm.cmd ci
npm.cmd start
```

常用检查：

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run package -- --config.electronDist=node_modules/electron/dist --config.directories.output=artifacts/electron-beta-0.9.1.1
```

运行打包版 Electron 测试前设置：

```powershell
$env:REMOTE_DESKTOP_TEST_EXE = 'C:\0_myfiles\new_projects\remote-desktop-app\artifacts\electron-beta-0.9.1.1\win-unpacked\Remote Desktop.exe'
node --test test/browser-electron.test.cjs test/local-terminal-electron.test.cjs test/session-electron.test.cjs
```

完整测试使用隔离用户目录、回环 SSH/SFTP 服务和受控浏览器夹具，不会连接用户生产服务器。生产服务器验证需要用户明确授权，并应复用 Remote Desktop App 已有连接通路。

## 代码地图

- `main.cjs`：Electron 主进程、生命周期、窗口安全策略和 IPC。
- `preload.cjs`：可信桌面 API；保持固定白名单，不暴露 Node 或任意文件 API。
- `lib/ssh-backend.cjs`：SSH、SFTP、PTY、权限和传输。
- `lib/activity-log.cjs`：系统日志与第三方操作归档；同一 SSH 连接共用一个 CLI 归档。
- `lib/local-terminal.cjs`：Windows 本机终端启动器。
- `lib/browser-manager.cjs`、`lib/preview-server.cjs`：SSH 网络浏览器和 HTML/PDF 受控预览。
- `app/desktop.js`：虚拟桌面窗口、资源管理器、活动监听和应用入口。
- `app/index.html`、`app/*.css`：桌面和窗口 UI。
- `test/`：后端、模块、无头 UI、Electron 和打包版测试。

## 本版行为

1. 右键“打开本机终端”通过隐藏 PowerShell 启动真正的 Windows 控制台，统一大小写不敏感的 `PATH`，设置有效工作目录；启动失败会保留有限长度的 PowerShell 错误信息。
2. 同一 SSH 连接中的多个 CLI/本机终端操作共用 `archiveId` 和 `cli-*.log`；每个操作仍保留自己的 `operationId`。切换桌面或 Log 路径不拆归档，断开或重连才新建归档。
3. 资源管理器可将 `.html`、`.htm`、`.pdf` 以“打开方式 · Browser”打开。HTML 只允许所选目录内的相对资源，PDF 交给 Chromium 内置查看器；预览会话不提供 SSH、Node 或文件操作接口。
4. Account 面板的“退出桌面”图标位于“重新连接”图标右侧。

## 已知边界

- 原始“本机终端退出代码 1”在隔离环境中不能稳定复现；当前实现改善启动可靠性和错误可见性，目标机器仍需真实回归。
- HTML 右键预览默认以文件所在目录为资源根；引用上级目录的项目需通过工作台显式选择更大的预览资源目录。
- 单个预览资源限制为 64 MiB；大文件、PDF 内部链接、认证资源和打印/下载仍需补充真实场景测试。
- 测试夹具不能替代 OpenSSH/PAM/MFA、生产 ACL、长期网络和真实浏览器登录态。
- 当前包是 Windows x64 未签名展开目录，使用时需保留整个 `win-unpacked` 目录。

## 后续开发建议

1. 在一台测试服务器上回归本机终端、PTY 粘贴、第三方归档、断开重连和权限错误。
2. 增加 HTML/PDF 大文件、认证资源、PDF 内部链接、打印和下载边界测试。
3. 为实时监听增加归档筛选、导出、清理策略及 SSH/DNS/SFTP/PTY 分层诊断。
4. 发布前补充 Windows 签名、崩溃日志、自动更新和配置迁移。

## Git 约定

```powershell
git fetch origin
git status
git log --oneline --decorate -10
```

独立应用只推送 `origin`（`Wyz129/remote-desktop-app`）。`upstream` 指向插件仓库并禁用 push，禁止将独立应用改动推回插件仓库。提交功能修改后先运行相关测试和 `git diff --check`，再更新交接说明；发布版本同时更新 `package.json`、`package-lock.json`、README、TESTING 和交付记录。
