'use strict';
(() => {
  const api = window.api;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  let state = null;
  let topPath;            // undefined until first render, so the initial gallery is not highlighted
  let newTimer = null;
  let newPath = null;
  const logs = [];
  const cards = new Map(); // path -> card element (reused so thumbnails do not reload)

  // ---------- helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const hhmmss = (ms) => hhmm(ms) + ':' + pad(new Date(ms).getSeconds());
  // encodeURI leaves # and ? alone; both are legal in Windows file names
  const fileUrl = (p) => encodeURI('file:///' + p.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  // ---------- header / folder / stats ----------
  function renderHeader(s) {
    const pill = $('statusPill');
    const bad = s.running && s.watchError;
    pill.className = 'pill' + (bad ? ' bad' : s.running ? ' ok' : '');
    pill.title = bad ? s.watchError : '';
    $('statusText').textContent = bad ? 'Ошибка сохранения' : s.running ? 'Отслеживается' : (s.folder ? 'Пауза' : 'Папка не выбрана');
    const run = $('toggleRun');
    run.textContent = s.running ? 'Пауза' : 'Старт';
    run.disabled = !s.running && !s.folder;

    const g = $('googlePill');
    const st = s.settings.google.enabled ? s.googleStatus : 'off';
    g.className = 'pill sync' + (st === 'ok' ? ' on' : st === 'error' ? ' bad' : '');
    g.textContent = 'Google Sheets · ' + ({ off: 'выключено', connecting: 'подключение…', ok: 'подключено', error: 'ошибка' }[st] || st);
    g.title = st === 'error' && s.googleError ? s.googleError : '';

    const fp = $('folderPath');
    fp.textContent = s.folder || 'не выбрана';
    fp.title = s.folder || '';
    fp.classList.toggle('none', !s.folder);
    $('openFolder').disabled = !s.folder;

    const stats = $('stats');
    stats.replaceChildren();
    const stat = (n, label) => { const sp = el('span'); sp.append(el('b', null, String(n)), label); stats.append(sp); };
    stat(s.stats.session, 'за сессию');
    stat(s.stats.inFolder, 'в папке');
    if (s.settings.google.enabled) stat(s.stats.synced, 'в Sheets');
    if (s.gallery.length) stats.append(el('span', null, 'последнее: ' + hhmmss(s.gallery[0].mtimeMs)));
    stats.hidden = !s.folder;
  }

  // ---------- gallery ----------
  const BADGE = { pending: ['b-wait', 'отправка'], ok: ['b-ok', 'в Sheets'], error: ['b-bad', 'ошибка'] };

  function makeCard(item) {
    const card = el('button', 'shot');
    card.type = 'button';
    const img = el('img', 'thumb');
    img.loading = 'lazy';
    img.alt = '';
    img.src = fileUrl(item.path);
    const meta = el('span', 'meta');
    meta.append(el('span', 'name'), el('span', 'badge'), el('span', 't'));
    card.append(img, meta);
    // detail > 1: the 2nd click of a double-click (Explorer habit) must not open a second viewer.
    // Failures are logged to the journal by main; catch only silences the rejected promise.
    card.addEventListener('click', (e) => { if (e.detail <= 1) api.openImage(item.path).catch(() => {}); });
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); openCtx(item.path, e.clientX, e.clientY); });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const r = card.getBoundingClientRect();
        openCtx(item.path, r.left + 12, r.top + 24);
      }
    });
    return card;
  }

  function renderGallery(s) {
    const items = s.gallery.slice(0, 40);
    if (topPath !== undefined && items[0] && items[0].path !== topPath) flashNew(items[0].path);
    topPath = items[0] ? items[0].path : null;

    const gallery = $('gallery');
    const keep = new Set();
    const nodes = items.map((it) => {
      keep.add(it.path);
      let card = cards.get(it.path);
      if (!card) { card = makeCard(it); cards.set(it.path, card); }
      const [name, badge, t] = card.querySelector('.meta').children;
      name.textContent = it.filename.replace(/\.png$/i, '');
      const b = s.settings.google.enabled && BADGE[it.sync];
      badge.hidden = !b;
      if (b) { badge.className = 'badge ' + b[0]; badge.textContent = b[1]; }
      badge.title = it.sync === 'error' ? (it.syncError || '') : (it.cell || '');
      t.textContent = hhmm(it.mtimeMs);
      card.title = it.filename;
      card.classList.toggle('new', it.path === newPath);
      return card;
    });
    for (const p of cards.keys()) if (!keep.has(p)) cards.delete(p);
    const focused = gallery.contains(document.activeElement) ? document.activeElement : null;
    gallery.replaceChildren(...nodes);
    if (focused && focused.isConnected) focused.focus({ preventScroll: true }); // re-insert drops focus

    gallery.hidden = !s.folder || !items.length;
    $('emptyNoFolder').hidden = !!s.folder;
    $('emptyFolder').hidden = !s.folder || items.length > 0;
  }

  function flashNew(path) {
    newPath = path;
    clearTimeout(newTimer);
    newTimer = setTimeout(() => {
      newPath = null;
      const c = cards.get(path);
      if (c) c.classList.remove('new');
    }, 4000);
  }

  // ---------- menus ----------
  let ctxPath = null;
  let menuReturn = null;

  function closeMenus() {
    const wasOpen = !$('ctxMenu').hidden || !$('recentMenu').hidden;
    $('ctxMenu').hidden = true;
    $('recentMenu').hidden = true;
    $('recentBtn').setAttribute('aria-expanded', 'false');
    if (wasOpen && menuReturn && document.contains(menuReturn)) menuReturn.focus();
    menuReturn = null;
    return wasOpen;
  }

  function openCtx(path, x, y) {
    closeMenus();
    ctxPath = path;
    menuReturn = document.activeElement;
    const m = $('ctxMenu');
    const item = state && state.gallery.find((g) => g.path === path);
    m.querySelector('[data-act="retry"]').disabled = !(state && state.settings.google.enabled) || (item && item.sync === 'pending');
    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
    m.querySelector('button:not(:disabled)').focus();
  }

  $('ctxMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    const p = ctxPath;
    closeMenus();
    ({ open: api.openImage, show: api.showInFolder, copy: api.copyImage, retry: api.retrySync }[b.dataset.act])(p)
      .catch(() => {}); // main logs the failure to the journal
  });

  function openRecent() {
    closeMenus();
    menuReturn = $('recentBtn');
    const m = $('recentMenu');
    m.replaceChildren();
    const list = (state && state.settings.recentFolders) || [];
    if (!list.length) m.append(el('div', 'none', 'Пока пусто'));
    for (const f of list) {
      const b = el('button', 'mono', f);
      b.setAttribute('role', 'menuitem');
      b.title = f;
      b.addEventListener('click', () => { closeMenus(); api.setFolder(f); });
      m.append(b);
    }
    m.hidden = false;
    $('recentBtn').setAttribute('aria-expanded', 'true');
    const first = m.querySelector('button');
    if (first) first.focus();
  }

  $('recentBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if ($('recentMenu').hidden) openRecent(); else closeMenus();
  });

  // arrow keys inside menus
  for (const m of [$('ctxMenu'), $('recentMenu')]) {
    m.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const items = [...m.querySelectorAll('button:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      if (next) next.focus();
    });
    // Tab out of a menu closes it (without pulling focus back); null = window blur, handled below
    m.addEventListener('focusout', (e) => {
      if (e.relatedTarget && !m.contains(e.relatedTarget) && e.relatedTarget !== $('recentBtn')) { menuReturn = null; closeMenus(); }
    });
  }

  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.menu, #recentBtn')) closeMenus(); });
  window.addEventListener('blur', () => closeMenus());
  window.addEventListener('resize', () => closeMenus());
  // the context menu is position:fixed: after a scroll it would sit over a different card
  document.querySelector('.content').addEventListener('scroll', () => closeMenus());

  // ---------- journal ----------
  const logEl = $('log');
  logEl.open = store.get('journalOpen') === '1';
  logEl.addEventListener('toggle', () => store.set('journalOpen', logEl.open ? '1' : '0'));

  function addLog(entry) {
    logs.push(entry);
    if (logs.length > 200) logs.splice(0, logs.length - 200);
    renderLog();
  }

  function renderLog() {
    const body = $('logBody');
    const atTop = body.scrollTop === 0; // newest is on top
    body.replaceChildren(...logs.slice().reverse().map((l) => {
      const line = el('div');
      line.append(hhmmss(l.ts || Date.now()) + '  ');
      line.append(l.level === 'info' ? l.text : el('span', l.level, l.text));
      return line;
    }));
    if (atTop) body.scrollTop = 0;
    const n = logs.length;
    $('logSummary').textContent = 'Журнал · ' + n + ' ' + plural(n, 'событие', 'события', 'событий');
  }

  // ---------- update ----------
  function renderUpdate(u) {
    const bar = $('update');
    const info = $('updateInfo');
    info.textContent = '';
    bar.hidden = true;
    $('updateInstall').hidden = true;
    if (!u) return;
    const text = $('updateText');
    text.replaceChildren();
    if (u.state === 'downloaded') {
      text.append('Скачана версия ', el('b', null, u.version || ''), '. Установится при выходе.');
      $('updateInstall').hidden = false;
      bar.hidden = false;
    } else if (u.state === 'downloading' || u.state === 'available') {
      text.append('Скачивается версия ', el('b', null, u.version || ''),
        u.percent != null ? ' · ' + Math.round(u.percent) + '%' : '…');
      bar.hidden = false;
    }
    info.textContent = {
      checking: 'Проверка обновлений…',
      none: 'Установлена последняя версия',
      error: 'Ошибка обновления: ' + (u.message || ''),
      available: 'Найдено обновление',
      downloading: 'Загрузка обновления…',
      downloaded: 'Обновление скачано, установится при выходе',
    }[u.state] || '';
  }
  $('updateInstall').addEventListener('click', () => api.installUpdate());
  $('checkUpdates').addEventListener('click', () => { renderUpdate({ state: 'checking' }); api.checkForUpdates().catch(() => {}); });

  // ---------- main actions ----------
  async function act(promise) {
    const r = await promise;
    if (r && r.ok === false && r.error) addLog({ ts: Date.now(), level: 'error', text: r.error });
    return r;
  }
  let toggling = false; // clicks before the new state arrives would repeat the same action
  $('toggleRun').addEventListener('click', async () => {
    if (toggling) return;
    toggling = true;
    try { await act(state && state.running ? api.stop() : api.start()); } finally { toggling = false; }
  });
  $('changeFolder').addEventListener('click', () => api.pickFolder());
  $('pickFolderEmpty').addEventListener('click', () => api.pickFolder());
  $('openFolder').addEventListener('click', () => api.openFolder());

  // ---------- settings drawer ----------
  const drawer = $('drawer');
  const form = $('settingsForm');
  let draftFiles = { credentialsFile: '', clientSecretFile: '' };

  const authMode = () => (form.querySelector('input[name="authMode"]:checked') || {}).value || 'oauth';
  function syncAuthUi() {
    const svc = authMode() === 'service';
    $('fileLbl').textContent = svc ? 'Ключ сервисного аккаунта (JSON)' : 'client_secret.json';
    const f = svc ? draftFiles.credentialsFile : draftFiles.clientSecretFile;
    $('fileInput').value = f;
    $('fileInput').title = f;
  }
  const syncEnabledUi = () => { $('gFields').disabled = !$('gEnabled').checked; };

  function fillForm(s) {
    const g = s.settings.google;
    form.launchAtLogin.checked = !!s.settings.launchAtLogin;
    form.minimizeToTray.checked = !!s.settings.minimizeToTray;
    form.notifyOnSave.checked = !!s.settings.notifyOnSave;
    $('gEnabled').checked = !!g.enabled;
    for (const r of form.querySelectorAll('input[name="authMode"]')) r.checked = r.value === (g.authMode || 'oauth');
    draftFiles = { credentialsFile: g.credentialsFile || '', clientSecretFile: g.clientSecretFile || '' };
    $('fSheetId').value = g.spreadsheetId || '';
    $('fSheet').value = g.sheetName || '';
    $('fTerm').value = g.searchTerm || '';
    $('fDrive').value = g.driveFolderId || '';
    $('version').textContent = s.version || '';
    $('saveResult').textContent = '';
    $('saveResult').className = 'result small';
    syncAuthUi();
    syncEnabledUi();
  }

  function openDrawer() {
    if (!state) return;
    closeMenus();
    fillForm(state);
    renderUpdate(state.update);
    drawer.hidden = false;
    $('backdrop').hidden = false;
    $('closeSettings').focus();
  }
  function closeDrawer() {
    if (drawer.hidden) return false;
    drawer.hidden = true;
    $('backdrop').hidden = true;
    $('openSettings').focus();
    return true;
  }
  $('openSettings').addEventListener('click', openDrawer);
  $('closeSettings').addEventListener('click', closeDrawer);
  $('backdrop').addEventListener('click', closeDrawer);
  $('gEnabled').addEventListener('change', syncEnabledUi);
  for (const r of form.querySelectorAll('input[name="authMode"]')) r.addEventListener('change', syncAuthUi);

  $('pickFile').addEventListener('click', async () => {
    const f = await api.pickFile();
    if (!f) return;
    draftFiles[authMode() === 'service' ? 'credentialsFile' : 'clientSecretFile'] = f;
    syncAuthUi();
  });

  // keep focus inside the drawer while it is open
  drawer.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...drawer.querySelectorAll('button, input')].filter((n) => !n.disabled && n.offsetParent);
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = $('saveResult');
    const btn = $('saveBtn');
    btn.disabled = true;
    res.className = 'result small';
    res.textContent = 'Сохранение…';
    const partial = {
      launchAtLogin: form.launchAtLogin.checked,
      minimizeToTray: form.minimizeToTray.checked,
      notifyOnSave: form.notifyOnSave.checked,
      google: Object.assign({}, state.settings.google, {
        enabled: $('gEnabled').checked,
        authMode: authMode(),
        credentialsFile: draftFiles.credentialsFile,
        clientSecretFile: draftFiles.clientSecretFile,
        spreadsheetId: $('fSheetId').value.trim(),
        sheetName: $('fSheet').value.trim(),
        searchTerm: $('fTerm').value.trim(),
        driveFolderId: $('fDrive').value.trim(),
      }),
    };
    let r;
    try { r = await api.saveSettings(partial); } catch (err) { r = { ok: false, error: err.message }; }
    btn.disabled = false;
    if (r && r.ok) { res.className = 'result small ok'; res.textContent = 'Сохранено'; }
    else { res.className = 'result small error'; res.textContent = (r && r.error) || 'Не удалось сохранить'; }
  });

  // ---------- global keys ----------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (closeMenus() || closeDrawer())) e.preventDefault();
  });

  // ---------- state ----------
  function render(s) {
    state = s;
    renderHeader(s);
    renderGallery(s);
    if (s.update !== undefined) renderUpdate(s.update);
    if (!drawer.hidden) $('version').textContent = s.version || '';
  }

  api.on('state', render);
  api.on('log', addLog);
  api.on('update:state', (u) => { if (state) state.update = u; renderUpdate(u); });
  api.getState().then((s) => {
    if (s.logs) { logs.splice(0, logs.length, ...s.logs); renderLog(); } // replay what main logged before we subscribed
    render(s);
  });
  renderLog();
})();
