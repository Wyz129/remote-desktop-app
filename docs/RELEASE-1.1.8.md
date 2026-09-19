# Remote Desktop App 1.1.8

日期：2026-09-20。本轮在本地完成修改、测试、打包与提交，没有推送 GitHub。回退分支：`checkpoint/pre-embedded-workbench-1.1.7`。

## 变更

1. 浏览器切换到其它虚拟窗口后仍保留画面。没有窗口重叠时继续使用实时原生网页；有重叠或打开面板时显示约每 750 毫秒更新的背景预览，防止原生页面遮挡前景窗口。点击浏览器恢复原生交互，不重载网页。最小化、隐藏桌面与关闭时停止定时截图。
2. Monaco Editor 改为虚拟桌面内的窗口，支持移动、缩放、最大化、最小化和侧栏恢复；保留远程保存、另存为、只读、冲突检测和未保存关闭确认。SSH 断开后保留当前文本并禁用远程操作。
3. 顶栏“切换账号”显示当前已认证身份，旁边显示“用户名·已连接”，移除左上角重复用户名。已连接面板隐藏用户名输入、密码与高级选项，显示账号文本及“断开、重新连接、切换账号”三个按钮。重新连接进入当前身份的重新认证表单，密码和私钥口令仅用于本次登录。切换账号返回初始登录表单，提交新的登录前保留原会话。
4. 传输中心改用双向传输箭头图标；删除终端内“新终端 / Shell / Vim / htop”工具栏，终端快捷键与工具箱入口继续可用。
5. 统一采用与登录界面协调的 Ubuntu 紫橙背景、暖灰窗口、橙色强调和圆角控件。设置、传输中心、浏览器工具栏及 Monaco 外围控件同步调整。

## 隔离与边界

Monaco 通过仅提供随包静态资源的随机地址本机服务加载，文档 iframe 使用 `allow-scripts allow-forms`，没有 `allow-same-origin`，无法访问父窗口 SSH API。表单由本地脚本处理，CSP 禁止网络表单提交。父页仅转发固定动作，检查源窗口和文档 ID；主进程再次限制可信桌面主 frame。远程 HTML 仍使用单独的 `allow-scripts` 沙箱，Notebook 输出经过清理。源码及静态资源服务中没有凭据、SSH 或任意文件读取 HTTP 接口。

浏览器背景图像不是全帧率视频；实际更新速度受页面绘制和本机负载影响，交互时恢复原生页面。测试使用隔离 Electron、无头 Chrome、TCP 回环 SSH/SFTP 和受控 HTTP 服务，没有接入用户服务器或操作现有桌面实例。未验收真实第三方登录网站、生产 Linux/OpenSSH、PAM/MFA 或生产 Jupyter；Jupyter 的协议与工作台已有测试通过，不将替身内核结果称为生产验证。

## 本轮实际验证

| 检查 | 结果与范围 |
| --- | --- |
| `npm run check` | 41 个源码文件通过语法检查 |
| `npm run test:backend` | 通过，SSH/SFTP、文件服务、权限与存储配置 |
| `npm run test:modules` | 72/72，传输、日志、文档、Jupyter、网络及视频服务 |
| `npm run test:ui` | 43/43，含浏览器无遮挡、遮挡、恢复和最小化 |
| `npm run test:workbench` | 14/14，含 opaque iframe、伪造消息与静态资源边界 |
| `npm run test:vim` | 7/7，本机隔离 Vim |
| 源码 Electron 集成 | 主应用 3 项、工作台 1 项、浏览器 2 项、CLI 1 项均通过 |
| `npm run test:video` | 1/1，真实 Video.js、SSH 范围读取、播放与 seek |
| 打包 EXE 集成 | 主应用 3 项、工作台 1 项、浏览器 2 项、CLI 1 项，共 7/7 |
| 包内核验 | 237 个应用文件、静态资源和许可证与当前本地文件逐字节一致；另核验版本与入口 |

工作台集成覆盖真实文件另存为、保存冲突、取消关闭、取消断开、断连保留草稿、最小化/还原/最大化、父窗口 API 隔离、HTML 相对 CSS/图片/JS 与 Notebook 公式和输出。已连接面板测试验证未提交的服务器选择不会改变当前身份，重新认证后磁盘配置中不存在密码。浏览器专项测试验证原生视图隐藏后页面颜色变化仍进入后续背景图像。

测试分别运行，没有声称单次执行 `npm test`。内嵌 frame 的隐藏 Electron 集成测试先请求一次保持隐藏的原生截图并等待绘制，使跨进程 frame 的命中区域与合成画面就绪，再进行鼠标交互；未通过禁用网页隔离来完成测试。

截图：`artifacts/packaged-account.png`、`packaged-browser-background.png`、`packaged-workbench-html.png`、`packaged-notebook.png`、`packaged-toolbox.png`。界面截图和测试夹具均不代表用户服务器内容。

## 软件包

启动 `artifacts/electron-1.1.8/win-unpacked/Remote Desktop.exe`，保留同目录全部文件。这是未签名的 Windows x64 展开包。

构建：`npm.cmd run package -- --config.electronDist=node_modules/electron/dist`。

打包验证使用 `REMOTE_DESKTOP_TEST_EXE` 指向上述程序，执行 `test:electron`、`test:workspace`、`test:browser` 和 `test:cli`。

SHA-256：

```text
Remote Desktop.exe
5d193e69cbbe4de4d6aa8ea2e120d1b7b68463541d505bd4021c4593e3781d5f

resources/app.asar
d35f0cc96e95e0001864fedbd5ce12fb789e7832001b2d082d595ea0f5af7e86
```
