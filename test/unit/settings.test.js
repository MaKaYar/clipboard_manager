const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULTS, loadSettings, saveSettings, addRecentFolder, importLegacy } = require('../../src/main/settings');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cis-s-'));

test('missing and corrupt file -> defaults', () => {
  const d = tmp();
  assert.deepStrictEqual(loadSettings(d), DEFAULTS);
  fs.writeFileSync(path.join(d, 'settings.json'), '{not json');
  assert.deepStrictEqual(loadSettings(d), DEFAULTS);
});

test('deep merge keeps nested defaults; DEFAULTS not mutated', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ folder: 'C:\\x', google: { enabled: true } }));
  const s = loadSettings(d);
  assert.strictEqual(s.folder, 'C:\\x');
  assert.strictEqual(s.google.enabled, true);
  assert.strictEqual(s.google.sheetName, 'Sheet1');
  assert.strictEqual(s.minimizeToTray, true);
  s.google.sheetName = 'changed';
  s.recentFolders.push('y');
  assert.strictEqual(DEFAULTS.google.sheetName, 'Sheet1');
  assert.deepStrictEqual(DEFAULTS.recentFolders, []);
});

test('atomic save roundtrip', () => {
  const d = path.join(tmp(), 'sub');
  const s = loadSettings(d);
  s.folder = 'D:\\pics';
  s.recentFolders = ['D:\\pics'];
  saveSettings(d, s);
  saveSettings(d, s); // overwrite existing
  assert.deepStrictEqual(loadSettings(d), s);
  assert.deepStrictEqual(fs.readdirSync(d), ['settings.json']);
});

test('addRecentFolder dedupes, newest first, max', () => {
  assert.deepStrictEqual(addRecentFolder(['a', 'b'], 'b'), ['b', 'a']);
  assert.deepStrictEqual(addRecentFolder(['a', 'b', 'c'], 'd', 3), ['d', 'a', 'b']);
  if (process.platform === 'win32') assert.deepStrictEqual(addRecentFolder(['C:\\Pics', 'b'], 'c:\\pics'), ['c:\\pics', 'b']);
  assert.deepStrictEqual(addRecentFolder(['a'], ''), ['a']);
});

test('importLegacy maps snake_case keys and copies token', () => {
  const d = tmp();
  const legacy = path.join(d, 'google_sync.json');
  fs.writeFileSync(legacy, JSON.stringify({
    enabled: true, auth_mode: 'service', credentials_file: 'creds.json', client_secret_file: 'C:\\abs\\cs.json',
    token_file: 'tok.json', spreadsheet_id: 'SID', sheet_name: 'Лист1', search_term: 'add', drive_folder_id: null,
  }));
  fs.writeFileSync(path.join(d, 'tok.json'), '{"token":"t"}');
  const dest = path.join(d, 'out', 'google-token.json');
  const g = importLegacy(legacy, dest);
  assert.deepStrictEqual(g, {
    enabled: true, authMode: 'service', credentialsFile: path.join(d, 'creds.json'), clientSecretFile: 'C:\\abs\\cs.json',
    spreadsheetId: 'SID', sheetName: 'Лист1', searchTerm: 'add', driveFolderId: '',
  });
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), '{"token":"t"}');
  assert.deepStrictEqual(importLegacy(path.join(d, 'missing.json'), null), {});
  fs.writeFileSync(legacy, 'garbage');
  assert.deepStrictEqual(importLegacy(legacy, null), {});
});
