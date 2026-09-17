# 0.0.3 Remote-SSH 真实 UI 实测（2026-09-16 至 17）

状态：本轮实测结束，临时工作区设置已恢复，插件已重新显示用户原桌面。核心文件操作与配置持久化通过；确认通知、虚拟窗口位置和跨窗口拖放仍有问题或待定位项，不能视为全部通过。

## 环境与隔离方式

- 使用用户已经打开的 VS Code 窗口，连接 `SSH: 10.2.11.236`，远程用户为 `yizhao.wang`。
- 在 SSH 服务器端卸载旧版 0.0.2，安装 `remote-desktop-demo-0.0.3.vsix`；扩展详情页确认 0.0.3 已在 SSH 端启用。
- 重载窗口后由用户完成 SSH 重新认证，再通过 `Remote Desktop: Open Demo` 打开插件。
- 首先确认插件显示 `Remote-SSH · 已连接`，读取 `/home/yizhao.wang/Desktop`，其中存在用户原有的 `1234/` 和 `123`。
- 用 VS Code 原生资源管理器创建独立测试父目录 `/home/yizhao.wang/codex-ui-test-20260916`，再在工作区临时设置 `remoteDesktopDemo.remoteHome` 指向此目录。文件操作只使用该目录内的测试内容。
- 测试桌面为 `/home/yizhao.wang/codex-ui-test-20260916/Desktop`。切换 `remoteHome` 后关闭并重新打开 Demo 标签使设置生效。

本轮通过实际 VS Code 图形界面操作，没有修改插件源码、重新打包或重跑自动化测试。以下结果不能与 2026-09-10 的模拟后端、浏览器 UI 或本机 Extension Host 测试合并计数。

## 已确认结果

| 项目 | 结果 | 实际观察 |
| --- | --- | --- |
| SSH 端安装与激活 | 通过 | 扩展详情显示 0.0.3 在 SSH 服务器端启用，插件能打开。 |
| 真实远程目录接入 | 通过 | 读取真实 `/home/yizhao.wang/Desktop` 与已有内容，不再只显示内置 Demo 文件。 |
| 缺少 Desktop 时请求创建 | 功能通过，提示体验有问题 | 独立父目录中未找到 Desktop 时产生确认通知；在通知中心点击“创建 Desktop 文件夹”后成功载入。通知可见性问题见下文。 |
| 桌面右键新建文件夹 | 通过 | 先出现就地名称编辑，输入 `source`、`target` 后按 Enter，目录创建并立即出现在桌面。 |
| 桌面文件夹双击 | 通过 | 双击 `source`，虚拟资源管理器显示测试桌面下的真实 `source` 路径。 |
| 桌面与资源管理器右键菜单一致 | 通过 | 资源管理器内容空白处显示与桌面一致的文件操作菜单。 |
| 资源管理器新建文件与即时刷新 | 通过 | 在 `source` 内就地输入 `remote-created.txt`，Enter 提交后详情行立即出现，初始大小为 0 B。 |
| 文件双击与 VS Code 保存 | 通过 | 双击文件打开远程编辑器，写入下方三行测试内容并 Ctrl+S 保存；刷新后文件大小为 92 B。 |
| 详情与图标视图切换 | 通过 | 详情行和小图标立即切换为大图标卡片；切回详情模式后恢复列表。 |
| Escape 取消新建 | 通过 | 新建文件夹命名时按 Escape，插件和原生目录树均未生成目录。 |
| 外部新增文件后的刷新 | 通过 | 用 VS Code 原生资源管理器在 source 新建 `external-created.txt`；点击虚拟窗口刷新后立即显示，未报告不存在的刷新命令。 |
| 多窗口并存与窗口移动 | 通过，但切标签有位置问题 | source、target 可同时打开并拖动标题栏并排显示；切换编辑器标签后的异常单列记录。 |
| 最小化与关闭 | 通过 | 最小化后保留 dock 标签，点击恢复；红色 X 关闭后对应 dock 标签立即移除。 |
| 框选多个文件 | 通过 | 框选 source 中两个文件，底部显示“已选择 2 项”。 |
| 多选复制粘贴 | 通过 | 将 source 两个文件复制到 target，源文件保留，目标出现 0 B 和 92 B 的副本；目标文本内容正确。 |
| 就地重命名 | 通过 | target 中 `external-created.txt` 改为 `renamed-copy.txt`；默认仅选中 basename，保留扩展名，Enter 后自动刷新。 |
| 工具栏剪切粘贴 | 通过 | 将 target 中 `renamed-copy.txt` 剪切，再进入 source 粘贴；source 出现该文件，原生目录树中 target 已无该文件。 |
| 桌面图标移动与网格吸附 | 通过 | 将 source 拖到右下方，图标吸附网格；顶部刷新、关闭并重开 Demo 后仍保留位置。 |
| 文件符号链接快捷方式 | 通过 | 将 target 的 `remote-created.txt` 发送到桌面，生成带箭头的 `remote-created.txt - 快捷方式`，原生目录树显示链接装饰；双击在 VS Code 中读到原文件内容。 |
| 删除文件链接时保留目标 | 通过 | 在插件中删除上述测试链接，链接从桌面及原生目录树消失；重新打开 target 中原文件，三行内容完整、大小仍为 92 B。 |
| 命令快捷方式创建与执行 | 通过 | 原生 Quick Pick 选择 `workbench.action.showCommands`，名称设为 `UI Test Commands`；桌面生成命令图标，双击成功打开 VS Code 命令面板。 |
| 快捷方式持久化 | 通过，限关闭重开 Demo | 关闭并重开 Demo 后，命令快捷方式和文件链接均保留；之后才执行删除测试链接。未在创建快捷方式后重启整个 VS Code 或重新认证 SSH。 |
| 测试设置恢复 | 通过 | 工作区 remoteHome 通过“重置此设置”移除；关闭重开 Demo 后显示 `/home/yizhao.wang/Desktop` 及原有 `1234/`、`123`。 |
| 多窗口跨目录拖动 | 未完成，原因待定位 | 将 `target/renamed-copy.txt` 详情行拖向 `source` 内容空白处，目标区高亮；放手后高亮残留，两目录内容不变，未出现“正在执行文件操作”。不能据此确定是插件还是输入工具的问题。 |
| 切换 VS Code 标签后的窗口位置 | 发现问题 | 切换标签再返回时，已移动的虚拟窗口位置回到左上附近。源码存在隐藏或缩小布局期间覆写坐标的风险，见下文。 |

测试文本内容：

```text
CODEX_REMOTE_UI_TEST_20260916
Created through VS Code Remote-SSH editor.
Payload version: 1
```

## 本轮未覆盖

- 修改配置文件 viewMode 后，刷新是否同时改变已有窗口和新窗口的初始视图。
- 文件夹符号链接的创建、导航与删除；本轮链接测试对象为普通文本文件。
- 命令快捷方式的重命名与删除、带参数命令。
- 创建快捷方式后重启整个 VS Code、断线重连，以及权限失败、同名冲突等异常路径。
- 跨窗口拖动尚未成功，不计入通过；普通剪切粘贴成功不能替代拖放验收。

## 发现的问题与定位边界

### 1. 创建 Desktop 的通知被收进通知中心

缺少 Desktop 时，插件持续显示“正在连接 / 正在读取桌面”，屏幕没有可见的创建确认 toast。打开 VS Code 右下角通知中心后，才看到“未找到远程主目录下的 Desktop 文件夹，是否现在创建？”。点击创建后流程成功。

`extension.js:254` 使用普通 `showInformationMessage` 并等待用户选择。通知被收起时，插件没有单独显示“等待确认”的状态，因此看起来像连接卡住。本轮未修复。

### 2. 切换 VS Code 标签后虚拟窗口坐标丢失

`extension.js:512` 已启用 `retainContextWhenHidden`，正常切换标签应保留 Webview 状态。但 `media/desktop.js:794` 在每次 `resize` 时调用 `positionWindow`；`media/desktop.js:386` 根据容器当前大小限制坐标，并在 `media/desktop.js:391` 将限制后的值写回 `win.position`。

如果隐藏期间容器变成零尺寸或临时缩小，这段逻辑会覆写用户的位置，恢复显示后不能还原。源码路径与观察相符，但本轮没有采集隐藏时的实际容器尺寸，因此这是原因分析，尚非运行时根因证明。

### 3. 跨窗口拖动出现高亮，但未完成移动

文件行使用原生 HTML drag/drop：`media/desktop.js:177` 设置拖动数据，`media/desktop.js:307` 处理目标区高亮。`drop` 在 `media/desktop.js:315` 进入后首先清除高亮，源节点的 `dragend` 在 `media/desktop.js:185` 也会清除；本次高亮持续残留，说明结束处理没有正常完成。

`focusWindow` 只更新显隐、层级和 dock，不会重建文件行或清空拖动数据。目录和配置响应可能经 `renderWindow` 的 `listing.replaceChildren()` 删除拖动源节点，这是潜在竞态，但不能单独解释目标区未收到 drop。需要进一步区分 VS Code Electron Webview 的原生拖放行为与本轮输入工具的鼠标释放行为。本轮随后用工具栏剪切粘贴成功移动同一测试文件，说明普通移动路径可用，拖放问题仍需单独定位。

历史 `test/ui.test.cjs` 的跨窗口测试使用普通浏览器中的 Playwright `dragTo`，不等同于覆盖了本次 Electron Webview 场景。

## 测试数据与设置恢复

- 测试目录：`/home/yizhao.wang/codex-ui-test-20260916`，暂保留供复查。
- 用户原有桌面内容未用于文件操作测试。
- 测试前工作区没有 `remoteDesktopDemo.remoteHome` 覆盖；结束时已通过工作区设置的“重置此设置”移除本轮覆盖，保留原有用户层空值。重置后只显示“修改于 用户”，工作区修改标记消失。
- 已关闭重开 Demo，确认返回 `/home/yizhao.wang/Desktop`，显示原有 `1234/` 和 `123`，状态为 `Remote-SSH · 已连接`。
- 隔离目录最终保留：source 内三个测试文件，target 内 92 B 文本副本，以及桌面配置和 `UI Test Commands` 命令快捷方式。文件符号链接已在删除测试中移除。
- 本轮截图通过界面工具即时观察，未另存截图文件；历史 `ui-failure` 或自动化截图不作为本轮真实 SSH 实测证据。
