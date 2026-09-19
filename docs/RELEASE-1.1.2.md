# 1.1.2 本地交付记录

日期：2026-09-19。基线为 `b5b6c55`；按用户要求暂不推送 GitHub。

## 修改

- 浏览器标题栏从资源管理器模板继承的文件夹图标改为与任务栏一致的地球图标；关闭按钮的无障碍名称改为“关闭浏览器窗口”。
- 本机新增 `C:\Users\KunYu\.codex\远程桌面命令行操作规范.md`，并在同目录现有 `AGENTS.md` 加入按需读取规范。文档包含选择已连接实例、显式传入实例 ID、执行命令、JSON/退出码读取、转义、超时、取消、传输及连接恢复。全局文档不在本 Git 仓库内。
- 原索引备份：`C:\Users\KunYu\.codex\backups\remote-desktop-cli-docs-20260919-210814\AGENTS.md`。

## 本机程序

`artifacts/electron-1.1.2/win-unpacked/Remote Desktop.exe`，Windows x64 展开包，需要保留完整目录。没有覆盖旧 1.1.1 程序，也没有重启用户已打开的实例。

EXE SHA-256：`A1A6E0C38B6F9AD748EEA74C84834EEEBD43B537999F27BE575EB97D29484B36`。

## 本轮实际验证

- `npm run check`：28 个生产脚本语法通过。
- 浏览器窗口 UI 定向回归：2/2，包括标题栏图标、窗口生命周期和迟到的打开结果。
- `test/instance-bridge.test.cjs`：9/9，包括实例选择、输出/退出码、超时、认证及启动路径。
- 打包 EXE 的浏览器与 CLI 集成：3/3，零跳过。
- 全局指南和索引 UTF-8 校验通过，9 个 PowerShell 代码块均通过语法解析。占位命令没有向用户服务器执行。
- 已检查 `artifacts/standalone-browser-window.png`，确认标题栏使用地球图标；截图的远程 API 是替身，网页区域为占位层。
- ASAR 中 `app/desktop.js`、`app/desktop.css` 与源码逐字节一致，应用身份、版本和入口匹配。构建工具按预期删除 package.json 中的开发元数据，不要求其完整字节一致。

日志在 `artifacts/round5-ui.log`、`round5-cli.log`、`round5-package.log`、`round5-packaged.log`。测试仅使用隔离 Chrome/Electron、命名管道和回环 SSH/HTTP 夹具；未连接用户真实服务器。此轮没有重跑 1.1.1 的全量测试，旧记录仅供历史参考。
