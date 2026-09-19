# 1.1.5 本地交付记录

日期：2026-09-20。回退分支：`checkpoint/pre-native-upload-1.1.4`。本轮仅本地修改、提交和打包，未推送 GitHub。

## 修改内容

- 上传直接打开 Windows 原生文件选择框，支持 Ctrl/Shift 多选文件及输入文件路径；确认后直接选择服务器目标目录。删除返回应用确认选区的浮窗与 PowerShell/Shell COM 辅助脚本。
- GUI 选择和本机拖入均只接受普通文件；包含文件夹、链接或特殊文件时整批拒绝。上传规划再次检查文件类型，选中文件后来被替换成目录也不会递归上传。目录下载和高级 CLI 目录上传继续可用。
- 文本与脚本沿用真正的 Microsoft Monaco Editor 0.53.0（MIT），明确复用内置编辑、搜索替换、行号与折叠；文档说明 Fortran 扩展、SSH 适配与语言服务边界，见 [Monaco Editor](WORKBENCH.md)。
- 资源管理器、设置、终端、图片、监听、传输中心、浏览器与 Monaco 自有工具栏的按钮增加实心底色、清晰边框及悬停/按下/焦点状态。主操作与危险操作分别着色，禁用状态仍可辨识。文件条目保留轻量样式；Monaco 内置控件使用原有主题，隔离网页样式由网站决定。

使用方法见 [传输中心](TRANSFERS.md)。

## 程序与校验

程序：`artifacts/electron-1.1.5/win-unpacked/Remote Desktop.exe`。Windows x64、Electron 44.4.2；请保留整个目录。打包不包含旧本机选择浮窗或 `resources/native-picker`。33 个应用源码文件与包内副本逐字节一致，Monaco/Viewer.js 入口资源及许可证已核对。

| 文件 | SHA-256 |
| --- | --- |
| `Remote Desktop.exe` | `786d1bcb884b5001698c4c5dbbc33a64bb4492fd786c7030ce762056b957dcc0` |
| `resources/app.asar` | `89cdcc5ff675b91c22e49f1ce03022ff080db6f1b5f5d30fec64e335f979c17d` |

```powershell
npm.cmd run package -- --config.electronDist=node_modules/electron/dist
$env:REMOTE_DESKTOP_TEST_EXE = (Resolve-Path 'artifacts/electron-1.1.5/win-unpacked/Remote Desktop.exe').Path
node --test test/electron.test.cjs test/workspace-electron.test.cjs test/browser-electron.test.cjs test/cli-packaged.test.cjs
```

## 实际验证

本轮分别运行各回归命令，源码合计 202 项通过，不将重复执行计入数量。

| 检查 | 结果 |
| --- | --- |
| 语法 | 33 个 JS/CJS 文件通过 |
| 后端、权限、终端、时钟与位置 | 81/81 |
| 传输、文档、桥接、Jupyter、网络、日志及选择器 | 58/58，包含原生选择器 6 项、本地授权与目标目录 4 项 |
| 本机真实 Vim 底层兼容 | 7/7 |
| 桌面 UI | 40/40 |
| Monaco UI 与管理器 | 11/11 |
| 源码 Electron、工作区、浏览器、CLI | 5/5 |
| 打包 EXE 的相同集成场景 | 5/5，另外执行 |

Electron 集成覆盖默认原生选择入口、文件多选、取消、目录拒绝、选中文件后来被替换成目录、实际上传内容、真实 File 对象拖放、Monaco 保存与冲突、浏览器隔离和命令行实例。原生选择框的返回由隔离测试主进程模拟，**未执行 Windows 原生文件窗口的人工鼠标选择验收**。实际上传通过本机回环 SSH/SFTP，不连接用户服务器。

已查看设置、图片、监听、传输/终端、Monaco 查找替换、Notebook 和浏览器工具栏截图；新增样式截图位于 `artifacts/button-contrast-1.1.5/`，来自隔离 Chrome 与 API 替身。浏览器功能另由真实隔离 Electron 测试覆盖。本轮未操作现有桌面实例，未重复运行或处理先前被安全软件拦截的临时 EXE；没有新增自编译选择器程序。
