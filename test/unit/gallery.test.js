const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listRecent } = require('../../src/main/gallery');

test('listRecent orders by n desc, filters, limits', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-g-'));
  for (const n of ['img_1.png', 'img_10.png', 'img_2.png', 'x.png', 'img_a.png', 'IMG_3.PNG']) fs.writeFileSync(path.join(d, n), 'x');
  const all = listRecent(d);
  assert.deepStrictEqual(all.map((x) => x.filename), ['img_10.png', 'img_2.png', 'img_1.png']);
  assert.strictEqual(all[0].path, path.join(d, 'img_10.png'));
  assert.strictEqual(typeof all[0].mtimeMs, 'number');
  assert.deepStrictEqual(listRecent(d, 2).map((x) => x.filename), ['img_10.png', 'img_2.png']);
});

test('listRecent missing folder -> []', () => {
  assert.deepStrictEqual(listRecent(path.join(os.tmpdir(), 'cis-nope-' + Date.now())), []);
  assert.deepStrictEqual(listRecent(''), []);
});
