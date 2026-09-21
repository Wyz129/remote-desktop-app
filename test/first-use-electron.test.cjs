'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');
const { desktopIdentity } = require('../lib/desktop-preferences.cjs');
const { listInstances, requestInstance } = require('../lib/instance-bridge.cjs');
const project = path.resolve(__dirname, '..');

test('first connection creates private storage, resets old desktop preference, saves secret-free profiles and separates summarized system activity from raw terminal and CLI commands', { timeout: 120000 }, async t => {
  const fixture = await createSshFixture({ desktop: false });
  let application;
  t.after(async () => {
    if (application && application.process().exitCode === null) {
      const timer = setTimeout(() => {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(application.process().pid), '/T', '/F'], { windowsHide: true });
        else application.process().kill('SIGKILL');
      }, 5000);
      try { await application.close(); } finally { clearTimeout(timer); }
    }
    await fixture.close();
  });
  const oldDesktop = `${fixture.home}/legacy desktop`;
  await fixture.put('legacy desktop/keep.txt', 'old user content');
  const storageRoot = `${fixture.home}/.rdesktop`;
  assert.equal(await fs.stat(fixture.mapPath(storageRoot)).catch(() => null), null);
  const userData = path.join(fixture.root, 'first-use-app'); await fs.mkdir(userData);
  const identity = desktopIdentity({ ...fixture.config, username: fixture.username, hostFingerprint: fixture.fingerprint });
  await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({
    host: fixture.config.host, port: fixture.config.port, username: fixture.username,
    desktopLocations: { [identity]: oldDesktop },
    knownHosts: { [`${fixture.config.host}:${fixture.config.port}`]: fixture.fingerprint }
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.REMOTE_DESKTOP_TEST_EXE;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [project]), '--smoke-test', `--user-data-dir=${userData}`], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('#connectionDialog[open]').waitFor();
  assert.equal(await page.locator('#connectionDialog').getAttribute('data-mode'), 'login');
  for (const selector of ['#sshUsername', '#sshPassword', '#switchAccountButton', '#connectSubmit']) assert.equal(await page.locator(selector).isVisible(), true, selector);
  for (const selector of ['#connectionAdvanced', '#serverSwitcher', '#advancedConnectSubmit']) assert.equal(await page.locator(selector).isVisible(), false, selector);
  await page.locator('#switchAccountButton').click();
  assert.equal(await page.locator('#connectionDialog').getAttribute('data-mode'), 'advanced');
  assert.equal(await page.locator('#connectionAdvanced').isVisible(), true);
  await page.locator('#sshAlias').fill('计算服务器 A');
  await page.locator('#sshPassword').fill(fixture.password);
  await page.locator('#sshPassphrase').fill('fixture-private-key-passphrase');
  await page.locator('#saveServer').click();
  await page.waitForFunction(() => document.getElementById('connectionDialog').dataset.mode === 'login' && document.getElementById('connectionHint').textContent.includes('已保存'));
  const firstId = await page.locator('#serverProfile').inputValue(); assert.ok(firstId);
  const savedFirst = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'));
  assert.equal(savedFirst.storageVersion, 2);
  assert.deepEqual(savedFirst.desktopLocations, {});
  assert.equal(savedFirst.serverProfiles.find(profile => profile.id === firstId).alias, '计算服务器 A');
  assert.ok(!JSON.stringify(savedFirst).includes(fixture.password));
  assert.ok(!JSON.stringify(savedFirst).includes('fixture-private-key-passphrase'));
  assert.ok(!/"(?:password|passphrase|privateKey)"\s*:/.test(JSON.stringify(savedFirst)));

  await page.locator('#switchAccountButton').click();
  await page.locator('#newServer').click();
  assert.equal(await page.locator('#sshPassword').inputValue(), '');
  assert.equal(await page.locator('#sshPassphrase').inputValue(), '');
  await page.locator('#sshHost').fill(fixture.config.host);
  await page.locator('#sshPort').fill(String(fixture.config.port === 65535 ? 65534 : fixture.config.port + 1));
  await page.locator('#sshUsername').fill(fixture.username);
  await page.locator('#sshAlias').fill('备用服务器 B');
  await page.locator('#saveServer').click();
  await page.waitForFunction(() => document.getElementById('serverProfile').options.length === 3);
  await page.waitForFunction(() => document.getElementById('connectionDialog').dataset.mode === 'login');
  await page.locator('#switchAccountButton').click();
  await page.locator('#sshPassword').fill('must-clear-on-switch');
  await page.locator('#serverProfile').selectOption(firstId);
  assert.equal(await page.locator('#sshPassword').inputValue(), '');
  assert.equal(await page.locator('#sshPassphrase').inputValue(), '');
  assert.equal(await page.locator('#serverDisplayName').textContent(), '计算服务器 A');
  assert.equal(await page.locator('#sshPort').inputValue(), String(fixture.config.port));
  await fs.mkdir(path.join(project, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(project, 'artifacts', executablePath ? 'packaged-login-advanced.png' : 'electron-login-advanced.png') });
  await page.locator('#backToLogin').click();
  assert.equal(await page.locator('#connectionAdvanced').isVisible(), false);
  await page.screenshot({ path: path.join(project, 'artifacts', executablePath ? 'packaged-login.png' : 'electron-login.png') });
  await page.locator('#sshPassword').fill(fixture.password);
  await page.locator('#connectSubmit').click();
  await page.locator('#connectionDialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(expected => document.getElementById('desktopPath').textContent === expected, `${storageRoot}/desktop`);
  for (const directory of [storageRoot, ...['desktop', 'log', 'download', 'trash', 'config'].map(name => `${storageRoot}/${name}`)]) {
    assert.equal((await fs.stat(fixture.mapPath(directory))).isDirectory(), true, directory);
    assert.ok(fixture.calls.sftp.some(call => call[0] === 'MKDIR' && call[1] === directory), `server created ${directory}`);
  }
  assert.equal(await fs.readFile(fixture.mapPath(`${oldDesktop}/keep.txt`), 'utf8'), 'old user content');
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), `Remote Desktop - ssh ${fixture.username}@127.0.0.1:${fixture.config.port} 计算服务器 A`);
  assert.equal(await page.locator('#sshPassword').inputValue(), '');

  assert.equal(await page.locator('#accountName').count(), 0);
  assert.equal(await page.locator('#connection').textContent(), fixture.username);
  assert.equal(await page.locator('#connectionIndicator').evaluate(element => element.classList.contains('connected')), true);
  await page.locator('#connectButton').click();
  assert.equal(await page.locator('#connectedAddress').textContent(), `${fixture.username}@127.0.0.1:${fixture.config.port}`);
  for (const selector of ['#sshUsername', '#sshPassword', '#connectionAdvanced', '#serverSwitcher', '#connectSubmit']) assert.equal(await page.locator(selector).isVisible(), false, selector);
  assert.equal(await page.locator('#disconnectButton, #connectedUsername').count(), 0);
  for (const selector of ['#connectionExitButton', '#reconnectButton', '#switchAccountButton']) assert.equal(await page.locator(selector).isVisible(), true, selector);
  await page.screenshot({ path: path.join(project, 'artifacts', executablePath ? 'packaged-account.png' : 'electron-account.png') });
  await page.locator('#switchAccountButton').click();
  assert.equal(await page.locator('#connectionDialog').getAttribute('data-mode'), 'advanced');
  assert.equal(await page.locator('#sshUsername').isEditable(), true);
  assert.equal(await page.locator('#sshPassword').inputValue(), '');
  assert.equal(await page.locator('#serverSwitcher').isVisible(), true);
  await page.locator('#serverProfile').selectOption({ label: (await page.locator('#serverProfile option').allTextContents()).find(label => label.includes('备用服务器 B')) });
  await page.locator('#closeConnection').click();
  await page.locator('#connectButton').click();
  assert.equal(await page.locator('#serverDisplayName').textContent(), '计算服务器 A', 'active account never follows an unsubmitted server selection');
  await page.locator('#reconnectButton').click();
  assert.equal(await page.locator('#sshUsername').isEditable(), false);
  assert.equal(await page.locator('#sshPassword').inputValue(), '');
  await page.locator('#sshPassword').fill(fixture.password);
  await page.locator('#connectSubmit').click();
  await page.locator('#connectionDialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#connection').textContent(), fixture.username);
  const afterReconnect = await fs.readFile(path.join(userData, 'settings.json'), 'utf8');
  assert.ok(!afterReconnect.includes(fixture.password));

  await page.locator('#applicationsButton').click();
  assert.equal(await page.locator('#applicationsPanel').getByRole('heading', { name: '程序' }).count(), 1);
  assert.equal(await page.locator('#applicationsGrid [data-application]').count(), 10);
  await page.screenshot({ path: path.join(project, 'artifacts', executablePath ? 'packaged-toolbox.png' : 'electron-toolbox.png') });
  await page.locator('[data-application=video]').click();
  await page.locator('.video-window').waitFor();
  assert.equal(await page.locator('.video-window .window-title').textContent(), '视频播放器');
  await page.locator('.video-window [data-window-action=close]').click();
  await page.locator('.video-window').waitFor({ state: 'detached' });

  await page.locator('#applicationsButton').click(); await page.locator('[data-application=browser]').click();
  await page.locator('.browser-window').waitFor();
  let browserDownloadDirectory;
  for (let attempt = 0; attempt < 100; attempt++) {
    browserDownloadDirectory = await application.evaluate(async ({ webContents }) => {
      const toolbar = webContents.getAllWebContents().find(contents => contents.getURL().endsWith('/app/browser.html'));
      return toolbar && !toolbar.isLoading() ? toolbar.executeJavaScript('document.getElementById("serverDirectory").value') : null;
    });
    if (browserDownloadDirectory === `${storageRoot}/download`) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(browserDownloadDirectory, `${storageRoot}/download`);
  await page.locator('.browser-window [data-window-action=close]').click();

  await page.locator('#activityButton').click();
  await page.locator('[data-activity-category=system]').click();
  await page.evaluate(() => window.remoteDesktop.getSystemInfo());
  const systemCommand = fixture.calls.exec.findLast(command => command.startsWith('# remote-desktop-system-info-v1\n'));
  assert.ok(systemCommand);
  await page.waitForFunction(() => document.querySelector('.activity-events')?.textContent.includes('#读取系统信息') && document.querySelector('.activity-events')?.textContent.includes('Ubuntu 24.04'));
  assert.equal(await page.locator('.activity-events').textContent().then(text => text.includes(systemCommand)), false, 'predefined GUI commands show operation names instead of implementation scripts');
  await page.locator('[data-activity-category=terminal]').click();
  await page.evaluate(() => { window.fixtureTerminalEvents = []; window.remoteDesktop.onMessage(message => window.fixtureTerminalEvents.push(message)); });
  await page.keyboard.press('Control+Alt+t');
  await page.waitForFunction(() => window.fixtureTerminalEvents.some(message => message.type === 'terminalOpened'));
  const terminalId = await page.evaluate(() => window.fixtureTerminalEvents.find(message => message.type === 'terminalOpened').id);
  const terminalInput = 'printf raw-input-check\r';
  await page.evaluate(({ id, data }) => window.remoteDesktop.send({ type: 'terminalInput', id, data }), { id: terminalId, data: terminalInput });
  await page.waitForFunction(() => document.querySelector('.activity-events')?.textContent.includes('fixture-echo:printf raw-input-check'));
  const snapshot = await page.evaluate(() => window.remoteDesktop.getActivitySnapshot());
  assert.ok(snapshot.entries.some(entry => entry.scope === 'system' && entry.type === 'terminal-input' && entry.data === terminalInput));
  assert.ok(snapshot.entries.some(entry => entry.scope === 'system' && entry.type === 'terminal-command' && entry.command.includes('exec')));
  const systemOperation = snapshot.entries.findLast(entry => entry.scope === 'system' && entry.type === 'operation' && entry.action === 'ssh:system-info');
  assert.ok(systemOperation);
  assert.ok(snapshot.entries.some(entry => entry.operationId === systemOperation.operationId && entry.type === 'result' && entry.status === 'success' && entry.result.os.includes('Ubuntu 24.04')));
  assert.ok(!snapshot.entries.some(entry => entry.command === systemCommand));
  assert.ok(snapshot.entries.filter(entry => ['terminal-input', 'terminal-output', 'command'].includes(entry.type)).every(entry => !Number.isNaN(Date.parse(entry.time))));
  assert.ok(snapshot.systemLogPath.startsWith(`${storageRoot}/log/`));
  const [instance] = await listInstances(userData); assert.ok(instance);
  const command = 'fixture-command';
  const result = await requestInstance(instance, 'exec', { command });
  assert.deepEqual({ stdout: result.stdout, stderr: result.stderr, code: result.code }, { stdout: 'remote command reply\n', stderr: 'fixture diagnostic\n', code: 7 });
  await page.locator('#activityButton').click();
  await page.locator('[data-activity-category=cli]').click();
  await page.locator('.activity-session').selectOption('');
  await page.waitForFunction(() => document.querySelector('.activity-events')?.textContent.includes('remote command reply'));
  const activity = await page.evaluate(() => window.remoteDesktop.getActivitySnapshot());
  const cliSession = activity.sessions.find(session => session.action === 'exec'); assert.ok(cliSession);
  const cliRecords = activity.entries.filter(entry => entry.sessionId === cliSession.id);
  assert.ok(cliRecords.some(entry => entry.command === command || entry.args?.command === command));
  assert.ok(cliRecords.some(entry => entry.type === 'stderr' && entry.data.includes('fixture diagnostic')));
  await page.screenshot({ path: path.join(project, 'artifacts', executablePath ? 'packaged-command-activity.png' : 'electron-command-activity.png') });
  await page.evaluate(() => window.remoteDesktop.disconnect());
  const systemLog = await fs.readFile(fixture.mapPath(snapshot.systemLogPath), 'utf8');
  const savedRecords = systemLog.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(savedRecords.some(record => record.type === 'operation' && record.operationId === systemOperation.operationId && record.input === '#读取系统信息'));
  assert.ok(savedRecords.some(record => record.operationId === systemOperation.operationId && record.type === 'result' && record.output === '#成功' && record.result.os.includes('Ubuntu 24.04')));
  assert.ok(!systemLog.includes(systemCommand), 'predefined commands are omitted from system logs too');
  assert.ok(savedRecords.some(record => record.type === 'terminal-input' && record.data === terminalInput));
  assert.ok(savedRecords.some(record => record.type === 'terminal-output' && record.data.includes('fixture-echo:printf raw-input-check')));
  assert.ok(!systemLog.includes(command), 'CLI command body belongs only to its dedicated log');
  const cliLog = await fs.readFile(fixture.mapPath(cliSession.logPath), 'utf8');
  assert.ok(cliLog.includes(command) && cliLog.includes('remote command reply') && cliLog.includes('fixture diagnostic'));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), 'Remote Desktop');
  assert.deepEqual(errors, []);
});
