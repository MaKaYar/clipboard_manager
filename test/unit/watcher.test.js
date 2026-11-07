const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nextFilename, ClipboardWatcher } = require('../../src/main/watcher');

// Mimics Electron 45 clipboard.read(): [ClipboardItem{types, getType()}]; '' = no image.
function fakeClipboard(tag) {
  const cb = {
    current: tag,
    reads: 0,
    set(t) { cb.current = t; },
    async read() {
      cb.reads++;
      if (cb.current instanceof Error) throw cb.current;
      if (!cb.current) return [{ types: ['text/plain'], getType: async () => new Blob(['txt']) }];
      const buf = Buffer.from(cb.current);
      return [{ types: ['image/png', 'x/other'], getType: async (t) => (t === 'image/png' ? new Blob([buf]) : Promise.reject(new Error('no'))) }];
    },
  };
  return cb;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cis-w-'));
const make = (cb, extra) => new ClipboardWatcher({ clipboard: cb, intervalMs: 60000, ...extra });

test('nextFilename', () => {
  assert.strictEqual(nextFilename(['img_2.png', 'img_10.png', 'x.png']), 'img_11.png');
  assert.strictEqual(nextFilename([]), 'img_1.png');
  assert.strictEqual(nextFilename(['img_007.png']), 'img_8.png');
  assert.strictEqual(nextFilename(['img_a.png', 'IMG_3.PNG']), 'img_1.png');
});

test('baseline image not saved; new image saved once; empty ignored; folder created', async () => {
  const folder = path.join(tmp(), 'nested', 'out');
  const cb = fakeClipboard('baseline');
  const w = make(cb);
  const saved = [];
  w.on('saved', (e) => saved.push(e));
  w.start(folder); // not awaited: first poll must still wait for the baseline
  try {
    assert.ok(fs.existsSync(folder));
    assert.strictEqual(w.running, true);
    assert.strictEqual(w.folder, folder);
    assert.strictEqual(await w.pollOnce(), null);
    cb.set('new');
    const r = await w.pollOnce();
    assert.strictEqual(r.filename, 'img_1.png');
    assert.strictEqual(r.path, path.join(folder, 'img_1.png'));
    assert.strictEqual(fs.readFileSync(r.path, 'utf8'), 'new');
    assert.strictEqual(await w.pollOnce(), null);
    cb.set('');
    assert.strictEqual(await w.pollOnce(), null);
    cb.set('new'); // same image back after a non-image clipboard -> not saved again
    assert.strictEqual(await w.pollOnce(), null);
    cb.set('third');
    assert.strictEqual((await w.pollOnce()).filename, 'img_2.png');
    assert.strictEqual(saved.length, 2);
    assert.strictEqual(typeof saved[0].savedAt, 'number');
    assert.deepStrictEqual(fs.readdirSync(folder).sort(), ['img_1.png', 'img_2.png']);
  } finally { w.stop(); }
  assert.strictEqual(w.running, false);
});

test('empty clipboard at start: first image is saved', async () => {
  const folder = tmp();
  const cb = fakeClipboard('');
  const w = make(cb);
  await w.start(folder);
  cb.set('a');
  assert.strictEqual((await w.pollOnce()).filename, 'img_1.png');
  w.stop();
});

test('start is idempotent; nothing saved after stop; overlapping polls do not double-save', async () => {
  const folder = tmp();
  const cb = fakeClipboard('a');
  const w = make(cb);
  await w.start(folder);
  cb.set('b');
  await w.start(folder); // must not re-baseline to 'b'
  const [p1, p2] = await Promise.all([w.pollOnce(), w.pollOnce()]);
  assert.strictEqual(p1.filename, 'img_1.png');
  assert.strictEqual(p2, null);
  w.stop();
  cb.set('c');
  assert.strictEqual(await w.pollOnce(), null);
  assert.deepStrictEqual(fs.readdirSync(folder), ['img_1.png']);
});

test('deleted folder is recreated', async () => {
  const folder = path.join(tmp(), 'gone');
  const cb = fakeClipboard('a');
  const w = make(cb);
  await w.start(folder);
  fs.rmSync(folder, { recursive: true });
  cb.set('b');
  assert.strictEqual((await w.pollOnce()).filename, 'img_1.png');
  w.stop();
});

test('errors emitted once per distinct message, reset after success, never rejects', async () => {
  const folder = tmp();
  const cb = fakeClipboard('a');
  let fail = 'disk gone';
  const fakeFs = { ...fs, writeFileSync: (...a) => { if (fail) throw new Error(fail); return fs.writeFileSync(...a); } };
  const w = make(cb, { fs: fakeFs });
  const errors = [];
  w.on('error', (e) => errors.push(e.message));
  await w.start(folder);
  cb.set('b');
  assert.strictEqual(await w.pollOnce(), null);
  assert.strictEqual(await w.pollOnce(), null);
  fail = 'other';
  await w.pollOnce();
  assert.deepStrictEqual(errors, ['disk gone', 'other']);
  fail = null;
  assert.strictEqual((await w.pollOnce()).filename, 'img_1.png'); // same image retried after failure
  fail = 'disk gone';
  cb.set('c');
  await w.pollOnce();
  assert.deepStrictEqual(errors, ['disk gone', 'other', 'disk gone']);
  cb.set(new Error('clipboard busy'));
  await w.pollOnce();
  await w.pollOnce();
  assert.deepStrictEqual(errors.slice(3), ['clipboard busy']);
  assert.strictEqual(w.running, true);
  w.stop();
});

test('start on uncreatable folder emits error, does not throw', async () => {
  const file = path.join(tmp(), 'afile');
  fs.writeFileSync(file, 'x');
  const w = make(fakeClipboard('a'));
  const errors = [];
  w.on('error', (e) => errors.push(e.message));
  await w.start(path.join(file, 'sub'));
  assert.strictEqual(errors.length, 1);
  w.stop();
});

test('error without listener does not crash', async () => {
  const w = make(fakeClipboard(new Error('boom')));
  await w.start(tmp());
  assert.strictEqual(await w.pollOnce(), null);
  w.stop();
});

test('timer polls automatically', async () => {
  const folder = tmp();
  const cb = fakeClipboard('a');
  const w = new ClipboardWatcher({ clipboard: cb, intervalMs: 10 });
  const got = new Promise((res) => w.once('saved', res));
  await w.start(folder);
  cb.set('b');
  const e = await got;
  w.stop();
  assert.strictEqual(e.filename, 'img_1.png');
});

test('failed write removes the half-written file, so retries keep the same name', async () => {
  const folder = tmp();
  const cb = fakeClipboard('a');
  let fail = true;
  const fakeFs = { ...fs, writeFileSync: (f, d, o) => { fs.writeFileSync(f, '', o); if (fail) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); fs.writeFileSync(f, d); } };
  const w = make(cb, { fs: fakeFs });
  w.on('error', () => {});
  await w.start(folder);
  cb.set('b');
  await w.pollOnce();
  await w.pollOnce();
  assert.deepStrictEqual(fs.readdirSync(folder), []);
  fail = false;
  assert.strictEqual((await w.pollOnce()).filename, 'img_1.png');
  w.stop();
});
