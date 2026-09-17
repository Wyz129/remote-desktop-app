# Remote Desktop

在 VS Code 中使用 Remote-SSH 桌面和多个虚拟资源管理器窗口。项目位于 `C:\0_myfiles\new_projects\remote-desktop`。

开发接手请先阅读 [项目交接文档](HANDOFF.md)，其中包含架构、消息协议、环境、测试边界、已知问题和回退方法。

## 安装与打开

1. 在 VS Code 中连接 Remote-SSH。
2. 将 `artifacts/remote-desktop-0.0.6.vsix` 安装到 SSH 服务器端，检查扩展页显示版本 0.0.6。
3. 执行 `Developer: Reload Window`。
4. 执行 `Remote Desktop: Open`。

旧版扩展 ID 为 `local-demo.remote-desktop-demo`，新版为 `local-demo.remote-desktop`，安装新包前请在 SSH 端禁用或卸载旧版，避免两者同时注册命令。现有 `remoteDesktopDemo.*` 设置和服务器桌面配置继续兼容；`remoteDesktop.openDemo` 保留为隐藏命令别名。扩展 ID 改变后，旧 Webview 的窗口会话不迁移。

本地开发可运行 `.\scripts\start-demo.ps1` 或在项目中按 F5。未连接远程时使用内置 Demo，远程连接中使用服务器真实文件。

## 目录与配置

连接后查找用户主目录中的 `Desktop`、`desktop` 或 `桌面`。未找到时，右下角通知询问是否创建；取消不会创建。若没有看到创建提示，可打开 VS Code 通知中心检查。可用 `remoteDesktopDemo.remoteHome` 指定服务器主目录；修改此设置后关闭并重新打开 Demo 标签。

桌面配置首选 `Desktop/.remote-desktop.json`。视图模式使用 `details` 或 `icons`；图标坐标、命令快捷方式和固定程序也保存在此配置中。仅载入配置不会执行其中命令。示例：

```json
{
  "version": 1,
  "viewMode": "icons",
  "wallpaper": "teal",
  "showHiddenFiles": true,
  "positions": {},
  "pinnedApps": [{ "id": "pinned-vim", "label": "Vim", "program": "vim" }],
  "shortcuts": [
    {
      "id": "shortcut-commands",
      "kind": "command",
      "command": "workbench.action.showCommands",
      "label": "命令面板"
    }
  ]
}
```

修改配置后在桌面空白处右键“刷新”，重新读取配置和桌面目录；已打开的目录窗口也重新拉取内容。读取失败会显示错误。

## 文件与窗口

- 双击桌面文件夹打开虚拟资源管理器；双击窗口内的文件夹在该窗口中导航。文件交给 VS Code 编辑器打开。
- 详情模式显示名称、类型、大小各列；图标模式使用大图标网格。
- 桌面和目录窗口使用同一右键菜单。新建和重命名先编辑名称，Enter 或点击外部提交，Escape 取消。提交后重新读取受影响目录。
- Ctrl 单击或框选多个文件后，可复制、剪切、粘贴或发送到桌面。拖入另一窗口的目录区域执行移动。
- 复制遇到同名文件时依次生成 `name(1).txt`、`name(2).txt`；文件夹生成 `folder(1)`。支持在原目录复制，移动遇到冲突仍保留双方文件并提示。
- 远程删除先确认永久删除，再直接删除；不调用远程提供程序不支持的回收站。取消确认不会改变文件。
- 桌面和目录窗口的右键“刷新”重新读取当前目录。
- 每个资源管理器是独立窗口，可同时显示、拖动、最大化。最小化后在左侧保留标签；关闭则移除窗口和标签。
- 资源管理器地址栏支持绝对路径、`~`、`~/目录` 和相对路径；Enter 导航，Escape 恢复当前地址。路径仍需位于远程主目录或已打开的工作区内；无法读取时保留当前目录。
- 资源管理器和终端均可拖动四条边或四个角改变尺寸；最大化后禁用边缘拖动，还原时恢复原尺寸。
- 桌面与图标视图的文件名默认单行省略，选中后展开完整名称；取消选择后恢复省略。
- 桌面图标可拖动并吸附网格；布局写入桌面配置。
- “发送到桌面快捷方式”在远程桌面创建符号链接。文件和文件夹链接均有快捷方式标记；删除链接不会递归删除目标。
- “创建 VS Code 命令快捷方式”使用 VS Code 原生输入界面；创建、重命名和删除均保存到远程桌面配置，双击时才执行命令。

文件读写通过 `vscode.workspace.fs` 完成。符号链接创建需要 Linux Remote-SSH 的远程扩展主机，因为 VS Code 文件系统 API 没有创建符号链接接口；插件在确认主机身份后调用远程 Node.js 的符号链接 API，不执行拼接 shell 命令。

## 桌面终端与服务器状态

“在此处打开终端”在模拟桌面内创建终端窗口，以当前目录作为工作目录。终端使用 xterm.js 和当前扩展主机的原生 PTY，支持交互式 shell、Vim 和 htop。程序必须已安装在服务器并存在于其 PATH 中；缺少程序时显示明确错误。终端需要受信任工作区。

右键左侧任务栏中的 Vim、htop 或终端标签，选择“固定到任务栏”；右键固定图标可取消固定。固定项保存到服务器桌面配置，点击时才启动；最小化保留会话，关闭窗口或关闭整个桌面会结束会话，重新打开桌面不会自动重启程序。

顶栏显示远程账号、连接状态与服务器时区的时间，每 30 秒与扩展主机同步。读取不到服务器信息时不使用本机账号或时间冒充。原生 PTY 取自当前 VS Code / VS Code Server 的安装目录；若后续 VS Code 改变内部模块布局，可能需要更新插件。

## 简约桌面与操作指令

窄顶栏采用 Ubuntu 风格：账号在左、时间居中、连接状态在右。整理桌面、刷新、打开终端均放在右键菜单；资源管理器保留导航、地址和视图切换，文件操作集中在右键菜单。

底栏显示最近一次操作的 Linux 等效命令和结果。复制编号以后端实际生成的目标名称为准，路径以 shell 单引号转义。文件操作仍通过 VS Code API 执行，底栏文本不会作为 shell 命令再次执行；配置、固定应用等没有直接 Linux 命令的操作显示说明。

顶栏右侧仅保留全屏和设置两个图标，栏高保持 32px；右键菜单不再包含全屏。全屏图标切换 VS Code 禅模式，并把当前工作区 `zenMode.centerLayout` 设为 `false`，使桌面铺满可用编辑区。没有打开工作区时使用用户级设置。系统全屏遵循 `zenMode.fullScreen`（默认 true）；再次点击图标或按两次 Esc 退出。桌面、最大化窗口和终端随容器尺寸变化自动适配。

设置图标在桌面内打开设置窗口，可选择资源管理器详情/图标视图、青绿/暮紫/石墨背景，以及是否显示以点开头的隐藏文件。点击“应用”后保存到服务器桌面配置；成功后更新桌面和已打开的资源管理器。取消不更改，失败时保留原视图并提示重试。本地 Demo 设置保存在该 Webview 状态中。

## 测试与打包

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run package
```

- `test:backend`：模拟远程文件系统和 VS Code 接口，验证刷新、操作结果、配置保存和符号链接行为。
- `test:terminal`：使用替身 PTY 验证模块定位、会话接口、输入与尺寸变化、关闭清理及错误路径。
- `test:ui`：Playwright 验证 Webview 的多窗口、输入、拖动、菜单与消息交互，并生成截图。
- `test:vscode`：启动本机隔离 Extension Host，验证激活、消息握手、文件打开与真正的 PTY 输入、输出和尺寸调整。
- `package`：生成 0.0.6 VSIX，不发布到扩展市场。

工具栏使用随安装包附带的 Lucide 图标；终端的 xterm.js 与 FitAddon 也随包提供，不访问外部 CDN。许可证见 `media/*-LICENSE`；`vscode:prepublish` 从开发依赖复制静态资源。

0.0.6 自动化结果与手测清单见 [TESTING.md](TESTING.md) 和 [0.0.6 测试报告](artifacts/regression-006-20260918.md)。本轮不使用电脑操作技能，未将新版安装到用户 SSH 窗口；自动化结果不等同于真实 SSH UI 验收。

0.0.5 后续 SSH 抽测已观察到跨窗口移动和 Vim 的 Ctrl+Shift+V 中文多行粘贴、保存成功，同时发现 F5 会触发 VS Code 调试选择器，详见 [历史抽测报告](docs/mcp-live-ui-review-20260917-b73f.md)。历史报告引用的截图及 VSIX 仅留在本机 `artifacts/`，Git 仓库保留文本报告。

本插件不映射系统盘符，不解析 ODB，不自动运行作业。文件内容由 VS Code 按需打开。
