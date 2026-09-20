# Remote Desktop App 1.1.10

日期：2026-09-21。本轮仅本地修改、测试、打包与提交，未推送 GitHub。回退分支：`checkpoint/pre-programs-favorites-1.1.9`。

## 界面与使用

1. 左下角九点图标打开“程序”，采用类似 Ubuntu 的全桌面网格：顶部搜索、中央程序图标、底部“常用/全部”。提供浏览器、传输中心、实时监听、htop、Monaco Editor、图片查看器、视频播放器、Home、设置和终端。支持方向键、Enter、Esc 和小窗口滚动。
2. 左侧栏作为收藏夹使用，程序页右键或 Shift+F10 可“添加到收藏夹”，已收藏项目可移除。收藏顺序及程序页/收藏入口的启动次数保存在本机 `userData/settings.json`，重启恢复；“常用”按这些启动次数排序。收藏独立于服务器，离线也可管理。旧固定终端及运行中窗口的动态标签继续保留。按最后补充要求，栏内不常驻显示“收藏夹”和“程序”两处小字，九点按钮保留“程序”悬停提示和可访问名称。
3. 各窗口的最小化、最大化、关闭符号平时保持可见，但按钮背景及轮廓透明；鼠标悬停显示背景，键盘焦点保留明确轮廓。保留前版居中和图标大小。
4. 设置采用左侧分类、右侧卡片：桌面与外观、文件与传输、远程系统。SFTP 阈值移至“文件与传输”，切换分类不丢失未提交输入。仍为单实例窗口，可拖动、缩放和最小化，窄窗口内部滚动。
5. 浏览器标签位于地址栏上方。地址栏右侧箭头展开/折叠下载目标、服务器目录、清登录态及说明，默认折叠。普通折叠高度约 81px；展开、换行和错误显示时网页视图同步调整。折叠保留输入和下载选项，错误信息不会被隐藏；页面隔离和 SSH 网络访问保持。

收藏保存成功后再更新界面，失败显示提示且保留原状态。修正了重排图标导致键盘焦点丢失的问题；添加/移除后可继续方向键导航，移除最后一个侧栏收藏后焦点回到九点按钮。

## 实际验证

本轮完整 `npm test` 通过。最后按用户要求移除侧栏两处小字、修复焦点后，再次通过语法、完整 UI，并重新打包复测。

| 检查 | 结果与范围 |
| --- | --- |
| 语法 | 42 个源码文件通过 |
| 后端 | 101/101；SSH/SFTP、文件权限与操作、服务器配置、存储、时钟和桌面偏好 |
| 模块 | 77/77；传输、文档/Jupyter、网络、日志、视频和收藏偏好 |
| 本机 Vim | 7/7；隔离临时文件 |
| 最终 UI | 49/49；真实 HTML/CSS/JS、无头 Chrome、替身桌面 API |
| 工作台 | 14/14；Monaco、Notebook、HTML 与资源隔离 |
| 源码 Electron 集成 | 主应用/首次连接/桌面视频/收藏重启 4/4，工作区 1/1，浏览器 2/2，CLI 1/1 |
| Video.js 实际播放 | 1/1；生成 WebM 经 SSH 范围读取播放与 seek |
| 最终打包 EXE | 8/8；主应用、首次连接、收藏重启、桌面视频、工作区、浏览器两项及 CLI |
| 包内核验 | 241 个应用文件/资源/许可证及 3 个 CLI 外部资源与源码逐字节一致；单独核对版本和入口 |

新覆盖包含离线右键与键盘收藏、保存失败保留、非法 IPC 不改变配置、其它设置不丢失、收藏/常用跨 Electron 重启恢复、设置三分类及 820×560 布局、按钮正常和悬停状态；浏览器覆盖辅助栏展开/折叠及值保留、原生视图尺寸、错误始终可见、非法高度、后台截图、Cookie/POST/Blob 下载和弹出标签。

已检查本轮截图：`artifacts/standalone-applications.png`、`programs-compact-1.1.10.png`、`settings-1.1.10-desktop.png`、`settings-1.1.10-files.png`、`settings-1.1.10-system.png`、`settings-1.1.10-compact.png`、`browser-1.1.10/collapsed.png`、`browser-1.1.10/expanded.png`。截图来自隔离测试环境。

未连接用户现有实例或生产服务器。SSH/SFTP 使用本机受控服务；原生主机确认和文件选择结果由测试注入，不计作 Windows 原生窗口人工验收，也不代表生产 Linux/OpenSSH、PAM/MFA 或第三方网站验收。

## 软件包

启动 `artifacts/electron-1.1.10/win-unpacked/Remote Desktop.exe`，请保留同目录全部文件。这是 Windows x64 未签名展开包，不是安装器。

```powershell
npm.cmd run package -- --config.electronDist=node_modules/electron/dist
$env:REMOTE_DESKTOP_TEST_EXE = (Resolve-Path 'artifacts\electron-1.1.10\win-unpacked\Remote Desktop.exe').Path
node --test test/electron.test.cjs test/first-use-electron.test.cjs test/programs-electron.test.cjs test/video-app-electron.test.cjs test/workspace-electron.test.cjs test/browser-electron.test.cjs test/cli-packaged.test.cjs
Remove-Item Env:REMOTE_DESKTOP_TEST_EXE
```

最终包的 SHA-256 及逐文件核验清单保存在 `artifacts/package-1.1.10-verification.json`。

```text
Remote Desktop.exe
ca536302971da872b52a732f98a0ffcbec157955ccb5d54f3190bffceee7e57a

resources/app.asar
1d304b347b644bf618d88dd8485bcd9a0309aecf1b3a9ceb4a318e8ce628235f
```
