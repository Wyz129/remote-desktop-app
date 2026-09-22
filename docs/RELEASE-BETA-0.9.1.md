# Beta 0.9.1（0.9.1-beta.1）

日期：2026-09-22。此版本基于 1.1.13，作为测试版发布。

## 修复

RTerminal 粘贴报错的根因是 Electron 44 的 `clipboard.readText()` 与 `clipboard.writeText()` 返回 Promise，而主进程此前直接把 Promise 交给文本校验。现在两个 IPC handler 都异步等待 Electron 剪贴板操作，再执行 60 KiB UTF-8 文本限制。Ctrl+V、Ctrl+Shift+V 与 Shift+Insert 可以正常读取本机文本剪贴板并转发到远程 PTY。

## 验证

- `npm run check`：55 个文件通过。
- RTerminal UI、Electron 与回环 SSH 集成：7/7 通过。Electron 测试使用异步剪贴板替身，覆盖读取 Promise、写入 Promise、远程粘贴与复制。
- 既有本机终端转发、生命周期、菜单和传输测试保留。
- 最终展开包 `artifacts/electron-beta-0.9.1/win-unpacked/Remote Desktop.exe` 的包内版本核验通过：264 个包内文件、3 个 CLI 外部资源逐字节一致。
- 最终包 RTerminal、CLI 与本机终端集成：3/3 通过，记录在 `artifacts/packaged-terminal-beta-0.9.1.log`。

发布提交使用 Git tag `beta-0.9.1`。没有连接实际服务器，测试不读取或写入用户真实系统剪贴板。

最终包哈希：

- `Remote Desktop.exe`: `587e75a8c3bce5022cf7eed5050a58f39796994b7d2e741d0e097a3351849849`
- `resources/app.asar`: `c14797cf9eadf099cf0d06a2672c4f0bebbc77321a477d61f147ffd0ebea43a2`
