const { app } = require('electron');

const FOUR_HOURS = 4 * 60 * 60 * 1000;
// electron-updater HTTP errors carry response headers and a stack; keep the first line for the journal
const firstLine = (m) => String((m && m.message) || m).split('\n')[0];

// log: (level, text) => void
function initUpdater({ send, log }) {
  if (!app.isPackaged) {
    return { check: async () => send('update:state', { state: 'none' }), install() {} };
  }
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => log('info', `updater: ${m}`),
    warn: (m) => log('info', `updater: ${m}`),
    error: (m) => log('error', `updater: ${firstLine(m)}`),
    debug() {},
  };
  autoUpdater.on('checking-for-update', () => send('update:state', { state: 'checking' }));
  let ver;
  autoUpdater.on('update-available', (i) => { ver = i.version; send('update:state', { state: 'available', version: ver }); });
  autoUpdater.on('update-not-available', () => send('update:state', { state: 'none' }));
  autoUpdater.on('download-progress', (p) => send('update:state', { state: 'downloading', percent: p.percent, version: ver }));
  autoUpdater.on('update-downloaded', (i) => {
    send('update:state', { state: 'downloaded', version: i.version });
    log('ok', `Скачана версия ${i.version}, установится при выходе`);
  });
  autoUpdater.on('error', (e) => send('update:state', { state: 'error', message: firstLine(e) }));

  // resolve to void: the result holds a Promise that IPC cannot clone; 'error' event already reported failures
  const check = () => autoUpdater.checkForUpdates().then(() => {}, () => {});
  check();
  setInterval(check, FOUR_HOURS).unref();
  return { check, install: () => autoUpdater.quitAndInstall() };
}

module.exports = { initUpdater };
