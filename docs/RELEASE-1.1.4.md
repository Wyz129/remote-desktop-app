# 1.1.4 本地交付记录

日期：2026-09-19。回退分支：`checkpoint/pre-transfer-editor-1.1.3`。本轮仅本地修改、提交和打包，未推送 GitHub。

## 功能

- 传输中心顶部为上传/下载，先选择来源再选择目标；服务器多选与路径输入、本机和远程双向拖放。结束任务隐藏进度与取消控件。
- 上传使用系统 Windows 资源管理器，可在同一窗口混选文件与文件夹，再点击应用浮动确认窗的“使用所选项目”。不编译辅助 EXE，不修改执行策略。下载目标使用原生目录选择框。
- 历史持久化、最多 500 条；删除只影响记录。目标目录可打开，服务器目标校验主机、端口、账号和主机指纹。网页下载到服务器定位实际服务器目标目录。
- 文本/脚本统一 Monaco Editor，左侧增加入口；支持未命名新文档、另存为与打开远程路径，保留未保存确认、只读、Notebook、HTML 预览及保存冲突检查。
- 按用户要求取消终端关闭保存提示，直接关闭 SSH 通道，不注入 Vim 指令。
- 图片使用 MIT 许可的 Viewer.js 1.14.0，本地资源随包交付；左侧入口、虚拟窗口、选图、缩放、平移、旋转与水平翻转。

说明见 [传输中心](TRANSFERS.md) 和 [Monaco Editor](WORKBENCH.md)。

## 程序与校验

启动：`artifacts/electron-1.1.4/win-unpacked/Remote Desktop.exe`。请保留完整目录。Windows x64、Electron 44.4.2、未签名。包内 37 个应用源码文件、Viewer.js 的 JS/CSS/许可证和资源管理器选择脚本已逐字节核对。

| 文件 | SHA-256 |
| --- | --- |
| `Remote Desktop.exe` | `dd49f5a850a76bc1d6f42de124bd537ce845380f96f5cd1af04b147daf96f046` |
| `resources/app.asar` | `e27548a00c53426a7682977eca08f928fb638a4adfaa56378b6b1dc8a38f6ca7` |

构建使用已安装的 Electron 分发包，避免重复网络下载：

```powershell
npm.cmd run package -- --config.electronDist=node_modules/electron/dist
$env:REMOTE_DESKTOP_TEST_EXE = (Resolve-Path 'artifacts/electron-1.1.4/win-unpacked/Remote Desktop.exe').Path
node --test test/electron.test.cjs test/workspace-electron.test.cjs test/browser-electron.test.cjs test/cli-packaged.test.cjs
```

## 本轮实际验证

本轮分别运行各回归命令；以下合计 202 项通过，不把重复执行计入数量。

| 检查 | 结果 |
| --- | --- |
| 语法 | 35 个 JS/CJS 文件通过 |
| 后端、权限、终端、时钟及位置 | 81/81 |
| 传输、文档、桥接、Jupyter、网络、日志及选择器 | 58/58（含 8 项本机选择器） |
| 本机真实 Vim 底层服务兼容 | 7/7；GUI 不再使用保存保护 |
| 桌面 UI，含真实 Viewer.js | 40/40 |
| Monaco UI 与管理器状态 | 11/11 |
| 源码 Electron、工作区、浏览器、CLI 集成 | 5/5 |
| 打包 EXE 集成 | 5/5，另外运行 |
| `npm audit --omit=dev` | 0 vulnerabilities |

真实 Electron 场景覆盖默认与只读 Monaco、未命名文档关闭后返回另存为、实际远程保存、打开另一文件、冲突保护、终端直接关闭、历史持久化与删除、目标目录、拒绝不可信 IPC，以及真实本机 File 对象经 preload 解析路径后触发服务器选目录并实际上传，内容一致。Viewer.js 截图 `artifacts/standalone-image.png` 已查看。

本机混选专项运行了真实 PowerShell 脚本和模拟 Shell COM 对象，验证混合返回、指定新窗口身份、拒绝无关窗口、空选区、关闭/断线、错误与来源保护。实际系统资源管理器已成功打开，但该次交互在选择完成前结束，**未完成真实 Explorer 混选端到端验证**。本机 File 拖放验证通过 Chromium 文件输入创建真实 File 并派发 drop，未实测鼠标从 Windows Explorer 拖入的操作手势。

所有 SSH/SFTP/Jupyter/网页验证使用本机隔离夹具，未操作生产服务器或已有桌面实例。浏览器网页为独立隔离视图，桌面的上传拖放入口不接管网页内的拖放。原生窗口样式、Windows 11 多标签资源管理器和第三方安全软件兼容性仍需使用环境验收。

## 本轮安全软件警示

最初为验证自定义原生选择对话框，生成了 `artifacts/native-picker-test/PickerTest.exe`。360 将该测试文件以启发式名称 `HEUR/QVM03.0.2D19.Malware.Gen` 拦截。本轮停止运行该文件并弃用这套编译方案；未关闭防护、添加信任、提交样本或修改安全策略。不能仅凭文件来源认定此次检测为误报。

自动审批拒绝了删除这个测试 EXE 的操作，只返回 `blocked by policy`。本轮没有通过其他方式重试删除，可由用户通过安全软件清理。该文件及测试目录均被 Git 忽略，打包文件清单不包含它；交付的选择器目录仅有纯文本 PowerShell 脚本，没有自编译 EXE、DLL 或 C# 源码。
