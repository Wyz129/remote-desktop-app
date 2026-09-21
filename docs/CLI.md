# 本地命令行

命令行通过当前用户的本地命名管道复用桌面实例，SSH 凭据与连接由实例管理。Windows 打包目录中的 `resources\cli\scripts\rdesktop.cmd` 使用随应用提供的运行时，无需另外安装 Node.js；保留整个 `win-unpacked` 目录。源码开发时也可使用 `node scripts/cli.cjs`，此时需要 Node.js。

以下 PowerShell 示例先为启动器路径设置变量：

```powershell
$rdesktop = 'C:\0_myfiles\new_projects\remote-desktop-app\artifacts\electron-1.1.13\win-unpacked\resources\cli\scripts\rdesktop.cmd'
& $rdesktop launch
& $rdesktop list
& $rdesktop status
& $rdesktop focus
```

`launch` 在没有实例时启动应用，有实例时唤起窗口。`focus` 和 `connect` 也会在没有实例时尝试启动应用。若启动器已移出打包目录，应通过 `--exe '完整应用路径'` 指定 `Remote Desktop.exe`。启动 GUI 子进程时移除进程局部的 `ELECTRON_RUN_AS_NODE`，不会修改系统环境。

默认使用应用的数据目录（Windows 为 `%APPDATA%\remote-desktop-app`）。全局选项 `--user-data-dir '目录'` 可选择隔离的数据目录。存在多个实例时先 `list`，然后添加 `--instance '返回的实例 ID'`；命令行不会猜测目标实例。`list` 输出 ID、进程 ID、启动时间和连接状态，不输出本地接口认证令牌。

## 连接与认证

```powershell
& $rdesktop connect --host server.example --username alice --port 22
& $rdesktop connect --host server.example --username alice --key 'C:\Users\alice\.ssh\id_ed25519'
& $rdesktop connect --ask-passphrase
```

未绑定私钥时在当前交互终端输入密码，输入不回显。省略主机、端口、用户名时采用该实例已保存的设置。只有主机、端口、用户名均与保存值一致时，才自动复用已绑定的私钥路径；不同账户需明确指定 `--key` 或输入密码。私钥有口令时增加 `--ask-passphrase` 并隐藏输入口令。实例只保存选定私钥的路径，不保存密码、私钥内容或口令。

首次连接仍在桌面原生窗口核验主机 SHA-256 指纹；也可通过 `--fingerprint 'SHA256:...'` 提交已通过可信渠道核对的指纹。已保存指纹不一致时拒绝连接。切换连接保留 Monaco 未保存文档确认；终端直接关闭，不弹保存提示。

`connect` 期间按 Ctrl+C 会停止命令行等待，但桌面中已发起的连接与确认流程会继续；需要取消连接时，应在桌面确认窗口选择取消。传输与 `exec` 的 Ctrl+C 会同时请求取消对应任务。

自动化调用可明确使用 `--password-stdin` 从标准输入读取第一行密码。此选项强制使用密码，即使该账户已绑定私钥；不能与 `--key` 同时使用。密码来源应通过父进程标准输入提供，避免在命令文本、脚本参数或 shell 历史中写明文。`--password`、`--passphrase` 参数一律拒绝。

## 本机交互终端

连接服务器后，在左侧快捷栏的图标、运行窗口标签或空白处右键，选择“打开本机终端”。应用打开独立 Windows PowerShell 窗口，自动运行 `rdesktop shell`，复用所选实例已经认证的 SSH 连接；不另建 SSH 连接，也不要求再次输入密码。工作目录使用关联窗口所在目录，否则使用服务器 Home。资源管理器目录空白右键也提供此入口，可在 Settings → 右键菜单中隐藏。

也可在已有本机终端直接调用：

```powershell
& $rdesktop list
& $rdesktop shell --instance 'list 返回的实例 ID' --cwd '/home/alice/project'
```

这是持续的 SSH PTY：`cd`、环境变量与交互程序保留会话状态，键盘输入、ANSI 回复和窗口尺寸经本地命名管道转发。Ctrl+C 传给远程程序；Ctrl+] 仅关闭当前转发终端，也可正常输入 `exit` 退出。关闭本机窗口会释放对应远程 PTY，桌面连接保持；桌面断连、切换账号或退出后终端会话结束，不自动重新绑定其他实例。Windows 窗口保留会话结束信息，可手动关闭。多个本机与虚拟终端合计最多 8 个。

`shell` 需要真正的交互终端，不支持管道输入或 `--json`；自动化命令使用 `exec`。Windows 控制台按原生终端方式显示文本和 ANSI，Markdown/公式阅读分栏仅存在于虚拟桌面的 RTerminal。启动器参数不含 SSH 密码、私钥内容或本地认证令牌。

监听归入 Activity Monitor 的第三方访问，原始 PTY 输入（包括控制字符）、启动命令、服务器回复及时间写入独立 CLI 日志；系统日志只保存连接信息及对应日志文件。不会把按键猜测重建为 shell 命令。日志遵循现有大小上限与轮换规则。

## 单次执行服务器命令

```powershell
& $rdesktop exec -- 'uname -a'
& $rdesktop exec --cwd /srv/project --timeout 60 -- 'git status --short'
& $rdesktop exec --json -- 'printf "hello\n"'
```

`exec` 使用已连接实例的非交互 SSH 命令通道，远程 shell 解释 `--` 之后的命令。普通模式分别向本地 stdout、stderr 输出远程结果，本地退出码反映远程退出码（限制在 0–255；缺失退出码为 1）。`--json` 输出包含 `stdout`、`stderr`、`code`、`signal` 的 JSON，仍保留退出码。`--cwd` 必须是远程绝对路径。

默认 30 秒超时，`--timeout` 单位为秒，允许 0.1–300 秒；stdout 与 stderr 合计上限为 4 MiB。超时、超量或 Ctrl+C 会请求终止并关闭该命令通道，不能保证停止已经脱离会话的后台进程。不提供交互 stdin 或 PTY；Vim、密码提示等交互程序应在桌面终端中运行。

此接口允许当前本地用户以已认证的服务器账号执行任意 shell 命令，是明确提供的本地功能。不要向不受信任的脚本转交实例注册目录或其认证令牌。网页浏览器不拥有该接口。

本机 Codex 的调用规范已安装在 `C:\Users\KunYu\.codex\远程桌面命令行操作规范.md`，由同目录的 `AGENTS.md` 按需索引；这两个文件是本机指引，不随 Git 仓库发布。规范包含核对实例身份、显式 `--instance`、读取 JSON 和退出码、断线与超时处理。Codex 执行复杂远程命令时优先使用 `node scripts/cli.cjs`，避免 `.cmd` 包装器增加 cmd.exe 转义层；PowerShell 7 下用单引号或单引号 here-string 保留远程 shell 文本。

## 上传、下载与取消

```powershell
& $rdesktop upload 'D:\project' /srv/uploads
& $rdesktop upload 'D:\data\input.csv' /srv/uploads
& $rdesktop download /srv/results 'D:\Downloads'
& $rdesktop cancel '任务 ID'
```

上传参数为本机文件或目录以及服务器目标目录；下载参数为服务器绝对路径和可选本机目标目录。目标目录应已存在并有写权限。省略下载目录时使用系统 Downloads/下载文件夹。服务器路径始终是服务器自身路径，本地路径按本机当前工作目录解析。

单个小文件通过 SSH 命令通道流传输；达到阈值的单文件、目录使用 SFTP，均复用已认证 SSH 连接。默认阈值 50 MiB，可在应用设置中修改，后续上传与下载均使用该阈值。传输保留文件内容和空目录，不保留源的所有者、权限、时间戳；上传文件默认权限为 `0600`、目录为 `0700`，仍受服务器实际实现约束。本地链接/Windows 目录联接及特殊文件拒绝上传，需直接选择真实目标。

任务 ID 先输出到 stderr，随后显示字节进度；任务也显示在桌面的传输中心。`--json` 将进度作为逐行 JSON 输出到 stderr，最终结果 JSON 输出到 stdout。可以 Ctrl+C，或在另一个终端使用同一实例的 `cancel` 取消任务。

已存在的同名目标自动编号，不覆盖或合并。数据先进入独占临时目录，完整传输后才提交最终目标。正常取消、退出和切换连接会尝试清理临时内容；意外断网可能无法清理服务器暂存目录，错误会注明其路径。目录计划最多 128 层、100000 项；扫描及传输阶段均可取消。源文件在传输时发生变化会报错并要求重试。

## 已验证范围

模块测试使用 Windows 命名管道、当前用户目录 ACL 和本机回环 SSH/SFTP 服务，验证实例认证、选择实例、上传协议选择、目录、同名冲突、取消、变化检测、命令 stdout/stderr/退出码及超时。启动路径与环境清理另有独立测试。真实用户服务器的网络、SSH 配置和文件权限取决于部署环境；完整应用与最终打包验证结果见项目 `TESTING.md`。

## 桌面中的监听与日志

1.1.3 起，认证后的实际 CLI 操作会自动触发右下角连接提示，并写入服务器桌面 `.log`。点击“实时监听”查看指令与回复；`list/status/focus` 不产生通知。Windows 命名管道无 TCP 来源 IP，界面明确标注取得的 SSH 本机出口地址。详细行为与记录范围见 [监听与日志说明](ACTIVITY_LOG.md)。
