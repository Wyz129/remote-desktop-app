# 1.1.3 本地交付记录

日期：2026-09-19。回退检查点：`checkpoint/pre-audit-1.1.2`。按用户要求仅在本地修改、提交和打包，未推送 GitHub。

## 行为变化

- 本地 CLI 实际连接自动触发右下角通知，显示 IP 来源、连接时间和“实时监听”按钮。监听从请求开始自动记录，窗口支持会话选择、指令/回复流、日志位置、错误及单实例恢复。
- 服务器当前桌面自动生成 `.log`，分离 CLI 详情与 GUI 系统日志。系统日志对 CLI 只记录时间、IP 和日志路径；GUI 终端保存服务器转录与退出结果，不逐键捕获隐藏输入。
- 日志通过已有 SFTP 连接顺序写入，独占创建、权限 0700/0600、8 MiB 完整记录轮换，并明确报告写入失败、超时或队列上限。桌面切换时完成中的操作仍写原日志，断线后旧记录不会写到新服务器。
- Home 位于顶栏浏览器与设置之间，删除左侧三个固定入口；已打开窗口的动态标签和用户固定程序继续可用。

具体使用、IP 语义、日志格式和记录边界见 [监听与日志说明](ACTIVITY_LOG.md)。

## 程序

完整目录：`artifacts/electron-1.1.3/win-unpacked/`。

启动程序：`artifacts/electron-1.1.3/win-unpacked/Remote Desktop.exe`。请保留同目录依赖文件。Windows x64，Electron 44.4.2，未签名。

| 文件 | SHA-256 |
| --- | --- |
| `Remote Desktop.exe` | `505A33801F061C74A43C9B57A3F80FDEE2B7DF1A21A6AEE6572B0AF26E5763F1` |
| `resources/app.asar` | `49F3577F75BBFDEE8AC41C434440DAD6A8D288023157B2C89B182375F9E4F661` |

已逐字节核对打包中的 30 个应用源码文件、3 个独立 CLI 文件与工作区一致，应用版本为 1.1.3。

## 本轮验证

| 检查 | 结果 |
| --- | --- |
| `npm test` 全量回归 | 175/175：后端 82、模块 43、真实 Vim 7、UI 34、工作台 4、Electron 1、工作区 1、浏览器 2、CLI 1 |
| 最后日志边界修正后的定向回归 | 24/24：日志 11、系统摘要 2、实例桥/CLI 11；包括新增的缓存淘汰释放与跨桌面异步结果两项 |
| 最后语法检查 | 30 个 JS/CJS 文件通过 |
| 1.1.3 打包 EXE 集成验证 | 5/5：桌面/监听/日志/终端、Monaco/Notebook/CLI、两项浏览器、无独立 Node 的打包 CLI |
| 界面检查 | 已检查 `artifacts/standalone-activity-monitor.png` 的窗口布局 |

日志：`artifacts/round6-tests.log`、`round6-audit-tests.log`、`round6-package.log`、`round6-packaged-tests.log`。

真实 Electron 测试通过认证命名管道调用已连接实例的 `exec`，检查 stdout 和退出码、连接通知、监听窗口及服务器日志；断开前排空日志，验证系统文件只包含 CLI 索引、GUI 终端输出和启动命令，且不含测试 SSH 密码。实例桥测试另覆盖无效认证、发现请求不通知、取消一次终结、监听回调失败和拆分 UTF-8。日志模块覆盖真实 SSH/SFTP、权限拒绝、符号链接、轮换、切换实例、缓存/队列限制和超时。

所有端到端验证使用隔离进程及本机回环 SSH/SFTP/HTTP/Jupyter 夹具；未操作用户生产服务器或已有桌面实例。POSIX 权限模式在故障注入测试中验证调用及约束，Windows 夹具不能代表 Linux 权限执行。GUI 终端记录为服务器 PTY 转录，不保证恢复成逐条 shell 历史。

## 复现打包与验证

默认构建下载 Electron 时遇到网络超时，本次使用已安装并验证版本为 44.4.2 的本机分发包成功构建：

```powershell
npm.cmd run package -- --config.electronDist=node_modules/electron/dist
$env:REMOTE_DESKTOP_TEST_EXE = (Resolve-Path 'artifacts/electron-1.1.3/win-unpacked/Remote Desktop.exe').Path
node --test test/electron.test.cjs test/workspace-electron.test.cjs test/browser-electron.test.cjs test/cli-packaged.test.cjs
```
