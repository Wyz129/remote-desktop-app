# SSH backend implementation handoff

> 本文件为中间子任务交接。最终代码、配置服务与测试结果以 [1.0.0 交付报告](standalone-100-20260918.md)、项目 HANDOFF.md 和 TESTING.md 为准；下面的 28 项测试数字不代表最终总数。

Implemented `lib/ssh-backend.cjs`; `lib/ssh-backend.js` and the draft `test/ssh-backend.test.cjs` were removed.

## Public API

- constructor `{ clientFactory?, downloadsPath, threshold?, verifyHost?, onDisconnect? }`
- `connect(input)` -> `{ username, host, home, hostFingerprint, verified }`. A pinned `input.hostKeyFingerprint` must match. Unknown hosts require `verifyHost({host,port,username,fingerprint})` to resolve **true**. Fingerprint is OpenSSH-style SHA256 without padding. Private key is an in-memory Buffer supplied by main.
- `discoverDesktop(create=false)` -> `{found,path?,home,entries?,config?,configPath?,configError?}`. `create=true` is the only creation path.
- `loadDesktopConfig()` and `saveDesktopConfig(patch)` -> `{config,configPath,configError?}`. Save preserves unrelated keys, serializes writes, uses an exclusive temp file and OpenSSH posix-rename; unsupported servers get an explicit error without deleting original data.
- `list(path)`, `readImage(path)`, `stat(path, followLinks=true)`.
- `download(path,{id?,onProgress?,destination?})` -> `{id,path,method,total}`. Progress `{id,done,total,method,path,source}`. `path` is null until final destination is committed; `method='preparing'` exposes the cancellable ID before scanning.
- `cancelDownload(id)` -> boolean; immediate AbortController cancellation; `disconnect()` cancels transfers.
- `openShell(id,cwd,onData,onClose)`, `writeShell(id,data)`, `resizeShell(id,cols,rows)`, `closeShell(id)`.

## Transfer details

Default threshold 50 MiB: bytes >= threshold use SFTP; smaller files use SSH `cat -- <POSIX-quoted path>` with backpressure and no whole-file buffer. All directory files use SFTP. SFTP itself is SSH's file transfer subsystem.

Download root must be an absolute system Downloads path from Electron app.getPath('downloads'); backend has no hardcoded home fallback. Transfers stage under an owned mkdtemp directory. Files commit via COPYFILE_EXCL; directories reserve a new mkdir-exclusive target. Existing local objects are never reused, overwritten or deleted. File-name collisions, concurrent downloads, Windows reserved/illegal names, case-only duplicates are handled. On cancellation/error the owned staging content is removed.

Directory total bytes are pre-scanned. Selected symlink directories can be downloaded; nested directory symlinks are explicitly rejected to avoid loops or uncontrolled expansion. File symlinks are dereferenced. Special remote files and unsafe directory entry names are rejected. Only raster image types are shown; SVG is intentionally excluded from the privileged desktop.

## Verification

`node --test test/standalone-backend.test.cjs`: **28/28 passed** (2026-09-18). Includes real SSH and SFTP packet exchange against a local isolated ssh2 fixture: auth, host keys, HOME, desktop discovery, small/large/directory transfer, SHA256 byte parity, threshold boundary, conflicts/concurrency, active cancel, failure cleanup, image bytes, config lookup. Includes explicitly marked injected metadata and pure filename unit tests. This is **not** an external server acceptance test.

A cancelled ssh2 Channel does not obey Node's destroy semantics. SSH downloads therefore bridge the channel through a local PassThrough so AbortSignal closes the local output immediately while the SSH close handshake completes. Regression tests cover this case.
