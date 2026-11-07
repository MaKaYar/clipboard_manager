const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const electronPath = require('electron');
const { REPO, solid, wait, until, tempDirs, appEnv, launch: rawLaunch, imgFiles } = require('./helpers');

// Lifecycle, tray, journal, update banner, notifications.
// Never touches the real clipboard: images are fed by stubbing clipboard.read inside the main process.

const cleanup = (root) => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } };
// app.process() throws once Playwright disposes the app: grab the ChildProcess at launch
const procs = new WeakMap();
async function launch(dirs) {
  const r = await rawLaunch(dirs);
  procs.set(r.app, r.app.process());
  return r;
}
const proc = (app) => procs.get(app);
const exited = (app) => {
  const p = proc(app);
  return p.exitCode !== null ? Promise.resolve(p.exitCode) : new Promise((r) => p.once('exit', (c) => r(c)));
};
const isAlive = (app) => proc(app).exitCode === null && proc(app).signalCode === null;
const kill = async (app) => {
  if (isAlive(app)) await app.evaluate(({ app: a }) => a.quit()).catch(() => {});
  await app.close().catch(() => {});
  if (isAlive(app)) proc(app).kill();
};
const statusIs = (win, text) => until(async () => (await win.locator('#statusText').textContent()) === text);

async function setup(settings = {}) {
  const dirs = tempDirs('cis-life-');
  fs.writeFileSync(path.join(dirs.userData, 'settings.json'), JSON.stringify({ folder: dirs.folder, ...settings }));
  const { app, win } = await launch(dirs);
  // stub every side-effecting OS call the app can make
  await app.evaluate(({ shell, dialog, Tray }) => {
    globalThis.__calls = [];
    shell.openPath = async (p) => { globalThis.__calls.push(['openPath', p]); return ''; };
    shell.showItemInFolder = (p) => { globalThis.__calls.push(['showItemInFolder', p]); };
    shell.openExternal = async (u) => { globalThis.__calls.push(['openExternal', u]); };
    dialog.showOpenDialog = async () => { globalThis.__calls.push(['showOpenDialog']); return { canceled: true, filePaths: [] }; };
    // capture the tray and its current menu without a hook in main.js
    const orig = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function (menu) { globalThis.__tray = this; globalThis.__trayMenu = menu; return orig.call(this, menu); };
  });
  return { ...dirs, app, win };
}

const calls = (app) => app.evaluate(() => globalThis.__calls);
const winVisible = (app) => app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  return !!w && w.isVisible();
});
const closeWindow = (app) => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
// any pushState rebuilds the tray menu
const refreshTray = (win) => win.evaluate(() => window.api.saveSettings({}));
const trayLabels = (app) => app.evaluate(() => (globalThis.__trayMenu ? globalThis.__trayMenu.items.filter((i) => i.type !== 'separator').map((i) => `${i.label}${i.enabled ? '' : ' (disabled)'}`) : null));
const clickTray = (app, label) => app.evaluate((_e, l) => {
  const item = globalThis.__trayMenu.items.find((i) => i.label === l);
  if (!item) throw new Error(`no tray item ${l}`);
  item.click();
}, label);

// make the next clipboard poll see `png` (no real clipboard write)
const feedClipboard = (app, png) => app.evaluate(({ clipboard }, b64) => {
  const buf = Buffer.from(b64, 'base64');
  clipboard.read = async () => [{ types: ['image/png'], getType: async () => new Blob([buf], { type: 'image/png' }) }];
}, png.toString('base64'));

test('close with minimizeToTray=true hides the window, process stays alive', async () => {
  const s = await setup({ minimizeToTray: true });
  try {
    assert.ok(await until(() => winVisible(s.app)), 'window shown at start');
    await closeWindow(s.app);
    assert.ok(await until(async () => !(await winVisible(s.app))), 'window hidden after close');
    await wait(1000);
    assert.ok(isAlive(s.app), 'process still alive');
    assert.strictEqual(await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'window not destroyed');
  } finally { await kill(s.app); cleanup(s.root); }
});

test('close with minimizeToTray=false quits the app', async () => {
  const s = await setup({ minimizeToTray: false });
  try {
    assert.ok(await until(() => winVisible(s.app)));
    const done = exited(s.app);
    await closeWindow(s.app);
    const code = await Promise.race([done, wait(10000).then(() => 'timeout')]);
    assert.strictEqual(code, 0, 'app exits with 0 after window close');
  } finally { await kill(s.app); cleanup(s.root); }
});

test('second instance shows and focuses the hidden first window', async () => {
  const s = await setup({ minimizeToTray: true });
  try {
    assert.ok(await until(() => winVisible(s.app)));
    await closeWindow(s.app);
    assert.ok(await until(async () => !(await winVisible(s.app))), 'hidden to tray');
    const second = spawn(electronPath, [REPO], { env: appEnv(s.userData), cwd: s.root, stdio: 'ignore' });
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => { second.kill(); resolve('timeout'); }, 20000);
      second.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    assert.strictEqual(code, 0, 'second instance exits');
    assert.ok(await until(() => winVisible(s.app)), 'first window shown again');
    assert.strictEqual(await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'still one window');
  } finally { await kill(s.app); cleanup(s.root); }
});

test('tray menu: Открыть, Пауза/Старт, Открыть папку, Выход', async () => {
  const s = await setup({ minimizeToTray: true });
  try {
    assert.ok(await statusIs(s.win, 'Отслеживается'));
    await refreshTray(s.win);
    assert.ok(await until(async () => !!(await trayLabels(s.app))), 'tray menu captured');
    assert.deepStrictEqual(await trayLabels(s.app), ['Открыть', 'Пауза', 'Открыть папку', 'Выход']);
    assert.ok(await s.app.evaluate(() => !!globalThis.__tray && !globalThis.__tray.isDestroyed()), 'tray alive');

    // Пауза -> watcher stops, menu flips to Старт, UI follows
    await clickTray(s.app, 'Пауза');
    assert.ok(await statusIs(s.win, 'Пауза'), 'UI shows paused after tray Пауза');
    assert.deepStrictEqual(await trayLabels(s.app), ['Открыть', 'Старт', 'Открыть папку', 'Выход']);
    assert.strictEqual(await s.win.locator('#toggleRun').textContent(), 'Старт');

    // Старт -> watching again
    await clickTray(s.app, 'Старт');
    assert.ok(await statusIs(s.win, 'Отслеживается'), 'UI shows watching after tray Старт');
    assert.deepStrictEqual(await trayLabels(s.app), ['Открыть', 'Пауза', 'Открыть папку', 'Выход']);

    // Открыть папку -> shell.openPath(folder) (stubbed)
    await clickTray(s.app, 'Открыть папку');
    assert.ok(await until(async () => (await calls(s.app)).some(([n, p]) => n === 'openPath' && p === s.folder)), 'openPath(folder) called');

    // Открыть -> hidden window shown again
    await closeWindow(s.app);
    assert.ok(await until(async () => !(await winVisible(s.app))), 'hidden');
    await clickTray(s.app, 'Открыть');
    assert.ok(await until(() => winVisible(s.app)), 'tray Открыть shows the window');

    // Выход -> process exits even with minimizeToTray
    const done = exited(s.app);
    await clickTray(s.app, 'Выход');
    const code = await Promise.race([done, wait(10000).then(() => 'timeout')]);
    assert.strictEqual(code, 0, 'tray Выход quits the app');
  } finally { await kill(s.app); cleanup(s.root); }
});

test('tray menu without a folder: Старт and Открыть папку disabled', async () => {
  const dirs = tempDirs('cis-life-');
  const { app, win } = await launch(dirs);
  try {
    await app.evaluate(({ Tray }) => {
      const orig = Tray.prototype.setContextMenu;
      Tray.prototype.setContextMenu = function (menu) { globalThis.__trayMenu = menu; return orig.call(this, menu); };
    });
    assert.ok(await statusIs(win, 'Папка не выбрана'));
    await refreshTray(win);
    assert.ok(await until(async () => !!(await trayLabels(app))));
    assert.deepStrictEqual(await trayLabels(app), ['Открыть', 'Старт (disabled)', 'Открыть папку (disabled)', 'Выход']);
  } finally { await kill(app); cleanup(dirs.root); }
});

test('journal toggles and shows new log lines', async () => {
  const s = await setup();
  try {
    assert.ok(await statusIs(s.win, 'Отслеживается'));
    const log = s.win.locator('#log');
    const isOpen = () => log.evaluate((d) => d.open);
    assert.strictEqual(await isOpen(), false, 'collapsed by default');
    assert.strictEqual(await s.win.locator('#logBody').isVisible(), false, 'body hidden when collapsed');
    await s.win.locator('#logSummary').click();
    assert.ok(await until(isOpen), 'expanded after click');
    assert.ok(await s.win.locator('#logBody').isVisible(), 'body visible when expanded');
    assert.match(await s.win.locator('#logBody').textContent(), /Запуск, версия/, 'startup line replayed');

    const count = async () => Number(((await s.win.locator('#logSummary').textContent()).match(/\d+/) || [0])[0]);
    const before = await count();
    await s.win.locator('#toggleRun').click();
    assert.ok(await statusIs(s.win, 'Пауза'));
    assert.ok(await until(async () => /Пауза/.test(await s.win.locator('#logBody div').first().textContent())), 'newest line on top: Пауза');
    assert.ok(await until(async () => (await count()) > before), 'summary counter grows');

    await s.win.locator('#logSummary').click();
    assert.ok(await until(async () => !(await isOpen())), 'collapsed again');

    // open state survives a reload (localStorage)
    await s.win.locator('#logSummary').click();
    await s.win.reload();
    await s.win.waitForLoadState('domcontentloaded');
    assert.ok(await until(isOpen), 'journal stays open after reload');
  } finally { await kill(s.app); cleanup(s.root); }
});

test('update banner: downloading/downloaded text, install is a no-op when nothing downloaded', async () => {
  const s = await setup({ minimizeToTray: true });
  try {
    assert.ok(await statusIs(s.win, 'Отслеживается'));
    const sendUpdate = (u) => s.app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('update:state', p), u);
    assert.strictEqual(await s.win.locator('#update').isVisible(), false, 'no banner at start');

    await sendUpdate({ state: 'downloading', version: '9.9.9', percent: 42.4 });
    assert.ok(await until(() => s.win.locator('#update').isVisible()), 'banner while downloading');
    assert.strictEqual(await s.win.locator('#updateText').textContent(), 'Скачивается версия 9.9.9 · 42%');
    assert.strictEqual(await s.win.locator('#updateInstall').isVisible(), false, 'no restart button while downloading');

    await sendUpdate({ state: 'downloaded', version: '9.9.9' });
    assert.ok(await until(async () => (await s.win.locator('#updateText').textContent()) === 'Скачана версия 9.9.9. Установится при выходе.'), 'downloaded text');
    const btn = s.win.locator('#updateInstall');
    assert.ok(await btn.isVisible(), 'restart button visible');
    assert.strictEqual(await btn.textContent(), 'Перезапустить сейчас');

    // main never recorded 'downloaded' (and dev build has no autoUpdater): installUpdate must not quit or wedge
    await btn.click();
    await wait(1500);
    assert.ok(isAlive(s.app), 'still running after install click');
    // quitting flag must not be stuck: close still hides to tray
    await closeWindow(s.app);
    assert.ok(await until(async () => !(await winVisible(s.app))), 'close still hides');
    assert.ok(isAlive(s.app), 'process alive after close');

    await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    // dev check: main answers 'none' through its own send(); banner goes away
    await s.win.locator('#openSettings').click();
    await s.win.locator('#checkUpdates').click();
    assert.ok(await until(async () => (await s.win.locator('#updateInfo').textContent()) === 'Установлена последняя версия'), 'check -> none');
    assert.strictEqual(await s.win.locator('#update').isVisible(), false, 'banner hidden after none');
  } finally { await kill(s.app); cleanup(s.root); }
});

test('installUpdate is a no-op after a dev-build check (state none)', async () => {
  // main only stores update state through its own send(); reach it via the updater module's send in a dev build:
  // checkForUpdates -> updater.check -> send('update:state', {state:'none'}). There is no way to make main record
  // 'downloaded' without electron-updater (packaged only), so we verify the guard: installUpdate with state 'none' is a no-op.
  const s = await setup();
  try {
    assert.ok(await statusIs(s.win, 'Отслеживается'));
    await s.win.evaluate(() => window.api.checkForUpdates());
    await s.win.evaluate(() => window.api.installUpdate());
    await wait(1500);
    assert.ok(isAlive(s.app), 'installUpdate with state none does nothing');
  } finally { await kill(s.app); cleanup(s.root); }
});

async function notifRun(notifyOnSave) {
  const s = await setup({ notifyOnSave });
  try {
    assert.ok(await statusIs(s.win, 'Отслеживается'));
    await wait(1200); // baseline from the real clipboard (read only)
    await s.app.evaluate(({ Notification }) => {
      globalThis.__notes = [];
      Notification.isSupported = () => true;
      Notification.prototype.show = function () { globalThis.__notes.push({ title: this.title, body: this.body }); };
    });
    await feedClipboard(s.app, solid(32, 24, [12, 200, 99]));
    assert.ok(await until(() => imgFiles(s.folder).length === 1), 'stubbed clipboard image saved');
    await wait(500);
    return await s.app.evaluate(() => globalThis.__notes);
  } finally { await kill(s.app); cleanup(s.root); }
}

test('notification shown on save when notifyOnSave=true', async () => {
  const notes = await notifRun(true);
  assert.deepStrictEqual(notes, [{ title: 'Изображение сохранено', body: 'img_1.png' }]);
});

test('no notification on save when notifyOnSave=false', async () => {
  assert.deepStrictEqual(await notifRun(false), []);
});
