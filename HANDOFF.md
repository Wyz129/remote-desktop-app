# Remote Desktop 项目交接

更新日期：2026-09-18。交接基线：0.0.6。本文供接手本项目的智能体和开发者使用，记录实际实现、已验证结果、环境限制和下一步定位入口；后续以当前源码、用户的新指令和重新观察到的环境状态为准。

## 1. 接手先读

1. 阅读本文，再读 [README.md](README.md)、[TESTING.md](TESTING.md) 和 [0.0.6 测试报告](artifacts/regression-006-20260918.md)。
2. 项目真实路径为 `C:\0_myfiles\new_projects\remote-desktop`。早期对话中的目录拼写与此不同，请使用实际路径。
3. 这是 **VS Code 扩展**，不是 Codex 插件。无需添加 `.codex-plugin/plugin.json` 或使用 Codex 插件脚手架。
4. 0.0.5 曾安装到真实 Remote-SSH 并完成主要交互实测；0.0.6 按用户要求仅做自动化，没有安装到用户窗口或使用电脑操作技能。
5. 项目已建立 Git，主分支 `main`，仓库 `https://github.com/Wyz129/remote-desktop`（私有）；初始 0.0.5 回退提交为 `4d4cef1`。修改前审查工作树，不要把 `.bak` 当作最新版。
6. 不要把普通浏览器 UI 测试、本机 Extension Host 测试、历史 SSH 实测混为一组“全部真实远程通过”。本文第 9、10 节给出了覆盖边界。
7. 当前代码版本为 0.0.6，重命名后扩展 ID 发生变化；安装迁移按 README 执行。接下来应按用户的新反馈选择工作；第 12 节是建议，不是新的授权范围。

用户的全局规则索引位于 `C:\Users\KunYu\.codex`：编程/测试前读 `编程守则.md`，涉及高危操作时读 `高危操作管控.md`，使用 Python 才读 `python环境使用守则.md`。默认简体中文、英文代码标识符、UTF-8。本项目本身不依赖 Python。

## 2. 项目目标与已确定的交互

在 VS Code 的一个 Webview 标签页中提供类似 Linux/Windows 桌面的图形界面，直接浏览和操作 Remote-SSH 服务器文件，减少终端和目录树操作的学习成本。

- VS Code 原生目录树继续使用；曾经独立的“模拟远程目录”列已经移除。
- 双击桌面文件夹：创建虚拟资源管理器窗口。双击窗口内文件夹：在该窗口中导航。双击普通文件：交给 VS Code 编辑器打开。
- 资源管理器有详情、图标两种视图，可以同时存在多个窗口，支持最小化、恢复、关闭、标题栏移动、最大化、还原及四边四角缩放。
- 左侧 dock 显示运行窗口、最小化窗口和固定程序。关闭窗口要移除运行标签，最小化要保留标签。
- 文件操作使用统一右键菜单：新建文件/文件夹、重命名、复制、剪切、粘贴、删除、发送到桌面快捷方式、命令快捷方式、终端、刷新。
- 新建和重命名就地编辑；按 Enter 或点击外部提交，Escape 取消。后端成功后重读目录。
- 桌面图标可以移动，但吸附到网格。支持 Ctrl 多选和框选；跨窗口文件拖动请求移动操作。
- 文件快捷方式是服务器上的真实符号链接；命令快捷方式是保存在配置中的 VS Code 命令图标。
- 内嵌终端运行真实 PTY，程序入口目前限定为 shell、Vim、htop。窗口关闭会结束相应进程，最小化不会结束。
- 窄顶栏采用 Ubuntu 风格：左账号、中服务器时间、右连接状态。下栏显示最近操作的 Linux **等效命令**及完成/失败/取消状态。

项目不提供系统盘符映射、完整远程图形桌面协议、ODB 解析、自动作业提交或后台任务托管。界面中的 Vim/htop 是 TUI 程序，不是转发服务器 GUI。

## 3. 当前交付与环境快照

| 项目 | 当前基线 |
| --- | --- |
| 扩展 ID | `local-demo.remote-desktop`；旧版 `local-demo.remote-desktop-demo` 应禁用/卸载 |
| 版本 | `0.0.6` |
| 入口命令 | `remoteDesktop.open`；界面名称 `Remote Desktop: Open`；保留 openDemo 隐藏别名 |
| 扩展运行位置 | `extensionKind: ["workspace"]`，Remote-SSH 时安装在服务器端 |
| VS Code 最低声明版本 | `^1.85.0`；最低版本未实测，实际自动化使用 1.137.0 |
| Node / npm | 本次核对为 Node `v24.16.0`、npm `11.13.0` |
| 默认本机 Code | `C:\Users\KunYu\AppData\Local\Programs\Microsoft VS Code\Code.exe` |
| 独立测试 Code | `.vscode-test\vscode-win32-x64-archive-1.137.0\Code.exe` |
| SSH 测试服务器 | `10.2.11.236` |
| 远程账号 / 主机名 | `yizhao.wang` / `kunyu` |
| 真实主目录 | `/home/yizhao.wang` |
| 用户原桌面 | `/home/yizhao.wang/Desktop` |
| 独立测试父目录 | `/home/yizhao.wang/codex-ui-test-20260916` |
| 独立测试桌面 | `/home/yizhao.wang/codex-ui-test-20260916/Desktop` |

0.0.5 实测结束时，已退出禅模式，恢复 VS Code 原侧栏、底部面板和普通窗口布局；Vim、Shell、测试资源管理器窗口已关闭，测试固定项已取消，详情模式已恢复，`remoteHome` 未留下临时工作区覆盖。Demo 显示用户原桌面的 `1234` 文件夹、`.remote-desktop.json`、`123` 文件。

上述状态是交接时的快照。接手后应重新观察当前窗口，不能复用旧窗口句柄、UI 元素编号、截图坐标或把“当时已连接”当作现在仍已连接。

## 4. 目录与代码地图

| 文件/目录 | 职责与阅读入口 |
| --- | --- |
| `package.json`、`package-lock.json` | 版本、扩展声明、命令、配置项、依赖与 npm scripts |
| `extension.js` | VS Code 激活、远程主目录识别、配置读写、文件操作、Webview 消息、服务器信息和全屏委托 |
| `remote-terminal.js` | 从当前 VS Code runtime 加载原生 PTY，管理会话、输入输出、尺寸和关闭 |
| `media/desktop.html` | Webview DOM、资源管理器模板、桌面菜单、dock 菜单、CSP 占位符 |
| `media/desktop.css` | 窄顶栏、网格、图标/详情视图、窗口边框/缩放热区、终端、菜单与窄视口样式 |
| `media/desktop.js` | 前端状态、目录缓存、多窗口导航、选区/拖放、地址栏、文件名编辑、终端渲染与消息处理 |
| `media/lucide.js`、`media/xterm*` | 随包附带的第三方资源和许可证；不要直接修改生成的库文件 |
| `scripts/build-assets.cjs` | 从开发依赖复制 Lucide、xterm、FitAddon 静态资源及许可证 |
| `scripts/start-demo.ps1` | 用隔离用户数据/扩展目录启动本地开发窗口 |
| `scripts/test-vscode.cjs` | 启动隔离 Extension Host；支持 `VSCODE_EXECUTABLE_PATH` |
| `.vscode/launch.json` | F5 扩展开发调试配置 |
| `test/backend.test.cjs` | 模拟 VS Code 文件系统/远程环境的后端测试 |
| `test/terminal.test.cjs` | 使用替身 PTY 的终端生命周期与错误测试 |
| `test/ui.test.cjs` | 本地 HTTP 服务 + Playwright，加载真实前端/xterm，替身扩展消息 |
| `test/vscode/index.js` | 本机真实扩展激活、Webview 握手、VS Code 委托命令、真实 PTY 测试 |
| `artifacts/` | VSIX、报告、自动化 JSON 结果与截图 |
| `.test-data/` | 自动化及本地开发的隔离用户数据、扩展目录；不是业务源码 |
| `.vscode-test/` | 官方独立 VS Code 测试运行时；不是插件依赖，不打入 VSIX |
| `projects/新建文件夹` | 本地 Demo 历史测试留下的目录，不是子项目或构建输入 |
| `*.bak` | 历史改动前副本；不打包，不作为当前入口 |

后端优先搜索这些函数：`nativeRemoteHost`、`remoteHomeUri`、`requireUri`、`readRemoteDirectory`、`inspectRemoteDesktop`、`loadDesktopConfig`、`queueConfigWrite`、`inspectRemoteDirectory`、`fileOperation`、`handleMessage`。

前端优先搜索：`resolveDirectoryAddress`、`navigateWindow`、`commitNavigation`、`requestDirectory`、`refreshAll`、`positionWindow`、`bindWindowResize`、`openTerminal`、`renderDock`、`performAction` 和 `window.addEventListener('message', …)`。这里使用原生 JavaScript/DOM，没有 React、TypeScript 编译或前端框架构建。

## 5. 架构与必须保留的边界

### 5.1 远程主机与本地 Demo

扩展只维护一个 `WebviewPanel`；面板内部可以存在多个虚拟窗口。重复执行打开命令只会显示现有面板。

前端启动发送 `ready`，后端先发服务器信息，再识别并读取远程桌面，回复 `remoteState`。本地窗口收到 `status: 'local'` 后使用前端内置示例数据；远程读取失败必须显示真实错误，不能回退到预设 Demo 文件来伪装成功。

关键历史修复：真正运行在 SSH workspace 扩展主机中时，工作区 URI 通常已经是 `file:`，不是 `vscode-remote:`。不能仅凭 URI scheme 判定本地/远程，也不能假定必须已打开工作区文件夹。`nativeRemoteHost()` 综合 `vscode.env.remoteName`、扩展 URI、实际 `ExtensionKind.Workspace` 和工作区 URI 判断。

主目录选择：优先 `remoteDesktopDemo.remoteHome`，其次真实远程主机 `os.homedir()`；非原生主机仅尝试从已有 `/home/<user>` 或 `/root` 工作区路径推断。账号、主机名、时间必须取自真正的远程扩展进程，不能用 Windows 本机信息冒充。

前端每 30 秒请求服务器信息，按服务器 epoch/timeZone 与本地单调时钟的增量每秒更新时间；超过 90 秒没有新响应时停止显示过期时间，并将已连接状态改为等待响应。这是心跳超时提示，不是对 SSH 网络连接的独立检测。

### 5.2 文件和路径

普通文件读写使用 `vscode.workspace.fs`。目标路径先作 POSIX 规范化，再验证属于当前远程主目录或同一 scheme/authority 的工作区根目录。主目录、桌面目录、工作区根和 `/` 不能作为移动、重命名、删除目标。

该检查是路径/操作边界，不是独立于操作系统权限的文件系统沙箱；不要将它描述为已经审计过所有符号链接穿越场景。

远程删除经一次批量确认后使用永久删除，不使用远程提供程序不支持的回收站；本地路径保留回收站行为。符号链接删除不能递归删除它指向的目标。

复制冲突逐次编号：文件 `name(1).txt`、`name(2).txt`，目录 `folder(1)`。移动同名仍报错并保留双方，不做静默覆盖。创建文件也不能覆盖既有文件或悬空链接。多项文件操作不是完整事务，不承诺遇错时回滚先前成功项；异常路径应观察 `affectedPaths` 与重读结果。

创建文件快捷方式使用远程 Node `fs.symlink`，校验原生远程扩展主机及 `file:` URI；当前验证目标是 Linux，代码没有另设 Linux 平台白名单，不能由此宣称已支持所有远程操作系统。不要拼接 shell 命令来创建。目录读取识别链接、目标类型和断链，并提供快捷方式标记。

### 5.3 前端状态与异步导航

- `directories` 保存路径到目录项的缓存；`state.windows` 保存虚拟窗口、当前目录、历史、位置、尺寸等。
- 目录请求以 `requestId` 保存于 `directoryRequests`；`latestDirectoryRequests` 按路径记录最新请求。导航还必须关联窗口当前的 `pendingNavigation`。
- 只有读取成功才 `commitNavigation()` 并更新返回/前进历史。不存在目录、无权限或过期响应不能把旧目录内容清空。
- Escape 取消待导航并恢复地址；窗口关闭后也不能让迟到回复复活窗口。
- 显式导航的命令提示随 `remoteDirectory.operationCommand` 返回，只有被接受的目录响应才能更新底栏。不要重新改回无关联的独立提示，否则旧请求会覆盖新路径的命令。
- 桌面右键刷新和 F5 调用 `refreshAll()`，刷新配置、桌面及全部已打开目录；目录窗口刷新只针对当前目录。内部读取不带 `intent`，避免覆盖上一次文件操作指令。
- Webview 使用 `retainContextWhenHidden`；`vscode.setState` 保存 UI 状态，恢复时排除终端和临时导航错误。不要承诺所有窗口跨整个 VS Code 重启恢复；主要验证是切标签和面板生命周期。
- `positionWindow()` 必须在隐藏、零尺寸容器和最小化场景保留用户坐标，不能将暂时不可见的布局尺寸写回位置。

### 5.4 窗口、名称和全屏

窗口缩放有 `n/ne/e/se/s/sw/w/nw` 八个 pointer handle；默认最小 300×220，窄视口再限制尺寸。最大化禁用 resize；还原保留用户尺寸。角热区在边框内，真实 UI 测试落在边框外曾未触发，移入角内后成功。

桌面和图标模式名称默认单行 `ellipsis`，选中后自适应高度并完整换行，不能再次限制为两行截断。

0.0.6 全屏入口是顶栏 `#fullscreen` 图标，右键菜单已移除该选项。每次只执行一次 `workbench.action.toggleZenMode`，避免先退出再进入导致原生全屏竞态。按用户明确选择，将当前工作区 `zenMode.centerLayout` 保持为 false；无工作区使用用户级。若原值 false，短暂设 true，再切换，最后设 false，以配置事件消除进入前的手动居中状态。命令失败时尝试还原临时值并报告错误。系统全屏仍遵循 `zenMode.fullScreen`。再次点图标或双 Esc 退出；不推测当前 inZenMode 状态，成功回复仅表示命令链完成。

前端用 100% 容器布局和 ResizeObserver 重排图标/窗口、调整 xterm；保留隐藏 Webview 的零尺寸保护。设置入口 `#desktopSettings` 打开原生 dialog（显示在虚拟桌面内），含视图、背景和隐藏文件选项，成功确认后才应用，15 秒无确认时允许核对后重试。

### 5.5 内嵌终端

前端为 xterm.js + FitAddon，后端通过 `remote-terminal.js` 加载当前 VS Code / VS Code Server runtime 中的 `node-pty` 或 `@vscode/node-pty`，支持普通、asar、asar.unpacked 路径。不要从工作区或 `NODE_PATH` 加载同名原生模块，不要直接把 Windows 构建的 node-pty 打进 Linux 扩展包。

启动需要受信任工作区和正确扩展主机，工作目录经过后端 URI 校验。程序是 `shell`、`vim`、`htop` 白名单；Vim/htop 从绝对 PATH 项解析，缺失就明确报错。固定应用目前只存程序身份，不存启动目录或任意命令参数；点击固定项从桌面根目录启动。

限制：总计 12 个会话，每面板 8 个；单次输入 64 KiB，待发送输出 2 MiB；行列范围 2–500 列、1–200 行。关闭待启动窗口要取消启动并避免孤儿 PTY。关闭 Webview 会清理其终端，恢复配置不自动运行程序。

底栏只显示终端启动的等效命令，并等待 `terminalOpened`。终端键盘输入不记入此提示或日志。真实 shell 内输入仍会执行程序，这是正常终端行为。

## 6. 消息协议速查

以下是当前核心协议，不是对所有兼容别名的完整枚举；具体字段以两端源码为准。新增消息需同步后端、前端和对应测试。

| 前端 → 扩展 | 关键字段 | 扩展 → 前端 / 用途 |
| --- | --- | --- |
| `ready` | 无 | `serverInfo`、`remoteState` 初始化 |
| `getServerInfo` | 无 | `serverInfo`：username、hostname、epochMs、timeZone、platform、remote |
| `readDirectory` | path、requestId，可带 windowId、intent | `remoteDirectory`：path、requestId、entries 或 error；显式操作附带 operationCommand |
| `refreshRemote` | paths，可带 intent: refresh | `remoteState` 重载桌面/config；请求涉及的目录重读 |
| `openResource` | path | 文件通过 `vscode.open`；直接请求目录可 `revealInExplorer`，正常前端文件夹双击走虚拟导航 |
| `fileOperation` | operation、requestId；按操作带 parent/name/paths/clipboard | `operationResult`：success/ok、cancelled/error、paths、affectedPaths；操作后重读 |
| `saveDesktopConfig` | config、可选 requestId | `configSaved`；补丁处理 positions/viewMode/wallpaper/showHiddenFiles |
| `createCommandShortcut` | 无 | VS Code 原生命令选择/名称输入，保存后 `configUpdated` |
| `renameCommandShortcut` / `deleteCommandShortcut` | id，重命名还带 label | `configUpdated` |
| `executeCommand` | command | 仅运行已保存快捷方式中的命令，且需工作区信任；目前不转发任意 args |
| `pinApp` / `unpinApp` | app: {id,label,program} / id | `configUpdated` |
| `openTerminal` | id、path、program、cols、rows | `terminalOpened` / `terminalError` |
| `terminalInput` / `terminalResize` / `terminalClose` | id 与 data / cols,rows / 无 | `terminalData`、`terminalExit`、`terminalError` |
| `toggleFullscreen` | 无 | `fullscreenResult`，委托 VS Code 禅模式 |

独立 `operationCommand` 消息用于文件操作、配置/固定、终端启动和 VS Code 操作，字段为 `command`、`status: success|error|cancelled`、可选 `detail`。导航/目录刷新结果的提示现在嵌在 `remoteDirectory` 中。`#operationCommand` 与 `#operationStatus` 独立于通知区 `#notice`，普通通知不应擦除指令。

常用测试定位：地址 `input.window-path[aria-label="目录地址"]`；缩放 `.resize-handle[data-resize]`；dock 菜单 `#appContext`、`#togglePinApp`、`#unpinApp`；全屏 `#fullscreen`；设置 `#settingsDialog`、`#settingsForm`。

## 7. 远程配置与持久化

### VS Code 设置

| 设置 | 默认 | 用途 |
| --- | --- | --- |
| `remoteDesktopDemo.openOnStartup` | false | 扩展激活后自动开面板 |
| `remoteDesktopDemo.remoteHome` | 空字符串 | 远程主目录覆盖；为空自动检测。改变后关闭重开面板 |
| `remoteDesktopDemo.remoteRoot` | `/home/demo` | 本地示例路径映射，不是远程桌面路径设置 |

扩展在主目录列举 `Desktop`、`desktop` 或 `桌面`（Desktop 匹配大小写不敏感）。未找到则弹出 VS Code 通知，请用户确认创建 `Desktop`；取消不创建。

### 配置文件查找顺序

1. `<Desktop>/.remote-desktop.json`
2. `<Desktop>/config.json`
3. `<home>/.config/remote-desktop/config.json`
4. `<home>/.remote-desktop.json`

首个存在且可读有效文件成为写回位置；全部缺失时选择第 1 项。遇到存在但无效/不可读配置会报告错误并停止查找，不能把损坏配置静默覆盖成默认值。

```json
{
  "version": 1,
  "viewMode": "details",
  "wallpaper": "teal",
  "showHiddenFiles": true,
  "positions": {},
  "shortcuts": [
    {
      "id": "shortcut-commands",
      "kind": "command",
      "command": "workbench.action.showCommands",
      "label": "命令面板"
    }
  ],
  "pinnedApps": [
    { "id": "pinned-vim", "label": "Vim", "program": "vim" }
  ]
}
```

wallpaper 可选 teal/purple/slate（默认 teal）；showHiddenFiles 必须是布尔值（默认 true，保持旧版行为）。隐藏仅按文件名首字符为点过滤，不修改服务器目录。

配置最大 64 KiB；固定项最多 32 个，ID 不能重复。前端位置/视图保存有 220ms 防抖；后端 `configQueue` 串行读取、发布刷新快照及合并写入配置，保留未知字段，先写临时文件再 rename。此队列约束当前扩展实例，不是跨多个 VS Code 窗口的分布式锁。

命令快捷方式、固定项有各自的后端更新路径，不能用普通 `saveDesktopConfig` 任意替换。加载配置不自动执行命令或启动终端。真实文件符号链接由目录读取识别，不依赖 `shortcuts` 数组重建。

## 8. 开发、测试与打包

以下命令在 PowerShell、项目根目录执行。现有依赖已经安装，只有首次准备/锁文件变化需要 `npm.cmd ci`。

```powershell
Set-Location 'C:\0_myfiles\new_projects\remote-desktop'
npm.cmd ci
npm.cmd run vscode:prepublish
npm.cmd run check
npm.cmd run test:backend
npm.cmd run test:terminal
npm.cmd run test:ui
npm.cmd run test:vscode
npm.cmd run package
```

`npm.cmd test` 按 scripts 顺序执行完整检查；针对小改动先跑相关测试，失败或有额外疑点才扩大范围。单纯交接文档更新不需要重新运行功能测试。

UI 测试当前使用 `chromium.launch({ channel: 'chrome', headless: true })`，依赖已安装 Google Chrome；只安装 Playwright Chromium 并不能满足这个 channel 配置。测试自动启动 localhost 随机端口 HTTP 服务，退出关闭服务和浏览器。

`test:vscode` 未提供 VSCODE_EXECUTABLE_PATH 时由 @vscode/test-electron 下载官方运行时。每次使用独立 `.test-data/run-*` 用户数据、扩展和夹具工作区目录，避免全屏偏好测试写入项目设置；临时移除并恢复 ELECTRON_RUN_AS_NODE。可指定本机已有的独立测试副本：

```powershell
$savedVsCodePath = $env:VSCODE_EXECUTABLE_PATH
try {
    $env:VSCODE_EXECUTABLE_PATH = (Resolve-Path '.vscode-test\vscode-win32-x64-archive-1.137.0\Code.exe').Path
    npm.cmd run test:vscode
} finally {
    if ($null -eq $savedVsCodePath) {
        Remove-Item Env:VSCODE_EXECUTABLE_PATH -ErrorAction SilentlyContinue
    } else {
        $env:VSCODE_EXECUTABLE_PATH = $savedVsCodePath
    }
}
```

若副本不存在，可使用 `@vscode/test-electron` 的 `downloadAndUnzipVSCode('1.137.0')` 获取官方运行时，返回路径后再设置 `VSCODE_EXECUTABLE_PATH`。不要删除原 VS Code 更新锁、替换 `new_Code.exe` 或中断更新。Code 的 resources 可能在版本子目录，不能假定总在安装根目录。

本地开发：打开项目按 F5，或运行 `./scripts/start-demo.ps1`。该脚本使用 `.test-data/demo-profile` 和 `.test-data/demo-extensions`，默认自动打开面板；本地示例只能验证界面，不能证明真实 SSH 文件接入。

打包使用 `@vscode/vsce`，prepublish 自动复制静态资源。当前没有运行时 npm dependencies，静态库随 `media/` 打包。版本升级同时修改 `package.json`、lockfile 根版本以及 package script 的 VSIX 输出文件名，并更新文档。不要只改文件名而保留旧版本号。

`.vscodeignore` 排除备份、测试、scripts、artifacts、node_modules、`.test-data`、`.vscode-test` 及本交接文档。确认包内包含 extension.js、remote-terminal.js、三份前端源码、图标/终端库及许可证。项目不发布 Marketplace；交付物是本地 VSIX。

## 9. 测试基线与证据

0.0.6 最新结果见 [本轮报告](artifacts/regression-006-20260918.md)。后续 0.0.5 的独立 SSH 抽测见 [MCP 实测](docs/mcp-live-ui-review-20260917-b73f.md)：跨窗口移动、Vim Ctrl+Shift+V 中文多行粘贴和保存通过，F5 宿主快捷键冲突待解决。以下表格保留 0.0.5 原始开发基线，不代表新版已在 SSH 验收。

| 测试层 | 0.0.5 结果 | 能说明什么 |
| --- | --- | --- |
| JS 语法检查 | 通过 | 三份核心 JS 可解析 |
| 后端 | 28/28 | 替身文件系统、路径/冲突/配置/命令/全屏委托等逻辑 |
| 终端单测 | 10/10 | 替身 PTY 会话隔离、取消启动、流量/尺寸/清理等逻辑 |
| Playwright UI | 29/29 | 真实 DOM、布局、指针交互和 xterm 渲染，扩展边界使用替身消息 |
| 本机 Extension Host | 31/31 | 真实 VS Code 1.137.0 激活、Webview 握手、资源委托、全屏切换及本机 PTY |

`artifacts/ui-smoke.json` 与 `artifacts/vscode-smoke.json` 会被后续运行覆盖。历史报告中的计数属于对应版本，不要把当前 JSON 作为历史原始产物。测试失败时也会写诊断/截图，请核对 timestamp、success/passed。

0.0.5 已查看自动化截图：`desktop-005.png`、`explorer-005.png`、`resize-005.png`、`long-names-005.png`。它们是浏览器测试截图，不是 SSH 界面截图。真实 SSH 通过 Computer Use 即时观察，未另存静态截图文件。

0.0.5 真实 SSH 已验证：服务器端安装/重载、真实桌面读取、窄栏账号时钟、右键菜单全屏进入/退出、地址栏 `~/…` 读取真实测试目录、对应 Linux 命令、精简资源管理器、图标视图切换、两种图标区域长名称展开、右下角缩放、内嵌 Shell/Vim 启动、dock 右键固定/取消、关闭会话和恢复环境。其他边缘方向与最大化还原由本轮 UI 自动化覆盖，不能说每个方向都经过 SSH 实测。

0.0.4 历史 SSH 已验证：远程删除取消/确认、文件夹永久删除、同名文件/目录复制、Vim 单按键交互、htop 交互退出、固定项关闭重开后的保留、桌面及目录右键刷新。0.0.5 没有重测全部这些 SSH 操作。

详细记录依次见：

- [0.0.5 回归与真实 SSH](artifacts/regression-005-20260917.md)
- [0.0.4 回归与真实 SSH](artifacts/regression-004-20260917.md)
- [0.0.3 历史真实 UI](artifacts/live-ui-test-20260916.md)

## 10. 安装到现有 Remote-SSH 并测试 UI

1. 先观察目标 VS Code 窗口，确认 SSH 目标和用户，避免把本机 Extension Development Host 当作远程工作台。
2. 命令面板执行 `Extensions: Install from VSIX…`。Remote-SSH 的选择器初始可能显示服务器路径，点击“显示本地”选择本机 VSIX。
3. 0.0.6 改为 local-demo.remote-desktop，必须禁用/卸载旧 ID local-demo.remote-desktop-demo，避免重复激活。服务器配置和 remoteDesktopDemo.* 设置继续兼容；旧 Webview 会话不迁移。
4. 执行 `Developer: Reload Window`；如果 SSH 要求认证，由用户完成。重载可能结束该面板的 PTY，会话有未保存内容时先处理。
5. 执行 `Remote Desktop: Open`，确认真正的主目录、账号和目录内容，不只看插件版本。
6. 阅读目录可直接用地址栏进入独立测试目录。涉及桌面布局、固定应用、配置持久化时，优先临时把**工作区** `remoteDesktopDemo.remoteHome` 设为 `/home/yizhao.wang/codex-ui-test-20260916`，关闭重开面板，使配置写入测试桌面。
7. 测试结束通过“重置此设置”移除该工作区覆盖（不要用另一个错误值替代），关闭重开面板，确认恢复 `/home/yizhao.wang/Desktop`。保留已有测试数据，关闭自己创建的终端/编辑器。

服务器测试目录的 source 当前曾观察到 `external-created.txt`、`refresh-004.txt`、`remote-created.txt`、`remote-created(2).txt`、`renamed-copy.txt`；`remote-created*.txt` 为 92 B。target、桌面配置、Vim `.swp` 等历史数据仍可能存在。使用前重新检查，不要批量清空测试父目录，也不要拿用户原桌面文件做删除测试。

### Computer Use 的实践记录

0.0.5 当时使用技能 `C:\Users\KunYu\.codex\plugins\cache\openai-bundled\computer-use\26.908.70816\skills\computer-use\SKILL.md`，其 docs/guidance.md、api.md、confirmations.md 规定 Windows 操作流程。接手环境可能有新版本，先读取当时提供的技能，不把本文当作新工具 API 文档。

0.0.5 当时 Windows UI 接口为 `node_repl` + `@oai/sky`：先 `list_windows`，从真实返回对象唯一选择 VS Code，再 `get_window` / `activate_window` / `get_window_state`。每次输入后重新观察，优先用最新可访问性元素编号；原生 Webview 更新有时迟一拍，先再观察，不要重复点击导致双操作。

截图可能受当前前台/遮挡影响。若请求 VS Code 却看到 Chrome 或其他应用，先激活并重新截图，不能根据不匹配截图点击。出现“user input was detected”先重新观察用户更改。缩放拖动须落在边框内部热区；键入地址前先点击地址栏并 Ctrl+A 确认选中。该环境 `sky.set_value` 曾报 UIA CacheRequest 错误，已改用正常键盘输入。

不要操作右侧 Codex/聊天扩展或认证界面，不使用 Windows UI 自动化输入 shell 命令，不混入 PowerShell UIAutomation/SendKeys。命令行构建与文件检查使用普通 exec 工具；Vim/htop 通过插件现成按钮启动。具体许可和确认规则以当次用户授权及已加载技能为准。本文只记录历史事实，不代表允许对其他目录/服务器执行操作。

SSH BatchMode 曾因需要密码失败，不要据此假定存在可用的免密 SSH 通道，也不要反复尝试自动认证。

## 11. 已知问题、限制与未覆盖项

| 项目 | 状态 | 下一步定位入口 |
| --- | --- | --- |
| 真实 Electron Webview 跨窗口拖放 | 后续 b73f 抽测完成中文空格文件跨窗口移动及刷新；早期失败仍为历史记录 | 前端拖放开始/结束、pointer/native drag 生命周期、异步 renderWindow 是否移除源 DOM；分别验证输入工具与插件 |
| Vim 整段粘贴 | 后续 b73f 用 Ctrl+Shift+V 粘贴并保存通过；普通 Ctrl+V 是控制键 | xterm 键盘/粘贴事件、输入工具行为、VS Code Webview 焦点；不要直接归因某一端 |
| 终端中文输入/保存文件 | b73f 中文多行粘贴/保存通过；IME 逐字输入未覆盖 | IME composition、粘贴、多字节数据、实际保存后内容核验 |
| 缺少 Desktop 的确认提示 | 功能可用，但通知曾被收进通知中心，面板看起来持续等待；没有单独“等待用户确认”状态 | `inspectRemoteDesktop`、初始化状态与 VS Code 通知 UX |
| 真实 SSH 断连/重连 | 90 秒过期状态和恢复有替身测试，真实网络断连未实测 | serverInfo 轮询、时钟锚点、SSH 恢复、会话生命周期 |
| PTY runtime 兼容 | 依赖 VS Code 内部模块目录，未来升级可能失效 | `ptyCandidates`、`loadRuntimePty` 和 Remote Desktop 输出 |
| 固定应用能力 | 仅 shell/Vim/htop，不支持任意程序、启动参数或每图标 cwd | 如扩展需重新设计配置、校验、迁移与测试 |
| 全屏 | 0.0.6 改为顶栏图标切换和非居中；本轮未做 SSH UI 验证 | 原生 OS 切换与平台/VS Code 版本边界仍需实机观察 |
| F5 快捷键冲突 | b73f 观察刷新同时触发宿主调试选择器，本轮未修复 | 按键作用域与 VS Code Webview 传播 |
| 目录范围 | 主目录或已打开工作区内；不是任意服务器路径浏览器 | 地址提示与 `requireUri` 边界保持一致 |
| 大目录/大型终端输出 | 没有规模压测；目录对各项读取 metadata，终端有输出上限 | 列表渲染、并发 stat、缓存和输出背压 |
| 文件系统变化 | 显式刷新和操作后重读；没有承诺自动文件监控 | 若需要实时外部变化，应单独设计 watcher |

隐藏 Webview 时零尺寸覆盖窗口位置的问题已在 0.0.4 修复，并在 0.0.5 回归保留。导航旧响应覆盖底栏的问题已在 0.0.5 用嵌入式 operationCommand 修复。不要把这两项继续列成未修复，也不要因此认定整个跨窗口拖放已经解决。

## 12. 建议的后续工作顺序

1. 收到新反馈后先确认已安装的扩展 ID/版本，在隔离目录复现，记录实际操作、预期、观察和时间；确认是否正在运行旧包。
2. 若用户优先完善核心交互，先处理 F5 宿主快捷键冲突，再按实际复现补充拖放和终端输入边界，而非再增加模拟页面测试来替代实测。
3. 改善创建桌面时的等待确认状态，避免通知中心收起后界面看似卡住。
4. 覆盖真实断连/重连、关闭重开/重新加载后的持久化、权限失败和目录规模。
5. 源码修改、相关自动化、VSIX 打包、SSH 端安装、关键路径实测形成闭环。报告分别列自动化、当次 SSH 实测、未覆盖项。

这些是待选择的方向，不要求接手智能体在没有新需求时自动全部实施，也不应顺带重构整套前端或更换工具框架。

## 13. 排障速查

| 现象 | 先查什么 |
| --- | --- |
| SSH 窗口仍显示 projects/results/datasets 等预设文件 | 是否装在 SSH workspace 主机、是否 Reload；nativeRemoteHost/remoteState，不要再用 Demo 回退掩盖失败 |
| 正在读取桌面不结束 | VS Code 通知中心是否等待创建确认；Remote Desktop 输出 |
| 地址输入没生效 | Enter 是否送到地址栏；是否属于允许路径；最新 remoteDirectory 的 requestId/window 关联 |
| 外部新增文件看不到 | 桌面右键刷新/F5 或目录窗口刷新；当前是否还运行旧前端 |
| 文件操作后底栏提示不匹配 | 是否被内部读取或过期导航覆盖；核对 embedded operationCommand |
| `workbench.action.files.refreshFilesExplorer` not found | 这是历史错误命令，当前实现不应依赖它；使用文件系统重读 |
| 远程回收站不支持 | 确认跑的是 0.0.4+；远程删除路径不能使用 useTrash: true |
| 终端原生模块加载失败 | 扩展主机、工作区信任、runtime 模块候选路径、VS Code Server 版本；别装随机 node-pty 来掩盖 ABI 问题 |
| 已固定但点开 cwd 不同 | 当前设计从桌面根目录启动，不保留原窗口 cwd |
| 自动化 Code 启动被更新锁阻挡 | 使用独立测试副本，不处理用户的更新安装文件 |
| 模板打不开或 Webview 空白 | CSP nonce、asWebviewUri 替换、media 静态文件是否构建并打包；扩展输出与前端错误 |

输出通道为 **Remote Desktop**；安装/连接日志另见 **Remote - SSH**。扩展 `activate()` 返回测试诊断 API：`getDiagnostics`、`closeDemo`、`openResource`、`handleMessage`、`fileOperation`、`refreshRemote`、`readRemoteDirectory`。诊断含 openPanels、ready、readyCount、remoteState、nativeRemoteHost、configPath、configError，可在扩展测试内使用；它不是普通用户的 UI 命令。

## 14. 版本、安装包与回退

当前交付包：`artifacts/remote-desktop-0.0.6.vsix`，体积、SHA-256 和包内核对结果见 [0.0.6 报告](artifacts/regression-006-20260918.md)。0.0.6 未自动安装到用户 SSH 窗口。旧 VSIX 和本机截图保留于 artifacts，但 Git 只追踪文本报告。

源码初始导入提交 `4d4cef1` 保留 0.0.5，实现之前建立的回退点；用新分支/独立目录比较，不改写已推送历史。

| 检查点 | 路径 | 大小 |
| --- | --- | --- |
| 0.0.5 修改前 | `C:\0_myfiles\new_projects\remote-desktop-demo-before-005-20260917.zip` | 34,875,885 B |
| 0.0.4 修改前 | `C:\0_myfiles\new_projects\remote-desktop-demo-before-004-20260917.zip` | 195,992 B |
| 早期反馈修改前 | `C:\0_myfiles\new_projects\remote-desktop-demo-before-feedback-20260910.zip` | 71,936 B |

这些是对应时点的源码/项目备份，不是远程用户数据备份，大小差异来自包含的历史产物不同。0.0.5 修改前备份排除了 node_modules 和 .vscode-test。旧 VSIX 仍在 artifacts；回退运行版本可在 SSH 端安装对应 VSIX 并重载，回退源码先解到独立目录比较，不覆盖当前改动或删除服务器 Desktop。

## 15. 可直接交给下一个智能体的起始提示

> 继续开发 `C:\0_myfiles\new_projects\remote-desktop`。先阅读 HANDOFF.md、README.md、TESTING.md 和 artifacts/regression-006-20260918.md。项目是 VS Code Remote-SSH 桌面扩展，当前源码 0.0.6，已建立 Git 和私有 GitHub 仓库。旧 ID local-demo.remote-desktop-demo 的 0.0.5 曾实测；新版 ID local-demo.remote-desktop 仅经自动化，不要把旧版运行窗口当作新版。按我接下来的需求实施；分别记录替身自动化、本机 Extension Host、真实 SSH UI 结果。保持服务器桌面配置与 remoteDesktopDemo.* 兼容，不清理用户目录。当前轮无需电脑操作技能验证；后续操作以新授权为准。
