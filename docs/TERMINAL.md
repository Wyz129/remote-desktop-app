# RTerminal

RTerminal 使用随应用打包的 xterm.js 连接当前 SSH 会话的 PTY。原有 Shell、Vim、htop 和其他命令行程序仍在交互终端中运行。

## 选择、复制与粘贴

- 鼠标左键拖动默认选择本机显示的文字，即使远程程序启用了终端鼠标报告，也不会把这次选择发送到服务器。需要操作远程 TUI 的鼠标功能时，按住 Ctrl 再点击或拖动。
- 有选区时 Ctrl+C 复制选区到本机 Windows 剪贴板，不会中断服务器程序；无选区时 Ctrl+C 保留终端中断行为。Ctrl+Shift+C 可只复制、不发送中断。
- Ctrl+V、Ctrl+Shift+V、Shift+Insert 从本机剪贴板粘贴文本，调用 xterm 的 paste 接口，保留远程程序声明的 bracketed paste 行为；没有声明时，粘贴换行可能立即执行命令，这是普通终端行为。
- 单次复制或粘贴最多 60 KB UTF-8 文本。超过上限显示提示，不发送部分文本；较大内容请分段或用 Transfer Center。
- 剪贴板仅在用户复制/粘贴操作时读取或写入。远程 OSC 52 控制序列不会访问本机剪贴板；浏览器与工作台 iframe 不获得该 IPC。已关闭的终端不会接收尚未完成的粘贴。

## Markdown 与公式阅读

检测到普通终端缓冲区中的 Markdown 标题、粗体、代码围栏或公式时，RTerminal 自动显示 Reading 分栏。左侧继续保留 xterm 原始交互显示，右侧使用现有开源 Marked、DOMPurify、KaTeX 渲染，全部资源在本地打包，不依赖 CDN。

- Reading 开关可随时显示/隐藏分栏；手工隐藏后，本窗口不再自动打开。
- 支持 Markdown 标题、段落、列表、表格、代码块，以及 `$...$`、`$$...$$`、`\(...\)`、`\[...\]` 公式。兼容部分 CLI 输出把显示公式分隔符变成独立 `[` / `]` 行的情况：其中必须含 LaTeX 命令才识别为公式。
- 选中文字后按 Selection，可只渲染选区并保留快照；按 Live 恢复实时读取。
- 阅读内容从 xterm 已解释 ANSI 和光标操作后的可见缓冲区获取，最多最近 1200 行、60000 字符。每次最多排版 100 个公式、每个最多 8192 字符，超限保留原文。不会再次执行终端命令。
- Vim、htop 等使用 alternate screen 的 TUI 不自动切开分栏；仍可手动 Reading，此时明确标为当前 TUI 屏幕。它不是完整 Codex 对话导出器：程序可能清除/重绘历史、折行、隐藏公式分隔符，或根本不输出 Markdown；这些已经丢失的信息无法从终端恢复。可选取稳定文本阅读，或将原文保存在 Markdown/Notebook 文件后用 Monaco Editor 查看。
- 阅读分栏禁用远程图片、活动 HTML 与链接跳转，公式渲染关闭 KaTeX trust；不允许输出内容调用 SSH、文件或剪贴板接口。代码块中的公式保持原样。

## 在本机窗口使用终端

连接服务器后，右键左侧快捷栏图标或空白处 → “打开本机终端”，在 Windows 的独立控制台中使用当前 SSH 会话。也可右键目录空白区域从该目录打开，或手动执行 `rdesktop shell --instance ID --cwd /绝对目录`。具体用法见 [本地命令行](CLI.md#本机交互终端)。

输入和回复由应用转发，Activity Monitor 的第三方访问页与独立 CLI 日志同步记录；不需要另一次 SSH 认证。Ctrl+] 关闭这一条终端，Ctrl+C 仍发送远程中断。关闭桌面或 SSH 断连会结束本机终端会话。Markdown/公式 Reading 分栏只适用于虚拟桌面的 RTerminal，本机窗口保持原生终端显示。

## 实际验证范围

`test/terminal-tools.test.cjs` 使用真实 xterm 与无头 Chrome 检查鼠标报告下的选区、Ctrl+C、Ctrl+V、Shift+Insert、bracketed paste、延迟粘贴关闭、自动/手动阅读、公式、代码块与不可信 HTML。`test/terminal-electron.test.cjs` 使用隔离 Electron 用户数据和回环 SSH 验证真实 preload/主进程 IPC 到 PTY 的通路、回包阅读与 OSC 52 隔离；其中原生剪贴板访问使用进程内替身，因此不会读写用户现有的系统剪贴板。

没有连接用户实际服务器、运行其现有 Codex 会话，或验证所有 Codex/Vim/htop 版本的渲染行为。
