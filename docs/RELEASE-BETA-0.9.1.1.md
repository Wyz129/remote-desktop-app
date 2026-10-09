# Beta 0.9.1.1 交付记录

版本号：`0.9.1-beta.1.1`。本轮只保留本地提交和测试包，不推送 GitHub。

本版修复和补充：

- 右键“打开本机终端”使用规范化的 Windows 环境变量、有效工作目录和隐藏 PowerShell 启动器。启动失败会保留 PowerShell 的具体错误，而不只显示退出代码。
- 一次 SSH 服务器连接中的第三方 CLI/本机终端操作共用一个 `archiveId` 和归档日志文件；切换桌面或日志目录不会拆分归档，断开或重连后才建立新归档。系统日志只保留连接指针。
- 资源管理器右键可将 `.html`、`.htm`、`.pdf` 文件在浏览器中新建标签预览。HTML 可读取所选项目根目录内的相对资源；PDF 以 inline、单范围读取提供给 Chromium。预览使用独立会话，仅允许当前预览前缀，不提供 SSH、Node 或文件操作接口，也不访问外部 HTTP(S)。单个预览资源上限 64 MiB。
- Account 面板中“退出桌面”符号位于“重新连接”符号右侧。

验证结果：

- `node --test test/local-terminal.test.cjs`：7/7 通过。
- `node --test test/activity-log.test.cjs test/activity-audit.test.cjs`：19/19 通过。
- `node --test test/preview-server.test.cjs`：4/4 通过。
- Account/session UI 与 Electron 回环 SSH 场景通过；浏览器 Electron 回归 3/3 通过，包含隔离网络、HTML 相对 CSS/JS、PDF Chromium 渲染、越界导航阻断和预览清理。

尚未验证：用户生产服务器上的 Windows 本机控制台、Linux 权限/ACL、大型 HTML/PDF 和真实浏览器登录态。原始“退出代码 1”在当前隔离环境无法稳定复现，因此本版增加了错误细节保留，便于目标机器继续定位。

测试包（完成打包后）：`artifacts/electron-beta-0.9.1.1/win-unpacked/Remote Desktop.exe`。

下一阶段建议：

1. 在真实服务器回归本机终端、PTY 粘贴、断开重连和第三方归档连续性。
2. 补充 HTML/PDF 大文件、认证资源、PDF 内部链接和打印/下载边界测试。
3. 为监听中心增加按连接筛选、归档导出/清理与主机连接诊断面板。
4. 在发布前验证签名、崩溃日志、自动更新和配置迁移。
