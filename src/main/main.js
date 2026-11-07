const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, clipboard, ClipboardItem,
  Notification, nativeTheme, nativeImage,
} = require('electron');

if (process.env.CIS_USER_DATA) app.setPath('userData', path.resolve(process.env.CIS_USER_DATA));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  run();
}

function run() {
  const { ClipboardWatcher } = require('./watcher');
  const settingsLib = require('./settings');
  const { listRecent } = require('./gallery');
  const { GoogleSync, normalizeToken, parseSpreadsheetId } = require('./google-sync');
  const { initUpdater } = require('./updater');

  const ICONS = path.join(__dirname, '..', '..', 'build', 'icons');
  const userData = app.getPath('userData');
  const tokenPath = path.join(userData, 'google-token.json');
  const logFile = path.join(userData, 'app.log');

  let win = null;
  let tray = null;
  let quitting = false;
  let settings;
  let google = null;
  let googleStatus = 'off';
  let googleError;
  let googleGen = 0;
  let dirSig = ''; // img_N names as of the last getState(), for the outside-change poll
  let watchError; // last save failure, cleared on the next save or start/stop
  let updateState;
  let updater = { check: async () => {}, install() {} };
  let session = 0;
  let synced = 0;
  const syncMap = new Map(); // path -> {sync, syncError?, cell?}
  const logs = [];
  let syncQueue = Promise.resolve();
  const watcher = new ClipboardWatcher({ clipboard });

  // ---------- logging ----------
  function send(channel, payload) {
    if (channel === 'update:state') updateState = payload;
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  function log(level, text) {
    const entry = { ts: Date.now(), level, text };
    logs.push(entry);
    if (logs.length > 200) logs.shift();
    send('log', entry);
    try {
      fs.mkdirSync(userData, { recursive: true });
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
      fs.appendFileSync(logFile, `${new Date(entry.ts).toISOString()} ${level.toUpperCase()} ${text}\n`);
    } catch { /* logging must never break the app */ }
  }

  // ---------- state ----------
  function getState() {
    const folder = settings.folder;
    // ponytail: stats every img in the folder on each push; count via readdir if folders get huge
    const all = listRecent(folder, Infinity);
    dirSig = all.map((g) => g.filename).sort().join('|');
    return {
      settings,
      running: watcher.running,
      watchError,
      folder,
      stats: { session, inFolder: all.length, synced },
      gallery: all.slice(0, 40).map((g) => ({ ...g, ...syncMap.get(g.path) })),
      version: app.getVersion(),
      googleStatus,
      googleError,
      update: updateState,
      logs,
    };
  }

  const pushState = () => { send('state', getState()); updateTray(); };

  function persist() { settingsLib.saveSettings(userData, settings); }

  function isInside(p) {
    if (typeof p !== 'string' || !p || !settings.folder) return false;
    const rel = path.relative(path.resolve(settings.folder), path.resolve(p));
    // only the gallery's own images: IPC must not open/upload arbitrary files from the folder
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && /^img_\d+\.png$/.test(path.basename(p));
  }

  // ---------- watcher ----------
  function startWatching() {
    if (!settings.folder) return { ok: false, error: 'Папка не выбрана' };
    watchError = undefined; // before start(): it reports a failed mkdir synchronously
    watcher.start(settings.folder);
    log('info', `Отслеживание: ${settings.folder}`);
    pushState();
    return { ok: true };
  }

  function stopWatching() {
    if (watcher.running) log('info', 'Пауза');
    watcher.stop();
    watchError = undefined;
    pushState();
    return { ok: true };
  }

  watcher.on('saved', ({ path: file, filename }) => {
    session++;
    watchError = undefined;
    log('ok', `Сохранено ${filename}`);
    if (settings.notifyOnSave && Notification.isSupported()) {
      new Notification({ title: 'Изображение сохранено', body: filename, icon: path.join(ICONS, 'app.png'), silent: true }).show();
    }
    if (settings.google.enabled) enqueueSync(file);
    pushState();
  });
  watcher.on('error', ({ message }) => { watchError = message; log('error', message); pushState(); });

  // Explorer adds/deletes img_N files: refresh the gallery so cards never point at missing files.
  // ponytail: readdir poll (no fs.watch: its handle blocks recreating a deleted folder on Windows)
  setInterval(() => {
    if (!settings?.folder) return;
    let sig = '';
    try { sig = fs.readdirSync(settings.folder).filter((n) => /^img_\d+\.png$/.test(n)).sort().join('|'); } catch { /* missing */ }
    if (sig !== dirSig) pushState();
  }, 1000);

  async function openFolder() {
    if (!settings.folder) return;
    const err = await shell.openPath(path.normalize(settings.folder)); // reports failure as a string, never rejects
    if (err) log('error', `Не удалось открыть папку: ${err}`);
  }

  function setFolder(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Некорректный путь');
    const hadFolder = !!settings.folder;
    settings.folder = p;
    settings.recentFolders = settingsLib.addRecentFolder(settings.recentFolders, p);
    persist();
    if (watcher.running || !hadFolder) startWatching(); else pushState();
  }

  // ---------- google ----------
  async function initGoogle() {
    const gen = ++googleGen;
    google = null;
    googleError = undefined;
    if (!settings.google.enabled) { googleStatus = 'off'; pushState(); return; }
    googleStatus = 'connecting';
    pushState();
    const g = new GoogleSync(settings.google, { tokenPath, openExternal: (url) => shell.openExternal(url) });
    google = g; // images saved during a browser login wait on the same init() in uploadAndUpdate
    try {
      await g.init();
      if (gen !== googleGen) return;
      googleStatus = 'ok';
      log('ok', 'Google подключён');
    } catch (e) {
      if (gen !== googleGen) return;
      // google stays g: uploadAndUpdate retries init (and the login flow) on the next image
      googleStatus = 'error';
      googleError = e.message;
      log('error', `Google: ${e.message}`);
    }
    pushState();
  }

  function enqueueSync(file) {
    syncMap.set(file, { sync: 'pending' });
    syncQueue = syncQueue.then(() => syncOne(file));
  }

  async function syncOne(file) {
    const name = path.basename(file);
    try {
      if (!google) throw new Error('Google Sheets не подключён');
      const { cell } = await google.uploadAndUpdate(file);
      if (syncMap.get(file)?.sync !== 'ok') synced++;
      syncMap.set(file, { sync: 'ok', cell });
      googleStatus = 'ok';
      googleError = undefined;
      log('ok', `${name} → ${cell}`);
    } catch (e) {
      syncMap.set(file, { sync: 'error', syncError: e.message });
      if (!google || /Google|токен|вход/i.test(e.message)) { googleStatus = 'error'; googleError = e.message; }
      log('error', `${name}: ${e.message}`);
    }
    pushState();
  }

  // ---------- window / tray ----------
  function createWindow() {
    win = new BrowserWindow({
      width: 960, height: 680, minWidth: 760, minHeight: 520,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: winBg(),
      icon: path.join(ICONS, 'app.png'),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    win.once('ready-to-show', () => win.show());
    win.on('close', (e) => {
      if (!quitting && settings.minimizeToTray) { e.preventDefault(); win.hide(); }
    });
    win.on('closed', () => { win = null; });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  function winBg() { return nativeTheme.shouldUseDarkColors ? '#151b22' : '#f7f9fb'; } // = --win in styles.css
  nativeTheme.on('updated', () => { if (win && !win.isDestroyed()) win.setBackgroundColor(winBg()); });

  function showWindow() {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function updateTray() {
    if (!tray) return;
    const on = watcher.running;
    tray.setImage(path.join(ICONS, on ? 'tray-on.png' : 'tray-off.png'));
    tray.setToolTip(`Clipboard Image Saver — ${on ? 'отслеживается' : 'пауза'}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть', click: showWindow },
      on ? { label: 'Пауза', click: stopWatching } : { label: 'Старт', click: startWatching, enabled: !!settings.folder },
      { label: 'Открыть папку', click: openFolder, enabled: !!settings.folder },
      { type: 'separator' },
      { label: 'Выход', click: () => app.quit() },
    ]));
  }

  // ---------- settings / legacy ----------
  function loadOrImport() {
    const fresh = !fs.existsSync(path.join(userData, 'settings.json'));
    settings = settingsLib.loadSettings(userData);
    if (!fresh) return;
    for (const dir of [process.cwd(), path.dirname(process.execPath)]) {
      const legacy = path.join(dir, 'google_sync.json');
      if (!fs.existsSync(legacy)) continue;
      settings.google = { ...settings.google, ...settingsLib.importLegacy(legacy, null) };
      try {
        const old = JSON.parse(fs.readFileSync(legacy, 'utf8'));
        const tok = path.resolve(dir, String(old.token_file || 'google_token.json'));
        if (fs.existsSync(tok)) {
          fs.mkdirSync(userData, { recursive: true });
          fs.writeFileSync(tokenPath, JSON.stringify(normalizeToken(JSON.parse(fs.readFileSync(tok, 'utf8'))), null, 2));
        }
      } catch (e) {
        log('error', `Не удалось перенести токен Google: ${e.message}`);
      }
      persist();
      log('info', `Импортированы настройки Google из ${legacy}`);
      break;
    }
  }

  function applyLoginItem() {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin });
  }

  // ---------- IPC ----------
  const handle = (name, fn) => ipcMain.handle(name, (_e, ...args) => fn(...args));
  // failures go to the journal: a card action must never fail silently
  const insideOnly = (fn) => async (p) => {
    try {
      if (!isInside(p)) throw new Error('Путь вне папки сохранения');
      return await fn(p);
    } catch (e) {
      log('error', `${typeof p === 'string' ? path.basename(p) : String(p)}: ${e.message}`);
      throw e;
    }
  };

  function registerIpc() {
    handle('getState', getState);
    handle('start', startWatching);
    handle('stop', stopWatching);
    handle('pickFolder', async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.folder || undefined });
      if (r.canceled || !r.filePaths[0]) return null;
      setFolder(r.filePaths[0]);
      return r.filePaths[0];
    });
    // renderer may only switch to a known folder; new ones come through the system dialog (pickFolder)
    handle('setFolder', async (p) => {
      if (!settings.recentFolders.includes(p)) throw new Error('Папка не из списка недавних');
      setFolder(p);
    });
    handle('openFolder', openFolder);
    handle('openImage', insideOnly(async (p) => {
      const err = await shell.openPath(p); // reports failure as a string, never rejects
      if (err) throw new Error(`Не удалось открыть: ${err}`);
    }));
    handle('showInFolder', insideOnly(async (p) => { shell.showItemInFolder(p); }));
    handle('copyImage', insideOnly(async (p) => {
      const blob = new Blob([fs.readFileSync(p)], { type: 'image/png' });
      await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      // ponytail: a poll already mid-read when we write can still save the copy; rebaseline covers the rest
      await watcher.rebaseline();
      log('info', `Скопировано ${path.basename(p)}`);
    }));
    handle('retrySync', insideOnly(async (p) => {
      if (!settings.google.enabled) throw new Error('Синхронизация с Google выключена');
      if (syncMap.get(p)?.sync === 'pending') return;
      enqueueSync(p);
      pushState();
    }));
    handle('saveSettings', async (partial) => {
      try {
        if (!partial || typeof partial !== 'object') throw new Error('Некорректные настройки');
        const before = JSON.stringify(settings.google);
        for (const k of ['minimizeToTray', 'launchAtLogin', 'notifyOnSave']) {
          if (k in partial) settings[k] = !!partial[k];
        }
        if (partial.google && typeof partial.google === 'object') {
          const g = { ...settings.google };
          for (const k of Object.keys(settingsLib.DEFAULTS.google)) {
            if (!(k in partial.google)) continue;
            g[k] = k === 'enabled' ? !!partial.google[k] : String(partial.google[k] ?? '');
          }
          g.authMode = g.authMode === 'service' ? 'service' : 'oauth';
          g.spreadsheetId = parseSpreadsheetId(g.spreadsheetId); // a pasted sheet URL is stored as its ID
          settings.google = g;
        }
        persist();
        applyLoginItem();
        log('info', 'Настройки сохранены');
        if (JSON.stringify(settings.google) !== before) initGoogle(); // may wait for browser login: don't block Save
        else pushState();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
    handle('pickFile', async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      return r.canceled ? null : r.filePaths[0] || null;
    });
    handle('checkForUpdates', () => updater.check());
    handle('installUpdate', () => {
      if (updateState?.state !== 'downloaded') return; // otherwise quitAndInstall won't quit but quitting would stick
      quitting = true;
      updater.install();
    });
  }

  // ---------- lifecycle ----------
  app.on('second-instance', showWindow);
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
  });
  app.on('before-quit', () => { quitting = true; watcher.stop(); });
  app.on('window-all-closed', () => app.quit()); // with minimizeToTray the window only hides

  app.whenReady().then(() => {
    loadOrImport();
    log('info', `Запуск, версия ${app.getVersion()}`);
    registerIpc();
    applyLoginItem();
    tray = new Tray(nativeImage.createFromPath(path.join(ICONS, 'tray-off.png')));
    tray.on('click', showWindow);
    createWindow();
    if (settings.folder) startWatching(); else updateTray();
    initGoogle();
    updater = initUpdater({ send, log });
  });
}
