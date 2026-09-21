# Lifecycle 1.1.13 handoff

Agent terminal_1113 followup complete, frozen.

- `main.cjs`: global web-contents-created/before-input-event reserves unmodified F11 for host fullscreen and suppresses repeat/double renderer toggles. Applies to desktop and subsequently created browser/workbench contents. No Escape or Ctrl+Alt+F binding.
- `quitSafely` now returns a shared Promise for concurrent requests; app:quit awaits it instead of unconditional success. Cancel returns false. During a session transition it displays pending feedback and waits (maximum12seconds); pending authentication transport is destroyed to cancel its120second timeout. New connect requests are blocked while closing.
- Unsaved Monaco confirmation remains first, then input is frozen via workbench disconnect before potentially slow shutdown. Terminal closure preserved. Local CLI interface, server resources, SSH, history, document resources all have bounded cleanup deadlines. A real cleanup timeout/failure yields native warning with details and explicit Exit/return choice, after save/discard confirmation. Returning leaves SSH disconnected and tries to restore local CLI registration. Normal successful exit needs no extra prompt.
- IPC resolves before scheduled app.quit. Native window close/before-quit use same path. Shell Exit title/aria English; click is disabled until actual result.

`node --test test/lifecycle-electron.test.cjs`:3/3 passed on source. Covers F11 desktop+independent sandboxed app WebContents, Escape propagation, removed Ctrl+Alt+F shortcut, unsaved cancellation+top Exit, active hanging handshake cancellation, and deliberately stalled cleanup timeout with explicit exit. Uses isolated app/loopback fixture; no user server.

Parent needs add this file to Electron and package verification. No package.json edit or commit by this agent.
