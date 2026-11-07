const fs = require('fs');
const path = require('path');

const NAME_RE = /^img_(\d+)\.png$/;

function listRecent(folder, limit = 40) {
  if (!folder) return [];
  let names;
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  const out = [];
  const picked = names
    .map((filename) => ({ filename, m: NAME_RE.exec(filename) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1]));
  for (const { filename } of picked) {
    if (out.length >= limit) break;
    const file = path.join(folder, filename);
    try {
      out.push({ path: file, filename, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // deleted between readdir and stat
    }
  }
  return out;
}

module.exports = { listRecent };
