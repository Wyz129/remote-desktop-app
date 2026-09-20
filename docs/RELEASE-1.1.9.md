# Remote Desktop App 1.1.9

日期：2026-09-20。本轮仅在本地修改、测试、打包与提交，不推送 GitHub。回退分支：`checkpoint/pre-dark-login-1.1.8`。

## 变更

1. 虚拟窗口的最小化、最大化、关闭按钮统一居中。圆形按钮为 28px，SVG 分别为 16px、12px、20px；关闭叉号放大，最大化及还原符号缩小。设置、资源管理器、终端、图片、视频、浏览器、监听和 Monaco 共用控件规则，传输中心与工具箱的关闭图标也改为 SVG。
2. 普通登录采用居中头像、服务器名称、用户名与密码两个圆角输入框；按 Enter 或密码框右侧箭头登录。“切换账号”进入独立配置界面，可选择已保存服务器、新建目标、保存配置或直接连接。保存后返回普通登录；返回箭头、切换和保存均清空密码与口令。绑定私钥时额外显示私钥口令输入，已连接账号视图继续保留断开、重新连接、切换账号。
3. 资源管理器及窗口内容采用炭灰 `#242424`、深灰标题栏 `#303030`、灰紫文件夹 `#8d8495`；低饱和度棕橙用于选中，普通悬停改为中性灰。设置、传输中心、浏览器工具栏、Monaco 外围工具栏和视频窗口同步配色，不改网页或代码语法高亮的内容颜色。
4. 登录配置尚在读取时显示加载提示并暂时禁用表单，防止用户输入后被迟到的配置响应清空。读取失败仍显示错误并允许手动配置。连接期间禁用重复提交与目标切换，密码不落盘。

## 使用

- 首次连接：点击“切换账号”→“新建”，填写目标与用户名、认证信息，点击“连接服务器”。也可先“保存配置”，回到登录页输入密码。
- 已保存目标：点击“切换账号”，在下拉框选择服务器；直接连接，或用左上角箭头返回普通登录。
- 已登录：顶栏“切换账号”打开当前账号视图；进入配置界面只编辑目标，提交新的登录前保留原连接。未提交的服务器选择不会改变当前账号显示。
- 配置窗口高度不足时内部滚动；较低窗口隐藏重复的服务器标题，目标仍可在选择框和地址字段辨认。

## 实际验证

本轮执行完整 `npm test` 并通过，覆盖语法、后端、模块、Vim、UI、工作台、Electron、工作区、浏览器、CLI 和视频。最后补充配置加载保护后再次通过语法检查及完整 UI 46/46，并重新打包验收。

| 检查 | 结果与范围 |
| --- | --- |
| 语法 | 41 个源码文件通过 |
| 后端与模块 | 通过；模块 72/72，包含 SSH/SFTP、权限、存储、文档、网络、日志及传输 |
| 本机 Vim | 7/7；隔离临时文件 |
| 最终 UI | 46/46；真实 HTML/CSS/JS、无头 Chrome 与替身桌面 API |
| 工作台 | 14/14；Monaco、Notebook、HTML 和消息/资源隔离 |
| 源码 Electron 集成 | 主应用/首次连接/桌面视频 3/3，工作区 1/1，浏览器 2/2，CLI 1/1 |
| Video.js 实际播放 | 1/1；生成 WebM 经 SSH 范围读取播放及 seek |
| 最终打包 EXE | 7/7；主应用、首次连接、桌面视频、工作区、浏览器两项及 CLI |
| 包内核验 | 238 个应用文件、静态资源和许可证与本地文件逐字节一致；另核验版本与入口 |

新 UI 检查包含 Enter 登录、空地址/无效端口阻止提交、配置加载时禁止提前输入、560×650 布局，以及七种窗口的图标中心与 125% 缩放/最大化还原。首次使用 Electron 场景覆盖服务器配置保存与切换、密码和口令清理、不落盘秘密、当前连接身份、重连及真实回环 SSH。

打包程序首次并行验收中一个视频场景在登录阶段超时，单独复测通过；排查发现初始配置读取期间表单可提前输入，已补充可复现的延迟配置测试与加载保护，再次打包验收。没有仅通过延长超时掩盖该时序问题。

已查看截图：`artifacts/standalone-connect.png`、`login-compact-1.1.9.png`、`login-advanced-compact-1.1.9.png`、`explorer-details-1.1.9.png`、`explorer-icons-1.1.9.png`、`standalone-settings-window.png`、`packaged-login.png`、`packaged-login-advanced.png`、`packaged-account.png`。截图内容来自隔离测试环境。

未连接用户现有实例或生产服务器；SSH/SFTP 使用本机受控测试服务。原生主机确认和文件选择的结果由测试注入，不计作 Windows 原生窗口人工操作验收；没有验收生产 Linux/OpenSSH、PAM/MFA 或第三方网站。

## 软件包

启动 `artifacts/electron-1.1.9/win-unpacked/Remote Desktop.exe`，保留同目录全部文件。这是 Windows x64 未签名展开包，不是安装器。

构建命令：

```powershell
npm.cmd run package -- --config.electronDist=node_modules/electron/dist
```

打包验收：设置 `REMOTE_DESKTOP_TEST_EXE` 为上述 EXE 路径，然后运行 `node --test test/electron.test.cjs test/first-use-electron.test.cjs test/video-app-electron.test.cjs test/workspace-electron.test.cjs test/browser-electron.test.cjs test/cli-packaged.test.cjs`。

SHA-256：

```text
Remote Desktop.exe
19ad57ba21f4ce8ed0b89c221d1184bf5f7b30e678d33465f4fbeecc2ef1c149

resources/app.asar
a0026b5b9c8e4c34712ce163fc1b30b41cb5c0e724add9496bd15d8f7cdea214
```
