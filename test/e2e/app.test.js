const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const electronPath = require('electron');
const { REPO, makePng, solid, wait, until, tempDirs, appEnv, launch, writeClipboard, imgFiles } = require('./helpers');

// Uses the real Windows clipboard: run alone, don't copy things while it runs.

const statusIs = (win, text) => until(async () => (await win.locator('#statusText').textContent()) === text);
const cleanup = (root) => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } };
const quit = async (app) => { await app.evaluate(({ app: a }) => a.quit()).catch(() => {}); await app.close().catch(() => {}); };

test('watching, dedupe, pause, baseline, settings, single instance', async () => {
  const dirs = tempDirs();
  const { userData, folder, root } = dirs;
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ folder }));
  const red = solid(64, 48, [220, 40, 40]);
  const blue = solid(64, 48, [40, 80, 220]);
  const green = solid(64, 48, [40, 180, 80]);
  const yellow = solid(64, 48, [230, 200, 40]);
  const purple = solid(64, 48, [140, 60, 180]);
  const cyan = solid(64, 48, [40, 190, 200]);

  let { app, win } = await launch(dirs);
  try {
    assert.ok(await statusIs(win, 'Отслеживается'), 'auto-starts watching');
    await wait(1200); // let the baseline read finish

    await writeClipboard(app, red);
    assert.ok(await until(() => fs.existsSync(path.join(folder, 'img_1.png'))), 'img_1.png saved within 5s');
    assert.ok(await until(async () => (await win.locator('.shot').count()) === 1), 'gallery card shown');

    await writeClipboard(app, red);
    await wait(2500);
    assert.deepStrictEqual(imgFiles(folder), ['img_1.png'], 'same image saved once');

    await writeClipboard(app, blue);
    assert.ok(await until(() => fs.existsSync(path.join(folder, 'img_2.png'))), 'different image -> img_2.png');

    await win.locator('#toggleRun').click();
    assert.ok(await statusIs(win, 'Пауза'), 'paused');
    await writeClipboard(app, green);
    await wait(2500);
    assert.deepStrictEqual(imgFiles(folder), ['img_1.png', 'img_2.png'], 'paused: not saved');

    await win.locator('#toggleRun').click();
    assert.ok(await statusIs(win, 'Отслеживается'), 'resumed');
    await wait(2500);
    assert.deepStrictEqual(imgFiles(folder), ['img_1.png', 'img_2.png'], 'image in clipboard at Старт is baseline');
    await writeClipboard(app, yellow);
    assert.ok(await until(() => fs.existsSync(path.join(folder, 'img_3.png'))), 'after Старт new image saved');

    // settings drawer
    await win.locator('#openSettings').click();
    assert.ok(await win.locator('#drawer').isVisible(), 'drawer opens');
    await win.locator('input[name=notifyOnSave]').check();
    await win.locator('#saveBtn').click();
    assert.ok(await until(() => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).notifyOnSave === true),
      'notifyOnSave persisted to settings.json');
    await win.locator('#closeSettings').click();

    // second instance: exits, does not start a second watcher
    const second = spawn(electronPath, [REPO], { env: appEnv(userData), cwd: root, stdio: 'ignore' });
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => { second.kill(); resolve('timeout'); }, 20000);
      second.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    assert.strictEqual(code, 0, 'second instance exits with 0');
    assert.strictEqual(app.windows().length, 1, 'still one window');
    await writeClipboard(app, purple);
    assert.ok(await until(() => fs.existsSync(path.join(folder, 'img_4.png'))), 'img_4 saved');
    await wait(2500);
    assert.deepStrictEqual(imgFiles(folder), ['img_1.png', 'img_2.png', 'img_3.png', 'img_4.png'], 'no duplicate from a second watcher');
  } finally {
    await quit(app);
  }

  // restart with an image already in the clipboard (purple): must not be saved
  ({ app, win } = await launch(dirs));
  try {
    assert.ok(await statusIs(win, 'Отслеживается'));
    await wait(3000);
    assert.strictEqual(imgFiles(folder).length, 4, 'image present at launch not saved');
    await writeClipboard(app, cyan);
    assert.ok(await until(() => fs.existsSync(path.join(folder, 'img_5.png'))), 'watcher alive after restart');
  } finally {
    await quit(app);
    cleanup(root);
  }
});

// Sample "screenshots" so the gallery looks real.
const SAMPLES = [
  (x, y) => [30 + x % 200, 90 + y % 120, 160], // gradient
  (x, y) => (Math.floor(x / 24) + Math.floor(y / 24)) % 2 ? [245, 245, 245] : [200, 210, 220], // checker
  (x, y) => (y < 28 ? [31, 111, 139] : y % 22 < 2 ? [220, 225, 230] : [255, 255, 255]), // "document"
  (x, y) => { const d = Math.hypot(x - 160, y - 100); return [255 - d, 140, 60 + d / 2]; }, // radial
  (x, y) => (x < 70 ? [40, 44, 52] : y < 24 ? [60, 64, 72] : [30, 33, 39]), // "code editor"
  (x, y) => [(x * 3) % 256, (y * 5) % 256, 128], // stripes
  (x, y) => (y > 120 - Math.sin(x / 20) * 30 ? [70, 150, 90] : [150, 200, 240]), // "landscape"
  (x, y) => (Math.abs(x - 160) < 60 && Math.abs(y - 100) < 40 ? [250, 200, 60] : [235, 235, 240]), // "dialog"
];

test('screenshots light and dark', async () => {
  const dirs = tempDirs();
  const { userData, folder, root } = dirs;
  SAMPLES.forEach((fn, i) => {
    const file = path.join(folder, `img_${i + 1}.png`);
    fs.writeFileSync(file, makePng(320, 200, (x, y) => fn(x, y).map((v) => Math.max(0, Math.min(255, Math.round(v))))));
    const t = new Date(Date.now() - (SAMPLES.length - i) * 7 * 60000);
    fs.utimesSync(file, t, t);
  });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ folder, recentFolders: [folder] }));

  const { app, win } = await launch(dirs);
  try {
    assert.ok(await statusIs(win, 'Отслеживается'));
    assert.ok(await until(async () => (await win.locator('.shot').count()) === SAMPLES.length), 'all sample cards');
    // docs only: hide the temp path, it contains the local user name
    await win.evaluate(() => { document.getElementById('folderPath').textContent = 'C:\\Users\\user\\Pictures\\Скриншоты'; });
    for (const theme of ['light', 'dark']) {
      await app.evaluate(({ nativeTheme }, t) => { nativeTheme.themeSource = t; }, theme);
      await wait(800); // theme switch + images decoded
      await win.mouse.move(700, 870); // park the cursor in empty space so no card shows :hover
      await until(() => win.evaluate(() => !document.querySelector('.shot:hover')), 2000);
      await win.screenshot({ path: path.join(REPO, 'docs', `screenshot-${theme}.png`) });
    }
  } finally {
    await quit(app);
    cleanup(root);
  }
});
