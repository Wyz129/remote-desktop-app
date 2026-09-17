const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const reportPath = path.join(projectRoot, 'artifacts', 'vscode-smoke.json');
const testDataRoot = path.join(projectRoot, '.test-data');
// Leave undefined to let @vscode/test-electron obtain its official runtime.
const executablePath = process.env.VSCODE_EXECUTABLE_PATH || undefined;

function writeFailureReport(error) {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (_) {
    // The extension host may have failed before it could create a report.
  }

  const report = {
    timestamp: new Date().toISOString(),
    vscodeVersion: existing.vscodeVersion || null,
    passedAssertions: Array.isArray(existing.passedAssertions)
      ? existing.passedAssertions
      : [],
    success: false,
    error: error && error.stack ? error.stack : String(error),
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function writeInitialReport() {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    vscodeVersion: null,
    passedAssertions: [],
    success: false,
    status: 'running',
  }, null, 2)}\n`, 'utf8');
}

async function main() {
  // Load lazily so requiring this file for inspection does not start VS Code.
  const { runTests } = require('@vscode/test-electron');
  const runDirectory = path.join(
    testDataRoot,
    `run-${Date.now()}-${process.pid}`,
  );
  const userDataDir = path.join(runDirectory, 'user-data');
  const extensionsDir = path.join(runDirectory, 'extensions');
  const workspaceDir = path.join(runDirectory, 'workspace');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'media'), { recursive: true });
  fs.copyFileSync(path.join(projectRoot, 'README.md'), path.join(workspaceDir, 'README.md'));
  writeInitialReport();

  // Codex/Node hosts may export this flag; Code.exe must run as Electron.
  const electronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.ELECTRON_RUN_AS_NODE;
  try {
    await runTests({
      vscodeExecutablePath: executablePath,
      extensionDevelopmentPath: projectRoot,
      extensionTestsPath: path.join(projectRoot, 'test', 'vscode'),
      launchArgs: [
        workspaceDir,
        '--disable-extensions',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
      ],
    });
  } finally {
    if (electronRunAsNode === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE;
    } else {
      process.env.ELECTRON_RUN_AS_NODE = electronRunAsNode;
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    writeFailureReport(error);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = { main };
