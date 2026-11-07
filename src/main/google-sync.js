// Google Drive upload + Sheets cell write. No electron import: openExternal is injected.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'];
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED', 'ENETUNREACH']);

function a1(col, row) {
  let s = '';
  for (let x = col + 1; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s + (row + 1);
}

function findCell(values, term) {
  if (!Array.isArray(values) || !term) return null;
  const t = String(term).toLowerCase();
  for (let row = 0; row < values.length; row++) {
    const cells = values[row] || [];
    for (let col = 0; col < cells.length; col++) {
      if (cells[col] != null && String(cells[col]).toLowerCase().includes(t)) return { row, col };
    }
  }
  return null;
}

function parseSpreadsheetId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([\w-]+)/) || s.match(/\/d\/([\w-]+)/);
  return m ? m[1] : s;
}

function normalizeToken(json) {
  const out = {};
  const access = json.access_token || json.token;
  if (access) out.access_token = access;
  out.refresh_token = json.refresh_token;
  if (json.expiry_date) out.expiry_date = json.expiry_date;
  else if (json.expiry) {
    // python google-auth writes UTC, sometimes without a zone suffix
    const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(json.expiry) ? json.expiry : json.expiry + 'Z';
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) out.expiry_date = ms;
  }
  return out;
}

const statusOf = (e) => e.status || e.response?.status || (/^\d{3}$/.test(String(e.code)) ? Number(e.code) : 0);
const isRetryable = (e) => { const s = statusOf(e); return s === 429 || s >= 500 || (!s && NETWORK_CODES.has(e.code)); };
const isInvalidGrant = (e) => e?.response?.data?.error === 'invalid_grant' || /invalid_grant/.test(e?.message || '');
const quoteSheet = (name) => `'${String(name).replace(/'/g, "''")}'`;
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

class GoogleSync {
  constructor(googleSettings, opts = {}) {
    this.settings = googleSettings || {};
    this.tokenPath = opts.tokenPath;
    this.openExternal = opts.openExternal;
    this.retryDelayMs = opts.retryDelayMs ?? 1000;
    this.authTimeoutMs = opts.authTimeoutMs ?? AUTH_TIMEOUT_MS;
    this.clients = opts.clients || null;
  }

  // Concurrent callers share one in-flight init (and one browser login); a failed init can be retried.
  init() {
    if (this.clients) return Promise.resolve();
    this._initP ??= this._init().finally(() => { this._initP = null; });
    return this._initP;
  }

  async _init() {
    const auth = (this.settings.authMode || 'oauth') === 'service' ? this._serviceAuth() : await this._oauth();
    const { drive } = require('@googleapis/drive');
    const { sheets } = require('@googleapis/sheets');
    this.clients = { drive: drive({ version: 'v3', auth }), sheets: sheets({ version: 'v4', auth }) };
  }

  _serviceAuth() {
    const keyFile = this.settings.credentialsFile;
    if (!keyFile || !fs.existsSync(keyFile)) throw new Error(`Не найден ключ сервисного аккаунта: ${keyFile || '(не указан)'}`);
    const { GoogleAuth } = require('google-auth-library');
    return new GoogleAuth({ keyFile, scopes: SCOPES });
  }

  async _oauth() {
    const secretFile = this.settings.clientSecretFile;
    if (!secretFile || !fs.existsSync(secretFile)) throw new Error(`Не найден файл client_secret: ${secretFile || '(не указан)'}`);
    const secret = readJson(secretFile);
    const c = secret.installed || secret.web || secret;
    const { OAuth2Client } = require('google-auth-library');
    const client = new OAuth2Client({
      clientId: c.client_id,
      clientSecret: c.client_secret,
      ...(c.token_uri ? { endpoints: { oauth2TokenUrl: c.token_uri } } : {}),
    });
    client.on('tokens', (t) => this._saveToken(t));

    const stored = this._loadToken();
    if (stored?.refresh_token) {
      client.setCredentials(stored);
      try {
        await client.getAccessToken(); // refreshes only if expired/expiring
        return client;
      } catch (e) {
        if (!isInvalidGrant(e)) throw e;
        // Revoked/expired refresh token: forget it and log in again.
        fs.rmSync(this.tokenPath, { force: true });
      }
    }
    if (!this.openExternal) throw new Error('Требуется вход в Google: токен отсутствует или отозван. Откройте настройки и подключите Google заново.');
    await this._loopback(client);
    return client;
  }

  _loadToken() {
    try { return normalizeToken(readJson(this.tokenPath)); } catch { return null; }
  }

  _saveToken(tokens) {
    if (!this.tokenPath) return;
    const prev = this._loadToken() || {};
    // Google omits refresh_token on refresh responses: keep the stored one.
    const merged = { ...prev, ...normalizeToken(tokens), refresh_token: tokens.refresh_token || prev.refresh_token };
    fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true });
    fs.writeFileSync(this.tokenPath, JSON.stringify(merged, null, 2));
  }

  async _loopback(client) {
    const state = crypto.randomBytes(16).toString('hex');
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const server = http.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const redirectUri = `http://127.0.0.1:${server.address().port}`;
    try {
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Время входа в Google истекло (5 минут). Попробуйте ещё раз.')), this.authTimeoutMs);
        server.on('request', (req, res) => {
          const q = new URL(req.url, redirectUri).searchParams;
          const send = (status, text) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<p>${text}</p>`); };
          if (q.get('state') !== state) return send(400, 'Неверный запрос.');
          clearTimeout(timer);
          if (q.get('error') || !q.get('code')) {
            send(400, 'Вход в Google отменён.');
            return reject(new Error(`Вход в Google отменён: ${q.get('error') || 'нет кода'}`));
          }
          send(200, 'Готово, вкладку можно закрыть.');
          resolve(q.get('code'));
        });
        const url = client.generateAuthUrl({
          access_type: 'offline', prompt: 'consent', scope: SCOPES, redirect_uri: redirectUri,
          state, code_challenge: codeChallenge, code_challenge_method: 'S256',
        });
        Promise.resolve(this.openExternal(url)).catch((e) => { clearTimeout(timer); reject(e); });
      });
      const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri }); // emits 'tokens' -> saved
      client.setCredentials(tokens);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  }

  async _retry(fn) {
    for (let attempt = 1; ; attempt++) {
      try { return await fn(); } catch (e) {
        if (attempt >= 3 || !isRetryable(e)) throw e;
        await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** (attempt - 1)));
      }
    }
  }

  async uploadAndUpdate(imagePath) {
    await this.init();
    try {
      return await this._uploadAndUpdate(imagePath);
    } catch (e) {
      if (!isInvalidGrant(e) || this.settings.authMode === 'service') throw e;
      // Token revoked mid-session: drop it so the next init() runs the login flow.
      if (this.tokenPath) fs.rmSync(this.tokenPath, { force: true });
      this.clients = null;
      throw new Error('Доступ к Google отозван, требуется повторный вход.');
    }
  }

  async _uploadAndUpdate(imagePath) {
    const { drive, sheets } = this.clients;
    const s = this.settings;
    const spreadsheetId = parseSpreadsheetId(s.spreadsheetId);
    const sheet = quoteSheet(s.sheetName || 'Sheet1');

    // Find the cell before uploading so a full sheet leaves no orphan public files on Drive.
    const got = await this._retry(() => sheets.spreadsheets.values.get({ spreadsheetId, range: sheet }));
    const hit = findCell(got.data.values, s.searchTerm);
    if (!hit) throw new Error(`Не найдена ячейка с «${s.searchTerm}» на листе «${s.sheetName}»`);
    const cell = `${sheet}!${a1(hit.col, hit.row)}`;

    const requestBody = { name: path.basename(imagePath) };
    if (s.driveFolderId) requestBody.parents = [s.driveFolderId];
    const created = await this._retry(() => drive.files.create({
      requestBody, media: { mimeType: 'image/png', body: fs.createReadStream(imagePath) }, fields: 'id', supportsAllDrives: true,
    }));
    const fileId = created.data.id;
    try {
      await this._retry(() => drive.permissions.create({
        fileId, requestBody: { role: 'reader', type: 'anyone' }, fields: 'id', supportsAllDrives: true,
      }));
    } catch { /* folder may already be shared or policy forbids it */ }

    const link = `https://drive.google.com/uc?export=view&id=${fileId}`;
    await this._retry(() => sheets.spreadsheets.values.update({
      spreadsheetId, range: cell, valueInputOption: 'USER_ENTERED', requestBody: { values: [[`=IMAGE("${link}")`]] },
    }));
    return { fileId, link, cell };
  }
}

module.exports = { SCOPES, a1, findCell, parseSpreadsheetId, normalizeToken, GoogleSync };
