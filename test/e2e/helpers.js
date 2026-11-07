const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { _electron } = require('playwright');

const REPO = path.join(__dirname, '..', '..');

// Minimal RGB PNG encoder: pixel(x, y) -> [r, g, b].
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 3 + 1) + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const solid = (w, h, rgb) => makePng(w, h, () => rgb);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await wait(150); }
  return !!(await fn());
}

function tempDirs(prefix = 'cis-e2e-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const userData = path.join(root, 'ud');
  const folder = path.join(root, 'shots');
  fs.mkdirSync(userData); fs.mkdirSync(folder);
  return { root, userData, folder };
}

function appEnv(userData) {
  const env = { ...process.env, CIS_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE; // set in some shells; makes electron behave as plain node
  return env;
}

// cwd = temp root so the legacy google_sync.json import never sees the repo's real file
async function launch({ root, userData }) {
  const app = await _electron.launch({ args: [REPO], env: appEnv(userData), cwd: root });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.emulateMedia({ colorScheme: null }); // Playwright pins 'light'; follow nativeTheme like the real app
  return { app, win };
}

const writeClipboard = (app, png) => app.evaluate(async ({ clipboard, ClipboardItem }, b64) => {
  const blob = new Blob([Buffer.from(b64, 'base64')], { type: 'image/png' });
  await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}, png.toString('base64'));

const imgFiles = (folder) => fs.readdirSync(folder).filter((f) => /^img_\d+\.png$/.test(f)).sort();

module.exports = { REPO, makePng, solid, wait, until, tempDirs, appEnv, launch, writeClipboard, imgFiles };
