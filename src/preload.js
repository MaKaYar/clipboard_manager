const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set(['state', 'log', 'update:state']);
const invoke = (name) => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('api', {
  getState: invoke('getState'),
  start: invoke('start'),
  stop: invoke('stop'),
  pickFolder: invoke('pickFolder'),
  setFolder: invoke('setFolder'),
  openFolder: invoke('openFolder'),
  openImage: invoke('openImage'),
  showInFolder: invoke('showInFolder'),
  copyImage: invoke('copyImage'),
  retrySync: invoke('retrySync'),
  saveSettings: invoke('saveSettings'),
  pickFile: invoke('pickFile'),
  checkForUpdates: invoke('checkForUpdates'),
  installUpdate: invoke('installUpdate'),
  on(channel, cb) {
    if (!CHANNELS.has(channel)) throw new Error(`unknown channel ${channel}`);
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
