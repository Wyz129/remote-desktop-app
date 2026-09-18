# 1.1.1 本地交付记录

日期：2026-09-19。用户要求本轮暂不推送 GitHub；修改、测试、打包和提交均保留在本地。回退检查点为 `checkpoint/pre-desktop-windows-1.1.0`，基线提交 `9e6d39f`。

## 本轮修改

- 浏览器位于虚拟桌面内，复用桌面窗口的拖动、缩放、最小化、最大化和关闭。重复打开恢复同一浏览器。
- 网页新窗口链接、`window.open` 与弹窗 POST 表单创建并聚焦浏览器内的新标签页。支持新增、切换和关闭标签；关闭最后一个标签或断开 SSH 不会销毁主桌面。
- 左侧任务栏固定顺序为 Home、浏览器、设置；浏览器和设置不再生成重复的动态标签。
- 传输中心的服务器路径选择复用虚拟资源管理器，支持目录导航、文件双击选择、手动输入路径、取消及权限错误。取消未完成的校验后重新打开，不会留下禁用的选择按钮。
- 本地文件、目录和下载目录选择继续由 Electron 调用 Windows 原生文件选择窗口。
- 设置改为单实例方形虚拟窗口，支持拖动、缩放和窗口控件；重复打开保留尚未应用的输入。

远程网页仍没有 preload、Node、SSH 凭据或文件操作接口，使用独立会话及 SSH 网络/DNS。网页原生层在浏览器失去桌面窗口焦点、最小化，或桌面模态框、菜单、传输中心出现时隐藏；聚焦后恢复原页面，不重载。后台标签的下载保持有效并归入传输中心。

## 可运行版本

路径：`artifacts/electron-1.1.1/win-unpacked/Remote Desktop.exe`。

这是 Windows x64 展开包，运行或复制时需要保留整个 `win-unpacked` 目录；旧 1.1.0 包保留。打包来自本地源码，未上传 GitHub。

EXE SHA-256：`0ADC61264547CB72E91CE706B66B5AA1236A50482A1658F2D52CD847C42867F2`。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| 语法检查 | 28 个生产脚本通过 |
| 后端 | 82/82 |
| 上传、实例桥、文档、Jupyter、网络与预览模块 | 30/30 |
| 本机真实 Vim | 7/7 |
| 桌面 UI | 30/30 |
| 文档工作台 UI | 4/4 |
| 主应用 Electron 集成 | 1/1 |
| 工作台 Electron 集成 | 1/1 |
| 浏览器 Electron 集成 | 2/2 |
| CLI | 1/1 |
| 1.1.1 打包 EXE：主应用、工作台、浏览器、CLI | 5/5 |

先执行完整 `npm test`，156 项通过；随后加入两项取消/迟到回调回归并修复选择器问题，重新执行 UI 全量测试 30/30 及语法检查。当前源码测试合计 158 项，均通过。之后打包，并通过 `REMOTE_DESKTOP_TEST_EXE` 对实际 EXE 执行上述 5 项集成测试，零失败、零跳过。

测试日志：`artifacts/round4-test.log`、`artifacts/round4-ui-final.log`、`artifacts/round4-package.log`、`artifacts/round4-packaged-test.log`。已检查 `artifacts/standalone-settings-window.png` 的设置窗口布局。

Electron 测试启动隔离进程和独立 userData，使用本机回环 SSH/SFTP、HTTP 与 Jupyter 协议夹具。原生对话框的响应由测试主进程替身提供；UI 测试使用无头 Chrome 和替身应用接口。不把这些结果当作真实服务器、Linux ACL、第三方登录网站、Windows 多屏缩放或原生文件选择器人工体验的验收。本轮未操作用户已有应用窗口，未使用真实服务器凭据。

## 复测

```powershell
npm.cmd test
npm.cmd run package
$env:REMOTE_DESKTOP_TEST_EXE = (Resolve-Path 'artifacts/electron-1.1.1/win-unpacked/Remote Desktop.exe').Path
node --test test/electron.test.cjs test/workspace-electron.test.cjs test/browser-electron.test.cjs test/cli-packaged.test.cjs
```

日常使用说明见 [README](../README.md) 与 [浏览器说明](BROWSER.md)。
