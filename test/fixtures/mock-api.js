// UI preview stub for window.api. Inject with Playwright page.addInitScript after setting
// window.__MOCK__ = { scenario: 'full'|'nofolder'|'empty', folder, images: [absolute png paths] }.
// window.__mock.emit(channel, payload) pushes events; window.__mock.calls records api calls.
(() => {
  const cfg = window.__MOCK__ || {};
  const listeners = {};
  const calls = [];
  let seeded = false;
  const now = Date.now();
  const folder = cfg.scenario === 'nofolder' ? '' : (cfg.folder || 'C:\\Users\\makar\\Pictures\\Скриншоты');
  const images = cfg.scenario === 'full' ? (cfg.images || []) : [];
  const syncs = ['pending', 'ok', 'ok', 'error'];
  const gallery = images.map((p, i) => ({
    path: p,
    filename: p.split('\\').pop(),
    mtimeMs: now - i * 7 * 60000,
    sync: syncs[i % 4],
    cell: "'Исследованные объекты'!C" + (14 - i),
    syncError: syncs[i % 4] === 'error' ? 'Не найдена ячейка с «add» на листе «Исследованные объекты»' : undefined,
  }));
  const state = {
    settings: {
      folder, recentFolders: folder ? [folder, 'C:\\Users\\makar\\OneDrive\\Pictures\\Book of hours (auto)', 'D:\\Temp'] : [],
      minimizeToTray: true, launchAtLogin: false, notifyOnSave: false,
      google: { enabled: cfg.scenario === 'full', authMode: 'oauth', credentialsFile: '',
        clientSecretFile: 'C:\\Users\\makar\\Downloads\\client_secret_example.json',
        spreadsheetId: '1tJbyC7MlMofKfED5Xb54DOJJbmtGcf9Wmz9SphIAaLA', sheetName: 'Исследованные объекты',
        searchTerm: 'add', driveFolderId: '' },
    },
    running: !!folder,
    folder,
    stats: { session: 12, inFolder: 347, synced: 11 },
    gallery,
    version: '1.0.13',
    googleStatus: cfg.scenario === 'full' ? 'ok' : 'off',
    update: cfg.scenario === 'full' ? { state: 'downloaded', version: '1.0.14' } : { state: 'none' },
  };
  const clone = () => JSON.parse(JSON.stringify(state));
  const emit = (ch, payload) => (listeners[ch] || []).forEach((cb) => cb(payload));
  const rec = (name, ret) => (...args) => { calls.push([name, ...args]); return Promise.resolve(typeof ret === 'function' ? ret(...args) : ret); };

  window.api = {
    // renderer subscribes to 'log' right before getState(), so seed the journal after that
    getState: rec('getState', () => { if (cfg.scenario === 'full' && !seeded) { seeded = true; setTimeout(seedLogs); } return clone(); }),
    start: rec('start', () => { state.running = true; setTimeout(() => emit('state', clone())); return { ok: true }; }),
    stop: rec('stop', () => { state.running = false; setTimeout(() => emit('state', clone())); return { ok: true }; }),
    pickFolder: rec('pickFolder', null),
    setFolder: rec('setFolder'),
    openFolder: rec('openFolder'), openImage: rec('openImage'), showInFolder: rec('showInFolder'),
    copyImage: rec('copyImage'), retrySync: rec('retrySync'),
    saveSettings: rec('saveSettings', { ok: true }),
    pickFile: rec('pickFile', 'C:\\Users\\makar\\Downloads\\service-account.json'),
    checkForUpdates: rec('checkForUpdates'), installUpdate: rec('installUpdate'),
    on(ch, cb) { (listeners[ch] = listeners[ch] || []).push(cb); return () => { listeners[ch] = listeners[ch].filter((f) => f !== cb); }; },
  };
  window.__mock = { emit, calls, state, clone };

  function seedLogs() {
    emit('log', { ts: now - 3600000, level: 'info', text: 'Старт отслеживания' });
    emit('log', { ts: now - 1200000, level: 'error', text: 'Ошибка Sheets img_344: не найдена ячейка с «add». Повторить можно из меню картинки.' });
    emit('log', { ts: now - 300000, level: 'ok', text: 'Sheets  img_346 → «Исследованные объекты»!C14' });
    emit('log', { ts: now, level: 'ok', text: 'Сохранено  img_347.png' });
  }
})();
