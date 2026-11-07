const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  folder: '',
  recentFolders: [],
  minimizeToTray: true,
  launchAtLogin: false,
  notifyOnSave: false,
  google: {
    enabled: false, authMode: 'oauth', credentialsFile: '', clientSecretFile: '',
    spreadsheetId: '', sheetName: 'Sheet1', searchTerm: 'add', driveFolderId: '',
  },
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function merge(base, over) {
  const out = structuredClone(base);
  if (!isObj(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(out[k]) && isObj(v) ? merge(out[k], v) : structuredClone(v);
  }
  return out;
}

function loadSettings(dir) {
  try {
    return merge(DEFAULTS, JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')));
  } catch {
    return merge(DEFAULTS, {});
  }
}

function saveSettings(dir, settings) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function addRecentFolder(list, folder, max = 10) {
  if (!folder) return list.slice(0, max);
  const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return [folder, ...list.filter((p) => key(p) !== key(folder))].slice(0, max);
}

// Maps the Python app's google_sync.json to settings.google. Relative paths in it were
// relative to the old app's working dir, i.e. next to the json. Copies the old OAuth
// token to tokenPath (google-sync normalizes its format). Missing/corrupt -> {}.
function importLegacy(legacyJsonPath, tokenPath) {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(legacyJsonPath, 'utf8'));
  } catch {
    return {};
  }
  if (!isObj(d)) return {};
  const base = path.dirname(legacyJsonPath);
  const abs = (p) => (p ? path.resolve(base, String(p)) : '');
  const out = {};
  if ('enabled' in d) out.enabled = Boolean(d.enabled);
  if (d.auth_mode) out.authMode = d.auth_mode === 'service' ? 'service' : 'oauth';
  if ('credentials_file' in d) out.credentialsFile = abs(d.credentials_file);
  if ('client_secret_file' in d) out.clientSecretFile = abs(d.client_secret_file);
  if (d.spreadsheet_id) out.spreadsheetId = String(d.spreadsheet_id);
  if (d.sheet_name) out.sheetName = String(d.sheet_name);
  if (d.search_term) out.searchTerm = String(d.search_term);
  if ('drive_folder_id' in d) out.driveFolderId = d.drive_folder_id ? String(d.drive_folder_id) : '';
  if (tokenPath) {
    try {
      const src = abs(d.token_file || 'google_token.json');
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.copyFileSync(src, tokenPath);
    } catch {
      // no legacy token: OAuth will run fresh
    }
  }
  return out;
}

module.exports = { DEFAULTS, loadSettings, saveSettings, addRecentFolder, importLegacy };
