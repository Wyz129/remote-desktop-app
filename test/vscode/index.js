const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const EXTENSION_ID = 'local-demo.remote-desktop-demo';
const COMMAND_ID = 'remoteDesktop.openDemo';
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const REPORT_PATH = path.join(PROJECT_ROOT, 'artifacts', 'vscode-smoke.json');
const READY_TIMEOUT_MS = 30_000;

const passedAssertions = [];

function check(condition, label, message) {
  assert.ok(condition, message || label);
  if (!passedAssertions.includes(label)) {
    passedAssertions.push(label);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function diagnostics(api) {
  check(api && typeof api.getDiagnostics === 'function', 'API exposes getDiagnostics()');
  const value = api.getDiagnostics();
  check(value && typeof value === 'object', 'getDiagnostics() returns an object');
  check(Number.isInteger(value.openPanels), 'diagnostics.openPanels is an integer');
  check(typeof value.ready === 'boolean', 'diagnostics.ready is boolean');
  check(Number.isInteger(value.readyCount), 'diagnostics.readyCount is an integer');
  return value;
}

async function waitForReady(api, timeout = READY_TIMEOUT_MS) {
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeout) {
    latest = diagnostics(api);
    if (latest.openPanels === 1 && latest.ready === true) {
      return latest;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for webview handshake (last diagnostics: ${JSON.stringify(latest)})`);
}

async function waitForClosed(api, timeout = 5_000) {
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeout) {
    latest = diagnostics(api);
    if (latest.openPanels === 0) {
      return latest;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for demo panel to close (last diagnostics: ${JSON.stringify(latest)})`);
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function run() {
  let api;
  let failure;
  try {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    check(Boolean(extension), 'extension is discovered', `Extension ${EXTENSION_ID} was not discovered`);

    api = await extension.activate();
    check(extension.isActive, 'extension is activated');
    check(api && typeof api.getDiagnostics === 'function', 'activation returns diagnostics API');
    check(api && typeof api.closeDemo === 'function', 'activation returns closeDemo()');

    const commands = await vscode.commands.getCommands(true);
    check(commands.includes(COMMAND_ID), 'demo command is registered', `Command ${COMMAND_ID} is not registered`);

    // The test launcher opens PROJECT_ROOT as the workspace, allowing the
    // simulated /home/demo root to map to real VS Code URIs.
    check(Boolean(vscode.workspace.workspaceFolders?.length), 'test workspace folder is available');
    await vscode.commands.executeCommand(COMMAND_ID);
    let state = await waitForReady(api);
    check(state.openPanels === 1, 'first command opens one panel');
    check(state.ready === true, 'first webview reports ready');
    const firstReadyCount = state.readyCount;
    check(firstReadyCount >= 1, 'first webview handshake increments readyCount');

    await vscode.commands.executeCommand(COMMAND_ID);
    state = diagnostics(api);
    check(state.openPanels === 1, 'reopening keeps one panel');
    check(state.ready === true, 'reopening preserves ready state');

    await api.openResource({ type: 'openResource', path: '/home/demo/README.md', kind: 'file' });
    let delegated = diagnostics(api).openRequests.at(-1);
    check(delegated && delegated.delegated === true, 'file openResource maps to workspace URI');
    check(delegated.command === 'vscode.open', 'file openResource delegates to vscode.open');
    await api.openResource({ type: 'openResource', path: '/home/demo/projects', kind: 'folder' });
    delegated = diagnostics(api).openRequests.at(-1);
    check(delegated && delegated.delegated === true, 'folder openResource maps to workspace URI');
    check(delegated.command === 'revealInExplorer', 'folder openResource delegates to revealInExplorer');

    api.closeDemo();
    state = await waitForClosed(api);
    check(state.openPanels === 0, 'closeDemo() closes the test panel');

    await vscode.commands.executeCommand(COMMAND_ID);
    state = await waitForReady(api);
    check(state.openPanels === 1, 'opening after close creates one panel');
    check(state.ready === true, 'opening after close waits for a real handshake');
    check(state.readyCount > firstReadyCount, 'opening after close increments readyCount');

    check(commands.includes('workbench.action.toggleZenMode'), 'VS Code exposes the fullscreen view command');
    const fullscreenMessages = [];
    const fullscreenPanel = { webview: { postMessage: async message => { fullscreenMessages.push(message); return true; } } };
    await api.handleMessage({ type: 'toggleFullscreen' }, fullscreenPanel);
    try {
      check(fullscreenMessages.some(message => message.type === 'fullscreenResult' && message.ok), 'fullscreen request completes through VS Code');
    } finally {
      await api.handleMessage({ type: 'toggleFullscreen' }, fullscreenPanel);
    }
    check(fullscreenMessages.filter(message => message.type === 'fullscreenResult' && message.ok).length === 2, 'fullscreen view can be toggled back');

    // Exercise the bundled runtime PTY through the same messages as the webview.
    const terminalMessages = [];
    const terminalPanel = { webview: { postMessage: async message => { terminalMessages.push(message); return true; } } };
    const terminalId = 'extension-host-smoke';
    try {
      await api.handleMessage({ type: 'getServerInfo' }, terminalPanel);
      const identity = terminalMessages.find(message => message.type === 'serverInfo');
      check(identity?.username && Number.isFinite(identity.epochMs) && identity.remote === false, 'local serverInfo reports actual host identity and time');
      await api.handleMessage({ type: 'openTerminal', id: terminalId, path: '/home/demo', program: 'shell', cols: 80, rows: 24 }, terminalPanel);
      const error = terminalMessages.find(message => message.type === 'terminalError');
      check(terminalMessages.some(message => message.type === 'terminalOpened'), 'actual VS Code runtime PTY opens', error?.error);
      await api.handleMessage({ type: 'terminalInput', id: terminalId, data: 'echo CODEX_PTY_SMOKE_004\r' }, terminalPanel);
      const started = Date.now();
      while (Date.now() - started < 5000 && !terminalMessages.some(message => message.type === 'terminalData' && message.data.includes('CODEX_PTY_SMOKE_004'))) await delay(100);
      check(terminalMessages.some(message => message.type === 'terminalData' && message.data.includes('CODEX_PTY_SMOKE_004')), 'actual PTY receives input and emits output');
      await api.handleMessage({ type: 'terminalResize', id: terminalId, cols: 100, rows: 30 }, terminalPanel);
      check(!terminalMessages.some(message => message.type === 'terminalError'), 'actual PTY resize succeeds');
    } finally {
      await api.handleMessage({ type: 'terminalClose', id: terminalId }, terminalPanel);
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (api && typeof api.closeDemo === 'function') {
        api.closeDemo();
        await waitForClosed(api, 5_000);
      }
    } catch (closeError) {
      if (!failure) {
        failure = closeError;
      }
    }

    const report = {
      timestamp: new Date().toISOString(),
      vscodeVersion: vscode.version,
      passedAssertions: [...passedAssertions],
      success: !failure,
    };
    if (failure) {
      report.error = failure && failure.stack ? failure.stack : String(failure);
      writeReport(report);
    } else {
      writeReport(report);
    }
  }
  if (failure) {
    throw failure;
  }
}

module.exports = { run };
