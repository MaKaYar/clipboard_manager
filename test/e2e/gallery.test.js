const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { solid, wait, until, tempDirs, launch, imgFiles } = require('./helpers');

// Gallery cards + every context-menu item. Uses the real Windows clipboard (copy test): run alone.
// shell/dialog are stubbed in main, so nothing is opened for real.

const cleanup = (root) => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } };
const quit = async (app) => { await app.evaluate(({ app: a }) => a.quit()).catch(() => {}); await app.close().catch(() => {}); };

const COLORS = [[220, 40, 40], [40, 80, 220], [40, 180, 80]];

// Seeds img_1..3 in <root>/<folderName>, writes settings, launches, stubs OS calls.
async function setup({ folderName = 'shots', slashes = false, google } = {}) {
  const dirs = tempDirs();
  const folder = path.join(dirs.root, folderName);
  fs.mkdirSync(folder, { recursive: true });
  COLORS.forEach((c, i) => fs.writeFileSync(path.join(folder, `img_${i + 1}.png`), solid(40 + i * 10, 30, c)));
  const settingsFolder = slashes ? folder.replace(/\\/g, '/') : folder;
  const settings = { folder: settingsFolder, recentFolders: [settingsFolder] };
  if (google) settings.google = google(dirs);
  fs.writeFileSync(path.join(dirs.userData, 'settings.json'), JSON.stringify(settings));
  const { app, win } = await launch(dirs);
  await app.evaluate(({ shell, dialog }) => {
    globalThis.__calls = [];
    const rec = (name, ret) => async (...a) => { globalThis.__calls.push([name, ...a]); return ret; };
    shell.openPath = rec('openPath', '');
    shell.showItemInFolder = (p) => { globalThis.__calls.push(['showItemInFolder', p]); };
    shell.openExternal = rec('openExternal');
    dialog.showOpenDialog = rec('showOpenDialog', { canceled: true, filePaths: [] });
  });
  assert.ok(await until(async () => (await win.locator('.shot').count()) === 3), 'three cards shown');
  return { ...dirs, folder, settingsFolder, app, win };
}

const calls = (app) => app.evaluate(() => globalThis.__calls);
const card = (win, n) => win.locator(`.shot[title="img_${n}.png"]`);
const galleryPath = (win, n) => win.evaluate(async (f) => (await window.api.getState()).gallery.find((g) => g.filename === f).path, `img_${n}.png`);
const menu = (win) => win.locator('#ctxMenu');
const item = (win, act) => win.locator(`#ctxMenu button[data-act="${act}"]`);
const logText = (win) => win.locator('#logBody').textContent();

async function rightClick(win, n) {
  const box = await card(win, n).boundingBox();
  const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
  await win.mouse.click(x, y, { button: 'right' });
  assert.ok(await until(() => menu(win).isVisible(), 2000), 'context menu visible');
  return { x, y };
}

async function menuAction(win, n, act) {
  await rightClick(win, n);
  await item(win, act).click();
  assert.ok(await menu(win).isHidden(), 'menu closes after action');
}

// Open / Show in folder / left click for one folder layout.
async function checkOpenShow(opts) {
  const ctx = await setup(opts);
  const { app, win, folder, root } = ctx;
  try {
    const p2 = await galleryPath(win, 2);
    assert.ok(fs.existsSync(p2), 'gallery path points at the real file');
    assert.strictEqual(path.resolve(p2), path.join(folder, 'img_2.png'));

    await menuAction(win, 2, 'open');
    assert.ok(await until(async () => (await calls(app)).length === 1, 2000), `Открыть calls shell.openPath: ${await logText(win)}`);
    assert.deepStrictEqual(await calls(app), [['openPath', p2]]);

    await menuAction(win, 2, 'show');
    assert.ok(await until(async () => (await calls(app)).length === 2, 2000), `Показать в папке: ${await logText(win)}`);
    assert.deepStrictEqual((await calls(app))[1], ['showItemInFolder', p2]);

    await card(win, 3).click();
    assert.ok(await until(async () => (await calls(app)).length === 3, 2000), 'left click opens image');
    assert.deepStrictEqual((await calls(app))[2], ['openPath', await galleryPath(win, 3)]);
  } finally {
    await quit(app);
    cleanup(root);
  }
}

test('menu appears at cursor; Escape, outside click and keyboard', async () => {
  const { app, win, root } = await setup();
  try {
    const { x, y } = await rightClick(win, 1);
    const pos = await menu(win).evaluate((m) => [parseFloat(m.style.left), parseFloat(m.style.top)]);
    assert.deepStrictEqual(pos, [x, y], 'menu top-left at the cursor');
    const labels = await win.locator('#ctxMenu button').allTextContents();
    assert.deepStrictEqual(labels, ['Открыть', 'Показать в папке', 'Копировать', 'Отправить в Sheets']);

    await win.keyboard.press('Escape');
    assert.ok(await menu(win).isHidden(), 'Escape closes menu');

    await rightClick(win, 1);
    await win.mouse.click(5, 5); // header corner, outside the menu
    assert.ok(await menu(win).isHidden(), 'outside click closes menu');
    assert.deepStrictEqual(await calls(app), [], 'outside click triggered nothing');

    await card(win, 2).focus();
    await win.keyboard.press('Shift+F10');
    assert.ok(await until(() => menu(win).isVisible(), 2000), 'Shift+F10 opens menu');
    await win.keyboard.press('Enter'); // focus is on Открыть
    assert.ok(await until(async () => (await calls(app)).length === 1, 2000), 'keyboard Открыть works');
    assert.deepStrictEqual(await calls(app), [['openPath', await galleryPath(win, 2)]]);
  } finally {
    await quit(app);
    cleanup(root);
  }
});

test('Открыть / Показать в папке / left click: plain folder', () => checkOpenShow({}));
test('Открыть / Показать в папке / left click: "Мои скрины 1" (spaces + Cyrillic)', () => checkOpenShow({ folderName: 'Мои скрины 1' }));
test('Открыть / Показать в папке / left click: settings.folder with forward slashes', () => checkOpenShow({ slashes: true }));
test('Открыть / Показать в папке / left click: forward slashes + Cyrillic', () => checkOpenShow({ folderName: 'Мои скрины 1', slashes: true }));

test('Копировать puts the image in the clipboard and the watcher does not re-save it', async () => {
  const { app, win, folder, root } = await setup({ folderName: 'Мои скрины 1', slashes: true });
  try {
    assert.ok(await until(async () => (await win.locator('#statusText').textContent()) === 'Отслеживается'));
    await app.evaluate(({ clipboard }) => clipboard.writeText('cis-e2e placeholder'));
    await wait(1500);
    await menuAction(win, 2, 'copy');
    assert.ok(await until(async () => (await logText(win)).includes('Скопировано img_2.png'), 3000), `journal: ${await logText(win)}`);
    const got = await app.evaluate(async ({ clipboard, nativeImage }) => {
      const it = (await clipboard.read()).find((i) => i.types.includes('image/png'));
      if (!it) return null;
      const img = nativeImage.createFromBuffer(Buffer.from(await (await it.getType('image/png')).arrayBuffer()));
      const bm = img.toBitmap(); // BGRA
      return { size: img.getSize(), rgb: [bm[2], bm[1], bm[0]] };
    });
    assert.deepStrictEqual(got, { size: { width: 50, height: 30 }, rgb: COLORS[1] }, 'clipboard holds img_2');
    await wait(3000);
    assert.deepStrictEqual(imgFiles(folder), ['img_1.png', 'img_2.png', 'img_3.png'], 'copy not saved as img_4');
  } finally {
    await quit(app);
    cleanup(root);
  }
});

test('Отправить в Sheets повторно with Google off', async () => {
  const { app, win, root } = await setup();
  try {
    await rightClick(win, 1);
    assert.ok(await item(win, 'retry').isDisabled(), 'retry disabled when Google is off');
    await win.keyboard.press('Escape');
    const err = await win.evaluate(async (p) => window.api.retrySync(p).then(() => 'resolved', (e) => e.message), await galleryPath(win, 1));
    assert.match(err, /Синхронизация с Google выключена/);
    assert.match(await win.locator('#googlePill').textContent(), /выключено/, 'UI shows Google is off');
  } finally {
    await quit(app);
    cleanup(root);
  }
});

test('Отправить в Sheets повторно with Google unreachable: pending -> error', async () => {
  // Local token endpoint that hangs then drops the connection: no real Google is contacted.
  const server = http.createServer((req) => setTimeout(() => req.socket.destroy(), 1500));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const tokenUri = `http://127.0.0.1:${server.address().port}/token`;
  const google = ({ root, userData }) => {
    const secret = path.join(root, 'client_secret.json');
    fs.writeFileSync(secret, JSON.stringify({ installed: { client_id: 'x', client_secret: 'y', token_uri: tokenUri } }));
    fs.writeFileSync(path.join(userData, 'google-token.json'), JSON.stringify({ access_token: 'a', refresh_token: 'r', expiry_date: 1 }));
    return { enabled: true, authMode: 'oauth', clientSecretFile: secret, spreadsheetId: 'sheet', sheetName: 'Sheet1', searchTerm: 'add' };
  };
  const { app, win, root } = await setup({ google });
  try {
    const badge = card(win, 1).locator('.badge');
    assert.ok(await until(async () => /ошибка/.test(await win.locator('#googlePill').textContent()), 8000), 'startup connect fails');
    await rightClick(win, 1);
    assert.ok(await item(win, 'retry').isEnabled(), 'retry enabled when Google is on');
    await item(win, 'retry').click();
    assert.ok(await until(async () => (await badge.isVisible()) && (await badge.textContent()) === 'отправка', 1500), 'badge pending');
    assert.ok(await until(async () => (await badge.textContent()) === 'ошибка', 10000), 'badge error');
    assert.ok((await badge.getAttribute('title')).length > 0, 'error reason in badge tooltip');
    assert.match(await logText(win), /img_1\.png: /, 'error in journal');
    assert.deepStrictEqual((await calls(app)).filter((c) => c[0] === 'openExternal'), [], 'no browser login opened');
  } finally {
    await quit(app);
    cleanup(root);
    server.close();
  }
});

test('IPC rejects paths outside the folder and non img_N files', async () => {
  const { app, win, folder, settingsFolder, root } = await setup({ folderName: 'Мои скрины 1', slashes: true });
  try {
    fs.writeFileSync(path.join(folder, 'notes.png'), solid(4, 4, [0, 0, 0]));
    fs.writeFileSync(path.join(folder, 'img_1.png.exe'), 'x');
    const sibling = folder + ' 2';
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'img_1.png'), solid(4, 4, [0, 0, 0]));
    fs.writeFileSync(path.join(root, 'img_1.png'), solid(4, 4, [0, 0, 0]));
    const bad = [
      path.join(root, 'img_1.png'), // parent dir
      path.join(sibling, 'img_1.png'), // prefix-sharing sibling folder
      path.join(folder, '..', 'img_1.png'),
      path.join(folder, 'notes.png'),
      path.join(folder, 'img_1.png.exe'),
      path.join(folder, 'IMG_1.PNG.lnk'),
      folder,
      'img_1.png', // relative: resolves against cwd
      '', null, 42,
    ];
    const res = await win.evaluate(async (paths) => {
      const out = [];
      for (const p of paths) {
        for (const fn of ['openImage', 'showInFolder', 'copyImage', 'retrySync']) {
          out.push(await window.api[fn](p).then(() => `${fn}(${p}) resolved`, () => null));
        }
      }
      return out.filter(Boolean);
    }, bad);
    assert.deepStrictEqual(res, [], 'every bad path rejected');
    assert.deepStrictEqual(await calls(app), [], 'no shell call for rejected paths');

    // sanity: the same API accepts a real gallery image, in both slash styles
    await win.evaluate((p) => window.api.openImage(p), settingsFolder + '/img_1.png');
    await win.evaluate((p) => window.api.openImage(p), path.join(folder, 'img_1.png'));
    assert.strictEqual((await calls(app)).length, 2, 'valid paths accepted');
  } finally {
    await quit(app);
    cleanup(root);
  }
});

test('failed menu action shows an error in the journal', async () => {
  const { app, win, root } = await setup();
  try {
    // (a deleted file is no longer a stale card: the gallery refreshes on outside changes)
    const errors = () => win.locator('#logBody .error').allTextContents().then((a) => a.join('\n'));
    // Windows reports "no app associated with .png" as openPath's return value, not a rejection
    await app.evaluate(({ shell, clipboard }) => {
      shell.openPath = async () => 'Нет приложения для этого файла';
      clipboard.write = async () => { throw new Error('clipboard busy'); };
    });
    await menuAction(win, 2, 'open');
    assert.ok(await until(async () => /img_2.*Нет приложения/.test(await errors()), 3000),
      `Открыть: expected an error line in the journal, got: ${await logText(win)}`);
    await menuAction(win, 3, 'copy');
    assert.ok(await until(async () => /img_3.*clipboard busy/.test(await errors()), 3000),
      `Копировать: expected an error line in the journal, got: ${await logText(win)}`);
    await card(win, 1).click();
    assert.ok(await until(async () => /img_1.*Нет приложения/.test(await errors()), 3000),
      `left click: expected an error line in the journal, got: ${await logText(win)}`);
  } finally {
    await quit(app);
    cleanup(root);
  }
});

test('double-click opens once; focus survives a refresh; scroll and Tab close the menu', async () => {
  const { app, win, folder, root } = await setup();
  try {
    await card(win, 2).dblclick();
    await wait(500);
    assert.deepStrictEqual((await calls(app)).filter((c) => c[0] === 'openPath').length, 1, 'double-click opens one viewer');

    // outside add -> gallery refresh must keep keyboard focus on the same card
    await card(win, 2).focus();
    for (let i = 4; i <= 30; i++) fs.writeFileSync(path.join(folder, `img_${i}.png`), solid(40, 30, [i * 8, 90, 160]));
    assert.ok(await until(async () => (await win.locator('.shot').count()) === 30, 5000), 'outside adds shown');
    assert.strictEqual(await win.evaluate(() => document.activeElement.title), 'img_2.png', 'focus kept on img_2');

    await win.setViewportSize({ width: 760, height: 480 });
    await rightClick(win, 30);
    await win.mouse.wheel(0, 400);
    assert.ok(await until(() => menu(win).isHidden(), 2000), 'scroll closes the fixed-position menu');

    await rightClick(win, 30);
    for (let i = 0; i < 4; i++) await win.keyboard.press('Tab');
    assert.ok(await until(() => menu(win).isHidden(), 2000), 'Tab out of the menu closes it');
  } finally {
    await quit(app);
    cleanup(root);
  }
});
