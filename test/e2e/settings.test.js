const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { REPO, until, tempDirs, launch } = require('./helpers');

// Settings drawer E2E. Never touches the clipboard, real dialogs, the browser or Explorer:
// every side-effecting OS call is stubbed inside the main process.

const cleanup = (root) => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } };
const quit = async (app) => { await app.evaluate(({ app: a }) => a.quit()).catch(() => {}); await app.close().catch(() => {}); };
const readSettings = (userData) => { try { return JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')); } catch { return null; } };

// picks: queue of paths dialog.showOpenDialog returns, in order
async function stubOs(app, picks = []) {
  await app.evaluate(({ shell, dialog }, queue) => {
    globalThis.__calls = [];
    const rec = (name, ret) => async (...a) => { globalThis.__calls.push([name, ...a.filter((x) => typeof x === 'string')]); return ret; };
    shell.openPath = rec('openPath', '');
    shell.showItemInFolder = (p) => { globalThis.__calls.push(['showItemInFolder', p]); };
    shell.openExternal = rec('openExternal');
    dialog.showOpenDialog = async () => {
      const p = queue.shift();
      globalThis.__calls.push(['showOpenDialog', p]);
      return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] };
    };
  }, picks);
}
const calls = (app) => app.evaluate(() => globalThis.__calls);

async function start(dirs, picks) {
  const r = await launch(dirs);
  await stubOs(r.app, picks);
  // renderer has state once the version is known to the drawer; wait until getState resolved
  await until(() => r.win.evaluate(() => document.getElementById('statusText').textContent !== '…'));
  return r;
}
const openDrawer = async (win) => {
  await win.locator('#openSettings').click();
  assert.ok(await until(() => win.locator('#drawer').isVisible(), 2000), 'drawer visible');
};
const save = async (win) => {
  await win.locator('#saveBtn').click();
  assert.ok(await until(async () => (await win.locator('#saveResult').textContent()) === 'Сохранено', 3000), 'inline "Сохранено"');
};

test('drawer opens via Настройки and closes via Escape, ✕ and backdrop', async () => {
  const dirs = tempDirs();
  const { app, win } = await start(dirs);
  try {
    assert.ok(await win.locator('#drawer').isHidden(), 'drawer hidden on start');
    await openDrawer(win);
    assert.ok(await win.locator('#backdrop').isVisible(), 'backdrop shown');
    await win.keyboard.press('Escape');
    assert.ok(await until(() => win.locator('#drawer').isHidden(), 2000), 'Escape closes');
    assert.ok(await win.locator('#backdrop').isHidden(), 'backdrop hidden after Escape');

    await openDrawer(win);
    await win.locator('#closeSettings').click();
    assert.ok(await until(() => win.locator('#drawer').isHidden(), 2000), '✕ closes');

    await openDrawer(win);
    await win.locator('#backdrop').click({ position: { x: 20, y: 20 } });
    assert.ok(await until(() => win.locator('#drawer').isHidden(), 2000), 'backdrop click closes');

    // Escape with focus inside a text field also closes
    await openDrawer(win);
    await win.locator('#gEnabled').check();
    await win.locator('#fSheet').focus();
    await win.keyboard.press('Escape');
    assert.ok(await until(() => win.locator('#drawer').isHidden(), 2000), 'Escape from an input closes');
  } finally {
    await quit(app);
    cleanup(dirs.root);
  }
});

test('each toggle persists to settings.json and survives restart', async () => {
  const dirs = tempDirs();
  let { app, win } = await start(dirs);
  try {
    await openDrawer(win);
    // defaults
    assert.strictEqual(await win.locator('input[name=launchAtLogin]').isChecked(), false);
    assert.strictEqual(await win.locator('input[name=minimizeToTray]').isChecked(), true);
    assert.strictEqual(await win.locator('input[name=notifyOnSave]').isChecked(), false);
    assert.strictEqual(await win.locator('#gEnabled').isChecked(), false);

    // toggle by clicking the visible label text, like a user
    for (const t of ['Запускать вместе с Windows', 'При закрытии сворачивать в трей', 'Уведомление при сохранении', 'Синхронизация с Google Sheets']) {
      await win.locator('label.switch', { hasText: t }).click();
    }
    await save(win);
    const s = readSettings(dirs.userData);
    assert.strictEqual(s.launchAtLogin, true, 'launchAtLogin saved');
    assert.strictEqual(s.minimizeToTray, false, 'minimizeToTray saved');
    assert.strictEqual(s.notifyOnSave, true, 'notifyOnSave saved');
    assert.strictEqual(s.google.enabled, true, 'google.enabled saved');
    assert.deepStrictEqual((await calls(app)).filter((c) => c[0] === 'openExternal'), [], 'no browser opened');
  } finally {
    await quit(app);
  }

  ({ app, win } = await start(dirs));
  try {
    await openDrawer(win);
    assert.strictEqual(await win.locator('input[name=launchAtLogin]').isChecked(), true, 'launchAtLogin after restart');
    assert.strictEqual(await win.locator('input[name=minimizeToTray]').isChecked(), false, 'minimizeToTray after restart');
    assert.strictEqual(await win.locator('input[name=notifyOnSave]').isChecked(), true, 'notifyOnSave after restart');
    assert.strictEqual(await win.locator('#gEnabled').isChecked(), true, 'google.enabled after restart');

    // and back off
    for (const t of ['Запускать вместе с Windows', 'При закрытии сворачивать в трей', 'Уведомление при сохранении', 'Синхронизация с Google Sheets']) {
      await win.locator('label.switch', { hasText: t }).click();
    }
    await save(win);
    const s = readSettings(dirs.userData);
    assert.deepStrictEqual([s.launchAtLogin, s.minimizeToTray, s.notifyOnSave, s.google.enabled], [false, true, false, false], 'toggled back');
  } finally {
    await quit(app);
    cleanup(dirs.root);
  }
});

test('Google fields follow the sync toggle; auth switch and file pickers', async () => {
  const dirs = tempDirs();
  const secret = path.join(dirs.root, 'client_secret.json');
  const key = path.join(dirs.root, 'service-key.json');
  const { app, win } = await start(dirs, [secret, key, null]);
  try {
    await openDrawer(win);
    const fields = ['#fSheetId', '#fSheet', '#fTerm', '#fDrive', '#pickFile', 'input[name=authMode][value=service]'];
    for (const f of fields) assert.ok(await win.locator(f).isDisabled(), `${f} disabled while sync off`);
    await win.locator('#gEnabled').check();
    for (const f of fields) assert.ok(await win.locator(f).isEnabled(), `${f} enabled with sync on`);
    await win.locator('#gEnabled').uncheck();
    assert.ok(await win.locator('#fSheetId').isDisabled(), 'disabled again when sync off');
    await win.locator('#gEnabled').check();

    // default auth = oauth -> client_secret.json field
    assert.ok(await win.locator('input[name=authMode][value=oauth]').isChecked(), 'oauth is default');
    assert.strictEqual(await win.locator('#fileLbl').textContent(), 'client_secret.json');
    await win.locator('#pickFile').click();
    assert.ok(await until(async () => (await win.locator('#fileInput').inputValue()) === secret, 2000), 'picker fills client secret');

    // service -> key field, separate value
    await win.locator('.seg label', { hasText: 'Сервисный аккаунт' }).click();
    assert.strictEqual(await win.locator('#fileLbl').textContent(), 'Ключ сервисного аккаунта (JSON)');
    assert.strictEqual(await win.locator('#fileInput').inputValue(), '', 'service key field starts empty');
    await win.locator('#pickFile').click();
    assert.ok(await until(async () => (await win.locator('#fileInput').inputValue()) === key, 2000), 'picker fills service key');

    // cancelled dialog keeps the value
    await win.locator('#pickFile').click();
    await until(async () => (await calls(app)).length === 3, 2000);
    assert.strictEqual(await win.locator('#fileInput').inputValue(), key, 'cancel keeps value');

    await win.locator('.seg label', { hasText: 'Мой аккаунт Google' }).click();
    assert.strictEqual(await win.locator('#fileLbl').textContent(), 'client_secret.json');
    assert.strictEqual(await win.locator('#fileInput').inputValue(), secret, 'oauth field keeps its own file');

    await win.locator('.seg label', { hasText: 'Сервисный аккаунт' }).click();
    await save(win);
    const g = readSettings(dirs.userData).google;
    assert.strictEqual(g.authMode, 'service');
    assert.strictEqual(g.credentialsFile, key);
    assert.strictEqual(g.clientSecretFile, secret);
    assert.ok((await calls(app)).every((c) => c[0] === 'showOpenDialog'), 'only the stubbed dialog was used');
  } finally {
    await quit(app);
    cleanup(dirs.root);
  }
});

test('Таблица accepts a full URL and stores the parsed ID; other fields saved', async () => {
  const dirs = tempDirs();
  const id = '1tJbyC7MlMofKfED5Xb54DOJJbmtGcf9Wmz9SphIAaLA';
  const { app, win } = await start(dirs);
  try {
    await openDrawer(win);
    await win.locator('#gEnabled').check();
    await win.locator('#fSheetId').fill(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`);
    await win.locator('#fSheet').fill('Лист 2');
    await win.locator('#fTerm').fill('вставить');
    await win.locator('#fDrive').fill('driveFolder123');
    await save(win);
    assert.ok(await win.locator('#saveResult').evaluate((n) => n.classList.contains('ok')), 'result styled ok');
    const g = readSettings(dirs.userData).google;
    assert.strictEqual(g.sheetName, 'Лист 2');
    assert.strictEqual(g.searchTerm, 'вставить');
    assert.strictEqual(g.driveFolderId, 'driveFolder123');
    assert.strictEqual(g.spreadsheetId, id, 'stored spreadsheetId is the parsed ID, not the URL');
  } finally {
    await quit(app);
    cleanup(dirs.root);
  }
});

for (const mode of ['oauth', 'service']) {
  test(`${mode}: enabling Google with a missing secret file shows the Google pill error with a message`, async () => {
    const dirs = tempDirs();
    const missing = path.join(dirs.root, 'nope', `${mode}.json`);
    const { app, win } = await start(dirs, [missing]);
    try {
      assert.strictEqual(await win.locator('#googlePill').textContent(), 'Google Sheets · выключено');
      await openDrawer(win);
      await win.locator('#gEnabled').check();
      if (mode === 'service') await win.locator('.seg label', { hasText: 'Сервисный аккаунт' }).click();
      await win.locator('#pickFile').click();
      await until(async () => (await win.locator('#fileInput').inputValue()) === missing, 2000);
      await save(win);
      assert.ok(await until(async () => (await win.locator('#googlePill').textContent()) === 'Google Sheets · ошибка', 5000),
        `${mode}: pill shows ошибка`);
      assert.ok(await win.locator('#googlePill').evaluate((n) => n.classList.contains('bad')), `${mode}: pill styled bad`);
      const title = await win.locator('#googlePill').getAttribute('title');
      assert.ok(title && title.includes(missing), `${mode}: pill tooltip names the missing file (got ${JSON.stringify(title)})`);
      // UI is Russian: the message must be too (service mode says "Не найден ключ…")
      assert.match(title, /не найден/i, `${mode}: error message is localized`);
      assert.deepStrictEqual((await calls(app)).filter((c) => c[0] === 'openExternal'), [], 'no browser opened');
    } finally {
      await quit(app);
      cleanup(dirs.root);
    }
  });
}

test('version shown; Проверить обновления in an unpackaged app answers without hanging', async () => {
  const dirs = tempDirs();
  const { app, win } = await start(dirs);
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  try {
    await openDrawer(win);
    const { version } = require(path.join(REPO, 'package.json'));
    assert.strictEqual(await win.locator('#version').textContent(), version, 'version in drawer');

    await win.locator('#checkUpdates').click();
    assert.ok(await until(async () => {
      const t = await win.locator('#updateInfo').textContent();
      return t && t !== 'Проверка обновлений…';
    }, 5000), 'update check finishes (no stuck "Проверка…")');
    const info = await win.locator('#updateInfo').textContent();
    assert.ok(!/Ошибка/.test(info), `no error text: ${info}`);
    assert.ok(await win.locator('#update').isHidden(), 'no update banner');
    assert.ok(await win.locator('#drawer').isVisible(), 'drawer still open');
    assert.deepStrictEqual(errors, [], 'no renderer exceptions');
    // app still responsive
    assert.ok(await win.evaluate(() => window.api.getState().then((s) => !!s.settings)), 'main still answers IPC');
  } finally {
    await quit(app);
    cleanup(dirs.root);
  }
});
