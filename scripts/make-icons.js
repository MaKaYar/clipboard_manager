// Regenerates build/icon.ico and build/icons/*.png.
// Run: npx electron scripts/make-icons.js
// Draws on a canvas in a hidden Electron window, so no image deps are needed.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ACCENT = '#1f6f8b';
const GREY = '#8a96a3';
const BUILD = path.join(__dirname, '..', 'build');

// Runs inside the page: draws the glyph on a 256-unit grid scaled to `size`.
function draw(size, bg) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.scale(size / 256, size / 256);
  const rr = (x, y, w, h, r, fill) => { g.fillStyle = fill; g.beginPath(); g.roundRect(x, y, w, h, r); g.fill(); };
  rr(0, 0, 256, 256, 56, bg);               // background tile
  rr(52, 44, 152, 188, 20, '#fff');         // board
  rr(82, 20, 92, 56, 18, bg);               // clip outline
  rr(96, 32, 64, 32, 10, '#fff');           // clip
  rr(78, 100, 100, 104, 12, bg);            // photo
  g.fillStyle = '#fff';
  g.beginPath();                            // mountains
  g.moveTo(88, 192); g.lineTo(120, 146); g.lineTo(142, 174); g.lineTo(156, 158); g.lineTo(170, 192);
  g.closePath(); g.fill();
  g.beginPath(); g.arc(152, 126, 11, 0, Math.PI * 2); g.fill();  // sun
  return c.toDataURL('image/png');
}

async function render(win, size, bg) {
  const url = await win.webContents.executeJavaScript(`(${draw})(${size}, ${JSON.stringify(bg)})`);
  return Buffer.from(url.split(',')[1], 'base64');
}

// ICO with PNG-encoded entries (supported since Windows Vista).
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head[e] = head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4);   // planes
    head.writeUInt16LE(32, e + 6);  // bpp
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map(p => p.data)]);
}

function icoSizes(buf) {
  assert.strictEqual(buf.readUInt16LE(0), 0);
  assert.strictEqual(buf.readUInt16LE(2), 1);
  const sizes = [];
  for (let i = 0; i < buf.readUInt16LE(4); i++) {
    const e = 6 + 16 * i;
    const off = buf.readUInt32LE(e + 12);
    assert.ok(buf.subarray(off, off + 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'entry is PNG');
    assert.strictEqual(off + buf.readUInt32LE(e + 8) <= buf.length, true);
    sizes.push(buf[e] || 256);
  }
  return sizes;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const out = (name, data) => {
    const p = path.join(BUILD, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    console.log('wrote', p, data.length, 'bytes');
  };

  const pngs = [];
  for (const size of [16, 32, 48, 256]) pngs.push({ size, data: await render(win, size, ACCENT) });
  out('icon.ico', ico(pngs));
  out('icons/app.png', pngs[3].data);
  out('icons/tray-on.png', await render(win, 16, ACCENT));
  out('icons/tray-on@2x.png', await render(win, 32, ACCENT));
  out('icons/tray-off.png', await render(win, 16, GREY));
  out('icons/tray-off@2x.png', await render(win, 32, GREY));

  assert.deepStrictEqual(icoSizes(fs.readFileSync(path.join(BUILD, 'icon.ico'))), [16, 32, 48, 256]);
  console.log('icon.ico ok: 16, 32, 48, 256');
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
