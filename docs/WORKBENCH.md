# Monaco Editor

文本与脚本编辑使用微软开源的 [Monaco Editor](https://github.com/microsoft/monaco-editor)，即 VS Code 使用的编辑器组件，当前随包版本为 **0.53.0，MIT 许可**。应用已直接集成真实 Monaco，并非自行仿制编辑器。行号、搜索替换、撤销重做、选择、折叠及常见语言的高亮交给 Monaco；无需另行安装完整 VS Code。依赖从 npm 获取，资源与许可证由 `scripts/vendor-workbench.cjs` 复制并随应用本地打包，运行不依赖 CDN。

1.1.8 起，Monaco Editor 位于虚拟桌面内部，可拖动、缩放、最大化、最小化及从侧栏恢复。编辑器使用不具同源权限的 iframe，只有固定动作消息桥；带随机地址的本机静态服务仅提供随包资源，不提供 SSH、凭据或任意文件接口。编辑器表单允许本地交互，但网络表单提交由 CSP 禁止；远程 HTML 仍位于第二层仅允许脚本的隔离预览中。

Monaco Editor 由主进程读取和保存远程文件，渲染器只接收当前文档内容。支持 Python、C/C++、Fortran、HTML、JavaScript、CSS、JSON、Markdown 和 Shell。Fortran 使用 Monaco 的公开语言扩展 API 注册词法与折叠规则；它不属于 Monaco 内置语言。应用自行负责 SSH 读写、权限、未保存提示、远程修改冲突、Notebook 单元格与 Jupyter 接口，基础文本编辑交给成熟组件。

`Ctrl+F` 查找，`Ctrl+H` 替换，`Ctrl+Z` 撤销，`Ctrl+S` 保存。Python、C/C++ 与 Fortran 当前提供语法高亮和基础编辑，不包含完整语言服务器、编译器、调试器或 VS Code 扩展兼容层。保存使用远程文件版本摘要检测冲突；远程文件被其他程序修改时不会覆盖，窗口会保留当前内容，可重新载入或另存为。

`.ipynb` 使用 nbformat 4。Markdown 公式由 KaTeX 渲染，已有输出按文本、HTML 和受限图片显示；脚本、外部图片、SVG、Widget、二进制通道和 stdin 交互输出会被过滤或提示不支持。连接 Jupyter 时填写服务器已启动的 HTTP(S) 根地址和 Token，所有 REST/WebSocket 请求通过当前 SSH 的 `forwardOut` 发出，域名由服务器解析。工作台可以查看 kernelspec、启动/连接内核、执行、中断、重启和关闭；不会自动安装或启动 Jupyter。

HTML 提供源码、预览和分栏模式。预览默认只开放 HTML 所在目录的已保存资源；可在“预览资源目录”中明确指定上层项目目录来支持相对 `../` 引用。预览 iframe 只有 `allow-scripts`，无 preload、Node、应用 IPC 或文件接口；预览服务仅开放当前一次性资源令牌范围，响应 CSP 仅允许该预览源的资源并阻止外部网络。需要访问外部网站时使用隔离浏览器。

打开文件前检查当前 SSH 账号的实际读写权限。只读文件可搜索、复制和另存为；关闭、切换连接或退出时会通过原生对话框选择保存、丢弃或取消。断开连接后窗口保留未保存内容并进入只读状态。文档最大 16 MiB，要求有效 UTF-8；二进制或更大文件请使用 Vim 或传输中心。

侧栏底部“工具箱”中的 Monaco Editor 打开未命名文本；Ctrl+S 会要求输入服务器上的新路径，文件必须尚不存在。工具栏“打开”接受远程绝对路径，切换前检查未保存修改。新文档关闭时可返回另存为、丢弃或取消。终端不再参与普通文本与脚本文件的默认打开流程；需要 Vim 时可在终端自行运行。
