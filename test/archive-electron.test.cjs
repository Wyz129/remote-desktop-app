'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');
const project = path.resolve(__dirname, '..');
// Project's archive tests use the base interpreter and standard libraries only.
const python = process.env.REMOTE_DESKTOP_TEST_PYTHON || (process.platform === 'win32' ? 'C:/ProgramData/anaconda3/python.exe' : 'python3');
const available = spawnSync(python, ['-I', '-c', 'import tarfile,zipfile'], { windowsHide: true }).status === 0;

test('desktop archive menu selects zip and extracts remote bytes with summarized activity', { timeout: 90000, skip: !available && 'Set REMOTE_DESKTOP_TEST_PYTHON to Python 3.8+.' }, async t => {
  const fixture = await createSshFixture({ archivePython: python, desktop: false });
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
  const parent = `${fixture.home}/.rdesktop/desktop`;
  await fixture.put('.rdesktop/desktop/source.txt', 'archive roundtrip 中文\n');
  const userData = path.join(fixture.root, 'archive-app'); await fs.mkdir(userData);
  await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ knownHosts: { [`${fixture.config.host}:${fixture.config.port}`]: fixture.fingerprint } }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.REMOTE_DESKTOP_TEST_EXE;
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [project]), '--smoke-test', `--user-data-dir=${userData}`], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('#connectionDialog[open]').waitFor(); await page.locator('#closeConnection').click();
  await application.evaluate(({ dialog }) => {
    globalThis.archiveDialogLog = [];
    dialog.showMessageBox = async (_window, options) => {
      globalThis.archiveDialogLog.push({ title: options.title, buttons: options.buttons });
      return { response: options.title === '压缩文件' ? 2 : options.cancelId ?? 0 };
    };
  });
  await page.evaluate(config => window.remoteDesktop.connect(config), fixture.config);
  await page.locator(`#icons [data-path="${parent}/source.txt"]`).click({ button: 'right' });
  assert.equal(await page.locator('#context [data-action="extract"]').isDisabled(), true);
  await page.locator('#context [data-action="compress"]').click();
  await page.locator(`#icons [data-path="${parent}/source.txt.zip"]`).waitFor();
  assert.deepEqual((await application.evaluate(() => globalThis.archiveDialogLog)).find(item => item.title === '压缩文件').buttons, ['取消', '.tar.gz', '.zip']);
  await page.locator(`#icons [data-path="${parent}/source.txt.zip"]`).click({ button: 'right' });
  await page.locator('#context [data-action="extract"]').click();
  await page.locator(`#icons [data-path="${parent}/source.txt (2)"]`).waitFor();
  assert.equal(await fs.readFile(fixture.mapPath(`${parent}/source.txt (2)/source.txt`), 'utf8'), 'archive roundtrip 中文\n');
  const records = (await page.evaluate(() => window.remoteDesktop.getActivitySnapshot())).entries;
  const summary = records.filter(item => item.action === 'fileOperation');
  assert.ok(summary.some(item => item.operationName === '压缩文件' && item.type === 'result' && item.status === 'success'));
  assert.ok(summary.some(item => item.operationName === '解压缩文件' && item.type === 'result' && item.status === 'success'));
  assert.ok(!JSON.stringify(records).includes('remote-desktop-archive-v1'), 'internal implementation is absent from system activity');
  assert.equal(await page.locator('#notificationToast').isVisible(), false, 'successful file operations do not create a warning toast');
  assert.deepEqual(errors, []);
});
