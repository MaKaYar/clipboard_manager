const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { solid, wait, until, tempDirs, launch } = require('./helpers');

// Header, folder bar, stats, empty states. Never touches the real clipboard, shell or dialogs:
// clipboard.read / shell.* / dialog.showOpenDialog are stubbed inside the main process.

const quit = async (app) => { await app.evaluate(({ app: a }) => a.quit()).catch(() => {}); await app.close().catch(() => {}); };
const cleanup = (root) => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } };
const text = (win, sel) => win.locator(sel).textContent();
const statusIs = (win, t, ms) => until(async () => (await text(win, '#statusText')) === t, ms);
const readSettings = (userData) => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
const cardNames = (win) => win.locator('.shot .name').allTextContents();
const calls = (app) => app.evaluate(() => globalThis.__calls);
const pad = (n) => String(n).padStart(2, '0');
const hhmmss = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

// folder with img_1..img_n, mtimes one minute apart (img_n newest)
function mkFolder(root, name, n) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= n; i++) addImg(dir, i, Date.now() - (n - i + 1) * 60000);
  return dir;
}
function addImg(dir, i, mtime = Date.now()) {
  const f = path.join(dir, `img_${i}.png`);
  fs.writeFileSync(f, solid(16, 16, [i * 20 % 256, 100, 150]));
  fs.utimesSync(f, new Date(mtime), new Date(mtime));
  return f;
}

async function stub(app) {
  await app.evaluate(({ shell, dialog, clipboard }) => {
    globalThis.__calls = [];
    globalThis.__pick = null;
    globalThis.__clip = [];
    const rec = (...c) => globalThis.__calls.push(c);
    shell.openPath = async (p) => { rec('openPath', p); return ''; };
    shell.showItemInFolder = (p) => { rec('showItemInFolder', p); };
    shell.openExternal = async (u) => { rec('openExternal', u); };
    dialog.showOpenDialog = async () => {
      rec('showOpenDialog');
      const p = globalThis.__pick;
      return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] };
    };
    clipboard.read = async () => globalThis.__clip;
  });
}
const setPick = (app, p) => app.evaluate((_e, v) => { globalThis.__pick = v; }, p);
const setClip = (app, png) => app.evaluate((_e, b64) => {
  globalThis.__clip = b64 ? [{ types: ['image/png'], getType: async () => new Blob([Buffer.from(b64, 'base64')]) }] : [];
}, png ? png.toString('base64') : null);

// settings: (dirs) => object | null (null = fresh install, no settings.json)
async function withApp(settings, fn) {
  const dirs = tempDirs();
  const s = settings(dirs);
  if (s) fs.writeFileSync(path.join(dirs.userData, 'settings.json'), JSON.stringify(s));
  const { app, win } = await launch(dirs);
  try {
    await stub(app);
    await win.locator('#statusText').filter({ hasNotText: '…' }).waitFor();
    await fn({ app, win, ...dirs });
  } finally {
    await quit(app);
    cleanup(dirs.root);
  }
}

test('Старт/Пауза toggles watching, pill and button', () => withApp(({ folder }) => ({ folder, recentFolders: [folder] }), async ({ app, win, folder }) => {
  const pill = win.locator('#statusPill');
  const run = win.locator('#toggleRun');
  assert.ok(await statusIs(win, 'Отслеживается'), 'auto-starts with a folder');
  assert.match(await pill.getAttribute('class'), /\bok\b/);
  assert.strictEqual(await run.textContent(), 'Пауза');

  await run.click();
  assert.ok(await statusIs(win, 'Пауза'), 'pill says Пауза');
  assert.doesNotMatch(await pill.getAttribute('class'), /\b(ok|bad)\b/);
  assert.strictEqual(await run.textContent(), 'Старт');
  assert.strictEqual((await win.evaluate(() => window.api.getState())).running, false, 'main process stopped');

  await setClip(app, solid(32, 32, [200, 30, 30]));
  await wait(2500);
  assert.deepStrictEqual(fs.readdirSync(folder), [], 'paused: nothing saved');

  await run.click();
  assert.ok(await statusIs(win, 'Отслеживается'), 'resumed');
  assert.strictEqual(await run.textContent(), 'Пауза');
  assert.strictEqual((await win.evaluate(() => window.api.getState())).running, true);
  await wait(2500);
  assert.deepStrictEqual(fs.readdirSync(folder), [], 'image already in clipboard at Старт is baseline');

  await setClip(app, solid(32, 32, [30, 30, 200]));
  assert.ok(await until(() => fs.existsSync(path.join(folder, 'img_1.png'))), 'new image saved after Старт');
  assert.ok(await until(async () => (await cardNames(win)).join() === 'img_1'), 'card shown');
  assert.match(await text(win, '#stats'), /1за сессию/);
}));

test('status pill shows error when the folder becomes unusable, recovers after', () => withApp(({ folder }) => ({ folder }), async ({ app, win, folder }) => {
  const pill = win.locator('#statusPill');
  assert.ok(await statusIs(win, 'Отслеживается'));
  fs.rmSync(folder, { recursive: true, force: true });
  fs.writeFileSync(folder, 'not a dir'); // a file where the folder was: mkdir/write must fail
  await setClip(app, solid(32, 32, [10, 200, 10]));
  assert.ok(await statusIs(win, 'Ошибка сохранения'), 'pill shows save error');
  assert.match(await pill.getAttribute('class'), /\bbad\b/);
  assert.ok((await pill.getAttribute('title')).length > 0, 'error message in tooltip');
  assert.match(await text(win, '#logBody'), /EEXIST|ENOTDIR|EPERM|exist/i, 'error logged');

  fs.rmSync(folder, { force: true });
  await setClip(app, solid(32, 32, [10, 10, 200]));
  assert.ok(await until(() => fs.existsSync(path.join(folder, 'img_1.png'))), 'saves again once folder is back');
  assert.ok(await statusIs(win, 'Отслеживается'), 'error cleared');
  assert.doesNotMatch(await pill.getAttribute('class'), /\bbad\b/);
}));

test('Старт on a folder that cannot be created shows the error', () => withApp(({ folder }) => ({ folder }), async ({ win, folder }) => {
  await win.locator('#toggleRun').click();
  assert.ok(await statusIs(win, 'Пауза'));
  fs.rmSync(folder, { recursive: true, force: true });
  fs.writeFileSync(folder, 'not a dir');
  await win.locator('#toggleRun').click();
  assert.ok(await statusIs(win, 'Ошибка сохранения', 3000),
    `pill must not say all is well when mkdir failed; got "${await text(win, '#statusText')}", log: ${await text(win, '#logBody')}`);
}));

test('Изменить… switches folder, reloads gallery, updates recent', () => withApp(({ root }) => {
  const a = mkFolder(root, 'A', 2);
  return { folder: a, recentFolders: [a] };
}, async ({ app, win, root, userData }) => {
  const a = path.join(root, 'A');
  const b = mkFolder(root, 'B', 3);
  assert.ok(await until(async () => (await cardNames(win)).join() === 'img_2,img_1'), 'gallery of A');

  // cancel: nothing changes
  await win.locator('#changeFolder').click();
  assert.ok(await until(async () => (await calls(app)).length === 1));
  await wait(300);
  assert.strictEqual(await text(win, '#folderPath'), a, 'cancelled dialog keeps folder');

  await setPick(app, b);
  await win.locator('#changeFolder').click();
  assert.ok(await until(async () => (await text(win, '#folderPath')) === b), 'folder path switched');
  assert.ok(await until(async () => (await cardNames(win)).join() === 'img_3,img_2,img_1'), 'gallery reloaded from B');
  assert.match(await text(win, '#stats'), /3в папке/);
  assert.ok(await statusIs(win, 'Отслеживается'), 'still watching');
  assert.deepStrictEqual((await win.evaluate(() => window.api.getState())).folder, b);
  const s = readSettings(userData);
  assert.strictEqual(s.folder, b, 'persisted');
  assert.deepStrictEqual(s.recentFolders, [b, a], 'recent: new first');

  // paused stays paused after switching
  await win.locator('#toggleRun').click();
  assert.ok(await statusIs(win, 'Пауза'));
  await setPick(app, a);
  await win.locator('#changeFolder').click();
  assert.ok(await until(async () => (await text(win, '#folderPath')) === a));
  await wait(300);
  assert.strictEqual(await text(win, '#statusText'), 'Пауза', 'switching folder does not resume');
  assert.deepStrictEqual(readSettings(userData).recentFolders, [a, b]);
}));

test('Недавние ▾ lists recent folders, switches, closes', () => withApp(({ root }) => {
  const a = mkFolder(root, 'A', 1);
  const b = mkFolder(root, 'B', 4);
  return { folder: a, recentFolders: [a, b] };
}, async ({ win, root, userData }) => {
  const a = path.join(root, 'A');
  const b = path.join(root, 'B');
  const menu = win.locator('#recentMenu');
  const btn = win.locator('#recentBtn');

  await btn.click();
  assert.ok(await menu.isVisible(), 'menu opens');
  assert.strictEqual(await btn.getAttribute('aria-expanded'), 'true');
  assert.deepStrictEqual(await menu.locator('button').allTextContents(), [a, b]);

  await btn.click();
  assert.ok(await menu.isHidden(), 'button toggles menu closed');
  await btn.click();
  await win.keyboard.press('Escape');
  assert.ok(await menu.isHidden(), 'Escape closes');
  await btn.click();
  await win.mouse.click(5, 300); // outside
  assert.ok(await menu.isHidden(), 'outside click closes');

  await btn.click();
  await menu.locator('button', { hasText: b }).click();
  assert.ok(await menu.isHidden(), 'menu closes after pick');
  assert.strictEqual(await btn.getAttribute('aria-expanded'), 'false');
  assert.ok(await until(async () => (await text(win, '#folderPath')) === b), 'switched to B');
  assert.ok(await until(async () => (await cardNames(win)).length === 4), 'gallery of B');
  assert.deepStrictEqual(readSettings(userData).recentFolders, [b, a]);

  await btn.click();
  assert.deepStrictEqual(await menu.locator('button').allTextContents(), [b, a], 'menu reflects new order');

  // renderer cannot switch to an unknown folder
  await assert.rejects(win.evaluate((p) => window.api.setFolder(p), path.join(root, 'evil')), /недавних/);
}));

test('Открыть calls shell.openPath(folder)', () => withApp(({ folder }) => ({ folder }), async ({ app, win, folder }) => {
  await win.locator('#openFolder').click();
  assert.ok(await until(async () => (await calls(app)).length > 0));
  assert.deepStrictEqual(await calls(app), [['openPath', folder]]);
}));

test('stats row: за сессию / в папке / в Sheets / последнее', () => withApp(({ folder }) => {
  for (let i = 1; i <= 3; i++) addImg(folder, i, Date.now() - (4 - i) * 60000);
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'x');
  return { folder, google: { enabled: true, authMode: 'oauth', clientSecretFile: '' } }; // fails fast, no network
}, async ({ win, folder }) => {
  const stats = win.locator('#stats span');
  const expect = async (items) => until(async () => JSON.stringify(await stats.allTextContents()) === JSON.stringify(items));
  const last = (n) => `последнее: ${hhmmss(fs.statSync(path.join(folder, `img_${n}.png`)).mtimeMs)}`;

  assert.ok(await expect(['0за сессию', '3в папке', '0в Sheets', last(3)]),
    `initial stats, got ${JSON.stringify(await stats.allTextContents())}`);

  addImg(folder, 4, Date.now() - 30000);
  addImg(folder, 10, Date.now() - 600000); // highest number wins, even if older
  for (const junk of ['IMG_5.PNG', 'img_a.png', 'img_6.jpg']) fs.writeFileSync(path.join(folder, junk), 'x');
  // force a state push without relying on any file watching
  await win.locator('#toggleRun').click();
  assert.ok(await statusIs(win, 'Пауза'));
  assert.ok(await expect(['0за сессию', '5в папке', '0в Sheets', last(10)]),
    `stats after external add, got ${JSON.stringify(await stats.allTextContents())}`);
  assert.strictEqual((await cardNames(win))[0], 'img_10', 'newest by number first');
}));

test('empty states: no folder -> pick; empty folder text', () => withApp(() => null, async ({ app, win, root, userData }) => {
  assert.strictEqual(await text(win, '#statusText'), 'Папка не выбрана');
  assert.strictEqual(await text(win, '#folderPath'), 'не выбрана');
  assert.ok(await win.locator('#toggleRun').isDisabled(), 'Старт disabled without folder');
  assert.ok(await win.locator('#openFolder').isDisabled(), 'Открыть disabled without folder');
  assert.ok(await win.locator('#emptyNoFolder').isVisible());
  assert.ok(await win.locator('#emptyFolder').isHidden());
  assert.ok(await win.locator('#stats').isHidden());

  await win.locator('#pickFolderEmpty').click(); // cancelled
  assert.ok(await until(async () => (await calls(app)).length === 1));
  await wait(300);
  assert.ok(await win.locator('#emptyNoFolder').isVisible(), 'cancel keeps no-folder state');

  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty);
  await setPick(app, empty);
  await win.locator('#pickFolderEmpty').click();
  assert.ok(await until(async () => (await text(win, '#folderPath')) === empty), 'folder chosen');
  assert.ok(await statusIs(win, 'Отслеживается'), 'first folder auto-starts watching');
  assert.ok(await win.locator('#emptyNoFolder').isHidden());
  assert.ok(await win.locator('#emptyFolder').isVisible(), 'empty folder text shown');
  assert.match(await text(win, '#emptyFolder'), /Скопируйте картинку/);
  assert.ok(await win.locator('#openFolder').isEnabled());
  assert.deepStrictEqual(readSettings(userData).recentFolders, [empty]);
  assert.deepStrictEqual(await win.locator('#stats span').allTextContents(), ['0за сессию', '0в папке']);
}));

test('gallery refreshes when files are added/deleted outside the app', () => withApp(({ folder }) => {
  addImg(folder, 1);
  return { folder };
}, async ({ win, folder }) => {
  assert.ok(await until(async () => (await cardNames(win)).join() === 'img_1'));
  addImg(folder, 2);
  assert.ok(await until(async () => (await cardNames(win)).join() === 'img_2,img_1', 5000),
    `external add not shown; cards: ${await cardNames(win)}, stats: ${await text(win, '#stats')}`);
  fs.rmSync(path.join(folder, 'img_1.png'));
  assert.ok(await until(async () => (await cardNames(win)).join() === 'img_2', 5000),
    `external delete not shown; cards: ${await cardNames(win)}`);
}));
