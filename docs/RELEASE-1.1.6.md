# 1.1.6 本地交付记录

日期：2026-09-20。回退分支：`checkpoint/pre-app-grid-1.1.5`。本轮本地修改、提交与打包，不推送 GitHub。

## 修改内容

- 设置和传输中心保留增强按钮配色；其余既有按钮恢复 1.1.4 状态。浏览器与 Monaco 的 CSS 和 `435a4a4` 完全一致，桌面增强色限定在 `#settingsDialog`、`#downloadsPanel`。
- 移除侧栏上的 Monaco Editor 与图片查看器固定入口；图片打开后的动态窗口标签继续用于切换和恢复窗口。
- 侧栏底部增加九点“应用”按钮，展开 Ubuntu 风格的应用网格。包含浏览器、传输中心、实时监听、htop、Monaco Editor、图片查看器。顶部原有入口和用户自行固定的程序继续可用。
- 应用面板支持搜索、方向键、Tab、Enter 与 Esc；点击外部或启动应用后收起。连接断开时关闭面板，远程应用不可启动，仍可查看传输历史与监听记录。htop 使用已有远程终端服务，要求服务器已安装 htop。
- 浏览器原生网页视图在面板打开时隐藏，关闭面板后恢复，避免遮住应用网格。浏览器、图片查看器的启动入口复用已有窗口行为；实时监听保持单窗口。
- 应用名称统一显示为“浏览器”，保留经 SSH 使用服务器网络和 DNS 的原有行为。

视频功能本轮仅讨论，未安装依赖、实现播放器或修改服务器；方案见 [远程视频播放讨论](VIDEO-OPTIONS.md)。

## 程序与校验

启动：`artifacts/electron-1.1.6/win-unpacked/Remote Desktop.exe`。Windows x64、Electron 44.4.2，请保留整个展开目录。33 个应用源码文件已与包内副本逐字节核对，包内版本为 1.1.6。

| 文件 | SHA-256 |
| --- | --- |
| `Remote Desktop.exe` | `b206fa69cd50fab8fc4d0fff1a086a2afe7ad9f20c464da6ae6a85abb3c2808f` |
| `resources/app.asar` | `d8d8ae7360a528142d053e1bedd30be100d458db2878688d97b23779f32ffd25` |

```powershell
npm.cmd run check
node --test test/standalone-ui.test.cjs test/workbench-ui.test.cjs
node --test test/electron.test.cjs test/workspace-electron.test.cjs test/browser-electron.test.cjs
npm.cmd run package -- --config.electronDist=node_modules/electron/dist
$env:REMOTE_DESKTOP_TEST_EXE = (Resolve-Path 'artifacts/electron-1.1.6/win-unpacked/Remote Desktop.exe').Path
node --test test/electron.test.cjs test/workspace-electron.test.cjs test/browser-electron.test.cjs test/cli-packaged.test.cjs
```

## 验证范围

| 检查 | 结果 |
| --- | --- |
| 语法 | 33 个 JS/CJS 文件通过 |
| 桌面 UI | 42/42 |
| Monaco UI 与管理器 | 11/11 |
| 源码 Electron、工作区、浏览器 | 4/4 |
| 打包 EXE 的桌面、工作区、浏览器与 CLI | 5/5，另外执行 |

源码定向回归共 57 项通过。首轮合并运行有一次等待编辑器时收到页面已关闭的错误，独立复核通过；随后将测试等待的新窗口限定为 Monaco 页面，避开场景中临时安全测试窗口的迟到事件，再次验证通过。重复运行不另计数量。

新增两项桌面交互场景覆盖应用面板的六个入口、底部位置、搜索/空结果、键盘、离线限制、断连收起、浏览器与监听窗口复用。真实 Electron 场景另检查打开应用面板时两个原生浏览器子视图均隐藏，以及重新启动浏览器时恢复已有视图。工作区集成通过应用面板打开真实 Monaco 未命名文档。

已检查真实渲染器截图 `artifacts/standalone-applications.png`，以及资源管理器、设置、传输等界面。额外布局截图 `artifacts/applications-layout-1440.png` 和 `artifacts/applications-layout-560.png` 检查宽屏三列、窄屏两列和溢出，属于隔离布局检查。

所有 SSH/SFTP、Jupyter 和网页测试均使用本机隔离夹具，未连接用户真实服务器或操作已有桌面实例；本轮没有重新宣称上一版的后端与 Vim 全量测试为本轮结果。htop 启动验证覆盖请求路由，不代表用户服务器已安装该程序。
