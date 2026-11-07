const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');

const NAME_RE = /^img_(\d+)\.png$/;

function nextFilename(names) {
  let max = 0;
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `img_${max + 1}.png`;
}

// Electron 45 removed the sync clipboard.readImage(); only the async W3C-style
// clipboard.read() -> ClipboardItem[] is left. On Windows a bitmap (CF_DIB) shows up
// as 'image/png' with byte-stable encoding, so the PNG bytes serve as the image identity.
async function readPng(clipboard) {
  const items = await clipboard.read();
  const item = items.find((i) => i.types.includes('image/png'));
  if (!item) return null;
  const buf = Buffer.from(await (await item.getType('image/png')).arrayBuffer());
  return buf.length ? buf : null;
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

class ClipboardWatcher extends EventEmitter {
  constructor({ clipboard, intervalMs = 1000, fs = require('fs') }) {
    super();
    this._clipboard = clipboard;
    this._intervalMs = intervalMs;
    this._fs = fs;
    this._timer = null;
    this._folder = null;
    this._lastHash = null;
    this._lastError = null;
    this._baseline = Promise.resolve();
    this._busy = false;
    this._gen = 0; // bumps on start/stop so an in-flight poll from an old run never saves
  }

  get running() { return this._timer !== null; }
  get folder() { return this._folder; }

  // Returns a promise that resolves once the baseline is taken (callers may ignore it).
  start(folder) {
    if (this.running && this._folder === folder) return this._baseline;
    this.stop();
    const gen = this._gen;
    this._folder = folder;
    this._lastError = null;
    this._lastHash = null;
    try {
      this._fs.mkdirSync(folder, { recursive: true });
    } catch (err) {
      this._reportError(err);
    }
    this._baseline = readPng(this._clipboard)
      .then((png) => { if (gen === this._gen && png) this._lastHash = sha1(png); })
      .catch((err) => this._reportError(err));
    this._timer = setInterval(() => this.pollOnce(), this._intervalMs);
    return this._baseline;
  }

  // Treat whatever is in the clipboard now as already seen (e.g. after the app copied an image itself).
  rebaseline() {
    if (!this.running) return Promise.resolve();
    const gen = this._gen;
    this._baseline = this._baseline
      .then(() => readPng(this._clipboard))
      .then((png) => { if (gen === this._gen && png) this._lastHash = sha1(png); })
      .catch((err) => this._reportError(err));
    return this._baseline;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._gen++;
  }

  // Resolves to {path, filename} when a new image was saved, else null. Never rejects.
  async pollOnce() {
    if (!this.running || this._busy) return null;
    this._busy = true;
    const gen = this._gen;
    try {
      await this._baseline;
      const png = await readPng(this._clipboard);
      if (gen !== this._gen) return null;
      // Empty clipboard keeps the last hash, so the same image coming back is not re-saved.
      const hash = png && sha1(png);
      if (!hash || hash === this._lastHash) {
        this._lastError = null;
        return null;
      }
      const fs = this._fs;
      fs.mkdirSync(this._folder, { recursive: true }); // recreate if deleted while running
      const filename = nextFilename(fs.readdirSync(this._folder));
      const file = path.join(this._folder, filename);
      try {
        fs.writeFileSync(file, png, { flag: 'wx' }); // never overwrite; on failure the next poll retries
      } catch (e) {
        if (e.code !== 'EEXIST') fs.rmSync(file, { force: true }); // don't leave a half-written img_N behind
        throw e;
      }
      this._lastHash = hash;
      this._lastError = null;
      const result = { path: file, filename };
      this.emit('saved', { ...result, savedAt: Date.now() });
      return result;
    } catch (err) {
      this._reportError(err);
      return null;
    } finally {
      this._busy = false;
    }
  }

  // Emit once per distinct message so a dead folder does not spam the log every second.
  _reportError(err) {
    const message = (err && err.message) || String(err);
    if (message === this._lastError) return;
    this._lastError = message;
    if (this.listenerCount('error') > 0) this.emit('error', { message });
  }
}

module.exports = { nextFilename, ClipboardWatcher };
