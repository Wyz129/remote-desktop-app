# Terminal handoff 1.1.13

Agent terminal_1113 complete; code frozen for parent integration.

- `app/terminal-tools.js/css`: local left-drag selection while xterm mouse reporting is active; Ctrl+mouse explicitly forwards to remote TUI. Ctrl+C selected copy/no selection SIGINT; Ctrl+Shift+C copies only; Ctrl+V, Ctrl+Shift+V, Shift+Insert call local clipboard IPC then xterm.paste. Late clipboard completion dropped after disposal. Clipboard only on explicit keyboard action; no OSC52 bridge.
- Reading split automatically detects Markdown/math in normal xterm buffer; alternate screen manual only. Marked + DOMPurify + KaTeX from already bundled assets. Reading toggle, Selection snapshot and Live mode. Bounded snapshot (1200 lines / 60000 characters),100 formulas /8192 characters each; fallback original text. No external resource load, HTML active content, navigation or trusted KaTeX commands.
- `lib/terminal-clipboard.cjs` + exact main/preload additions enforce 60000 UTF-8 bytes; main IPC retains requireSender guard. Desktop edits only terminal attach/dispose; index template and static dependencies added.
- `docs/TERMINAL.md` describes controls, bounded reading, TUI/Codex limitations, OS clipboard test substitute and untested real server.

Passed:

- `node --test test/terminal-tools.test.cjs`:6/6
- `node --test test/terminal-electron.test.cjs`:1/1; isolated Electron + loopback SSH, native clipboard methods stubbed in isolated main process; does not read/write user's OS clipboard.
- `node --test --test-name-pattern='terminal_close|terminal_refresh|crud_selection_and_terminal' test/standalone-ui.test.cjs`:2/2
- `node --check app/terminal-tools.js`, desktop.js, main.cjs; git diff --check clean.

Screenshots visually inspected: `artifacts/terminal-reading-1.1.13.png`, `artifacts/terminal-integrated-1.1.13.png`. Integrated screenshot before parent's English label updates.

Parent still needs add test/terminal-tools.test.cjs to npm UI checks and test/terminal-electron.test.cjs to Electron/package checks; no package.json changes made by this agent. Source/package verification must include both terminal-tools assets and lib/terminal-clipboard.cjs. Existing vendor copy already includes Marked/KaTeX/fonts/DOMPurify, no dependency change.

Root-cause evidence: previous terminal did not intercept Ctrl+V/Ctrl+C copy; real xterm received these as control-key input. Mouse-enabled remote applications caused xterm to forward mouse reports rather than select locally. New tests verify a local drag sends neither control bytes nor mouse reports. No trace was available from user's real Codex process, so do not claim a demonstrated server-side origin for its literal ^C display.
