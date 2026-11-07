const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { a1, findCell, parseSpreadsheetId, normalizeToken, GoogleSync } = require('../../src/main/google-sync');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cis-gs-'));

test('a1', () => {
  assert.strictEqual(a1(0, 0), 'A1');
  assert.strictEqual(a1(25, 9), 'Z10');
  assert.strictEqual(a1(26, 4), 'AA5');
  assert.strictEqual(a1(701, 0), 'ZZ1');
  assert.strictEqual(a1(702, 0), 'AAA1');
});

test('findCell: case-insensitive, row-major, empty rows, null', () => {
  const v = [['x', 'y'], [], null, ['foo', 'please ADD here'], ['add']];
  assert.deepStrictEqual(findCell(v, 'add'), { row: 3, col: 1 });
  assert.deepStrictEqual(findCell([['a', 'Add'], ['add']], 'add'), { row: 0, col: 1 });
  assert.deepStrictEqual(findCell([[1, 'x'], [12]], '2'), { row: 1, col: 0 });
  assert.strictEqual(findCell(v, 'nope'), null);
  assert.strictEqual(findCell(null, 'add'), null);
  assert.strictEqual(findCell(undefined, 'add'), null);
  assert.strictEqual(findCell([[null, '']], 'add'), null);
});

test('parseSpreadsheetId', () => {
  assert.strictEqual(parseSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbC-d_E/edit#gid=0'), '1AbC-d_E');
  assert.strictEqual(parseSpreadsheetId('  1AbC-d_E  '), '1AbC-d_E');
  assert.strictEqual(parseSpreadsheetId(''), '');
});

test('normalizeToken: python format', () => {
  const t = normalizeToken({ token: 'at', refresh_token: 'rt', expiry: '2025-01-02T03:04:05.123456Z', client_id: 'c' });
  assert.deepStrictEqual(t, { access_token: 'at', refresh_token: 'rt', expiry_date: Date.UTC(2025, 0, 2, 3, 4, 5, 123) });
  const naive = normalizeToken({ token: 'at', refresh_token: 'rt', expiry: '2025-01-02T03:04:05' });
  assert.strictEqual(naive.expiry_date, Date.UTC(2025, 0, 2, 3, 4, 5));
});

test('normalizeToken: node format passes through', () => {
  assert.deepStrictEqual(normalizeToken({ access_token: 'a', refresh_token: 'r', expiry_date: 5, scope: 's' }),
    { access_token: 'a', refresh_token: 'r', expiry_date: 5 });
  assert.deepStrictEqual(normalizeToken({ refresh_token: 'r' }), { refresh_token: 'r' });
});

function fakeClients({ values = [['a'], ['b', 'add']], failGet = [], permFail = false } = {}) {
  const calls = { create: [], perm: [], get: [], update: [] };
  const drive = {
    files: { create: async (p) => { calls.create.push(p); return { data: { id: 'FID' } }; } },
    permissions: { create: async (p) => { calls.perm.push(p); if (permFail) throw new Error('nope'); return { data: {} }; } },
  };
  const sheets = { spreadsheets: { values: {
    get: async (p) => { calls.get.push(p); const e = failGet.shift(); if (e) throw e; return { data: { values } }; },
    update: async (p) => { calls.update.push(p); return { data: {} }; },
  } } };
  return { calls, clients: { drive, sheets } };
}

const SETTINGS = { enabled: true, authMode: 'oauth', spreadsheetId: 'https://docs.google.com/spreadsheets/d/SID/edit#gid=0',
  sheetName: "Bob's", searchTerm: 'ADD', driveFolderId: 'DF' };

function imageFile() {
  const p = path.join(tmp(), 'img_1.png');
  fs.writeFileSync(p, 'png');
  return p;
}

test('uploadAndUpdate writes IMAGE formula into found cell', async () => {
  const { calls, clients } = fakeClients({ permFail: true });
  const gs = new GoogleSync(SETTINGS, { clients, retryDelayMs: 0 });
  const r = await gs.uploadAndUpdate(imageFile());
  const link = 'https://drive.google.com/uc?export=view&id=FID';
  assert.deepStrictEqual(r, { fileId: 'FID', link, cell: "'Bob''s'!B2" });
  assert.strictEqual(calls.get[0].spreadsheetId, 'SID');
  assert.strictEqual(calls.get[0].range, "'Bob''s'");
  assert.deepStrictEqual(calls.create[0].requestBody, { name: 'img_1.png', parents: ['DF'] });
  assert.strictEqual(calls.create[0].supportsAllDrives, true);
  assert.strictEqual(calls.create[0].media.mimeType, 'image/png');
  assert.deepStrictEqual(calls.perm[0].requestBody, { role: 'reader', type: 'anyone' });
  assert.deepStrictEqual(calls.update[0], { spreadsheetId: 'SID', range: "'Bob''s'!B2", valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[`=IMAGE("${link}")`]] } });
});

test('uploadAndUpdate: no parents when driveFolderId empty', async () => {
  const { calls, clients } = fakeClients();
  await new GoogleSync({ ...SETTINGS, driveFolderId: '' }, { clients }).uploadAndUpdate(imageFile());
  assert.deepStrictEqual(calls.create[0].requestBody, { name: 'img_1.png' });
});

test('uploadAndUpdate throws Russian error when no cell, uploads nothing', async () => {
  const { calls, clients } = fakeClients({ values: [['x']] });
  const gs = new GoogleSync({ ...SETTINGS, sheetName: 'Лист1' }, { clients });
  await assert.rejects(gs.uploadAndUpdate(imageFile()), { message: 'Не найдена ячейка с «ADD» на листе «Лист1»' });
  assert.strictEqual(calls.create.length, 0);
});

test('retry on 503 then success; 400 not retried; gives up after 3', async () => {
  const e503 = Object.assign(new Error('unavailable'), { status: 503 });
  const ok = fakeClients({ failGet: [e503, Object.assign(new Error('reset'), { code: 'ECONNRESET' })] });
  const r = await new GoogleSync(SETTINGS, { clients: ok.clients, retryDelayMs: 0 }).uploadAndUpdate(imageFile());
  assert.strictEqual(r.cell, "'Bob''s'!B2");
  assert.strictEqual(ok.calls.get.length, 3);

  const e400 = Object.assign(new Error('bad'), { status: 400 });
  const bad = fakeClients({ failGet: [e400] });
  await assert.rejects(new GoogleSync(SETTINGS, { clients: bad.clients, retryDelayMs: 0 }).uploadAndUpdate(imageFile()), /bad/);
  assert.strictEqual(bad.calls.get.length, 1);

  const many = fakeClients({ failGet: [e503, e503, e503, e503] });
  await assert.rejects(new GoogleSync(SETTINGS, { clients: many.clients, retryDelayMs: 0 }).uploadAndUpdate(imageFile()), /unavailable/);
  assert.strictEqual(many.calls.get.length, 3);
});

// ---- OAuth against a local fake token endpoint ----

async function tokenServer(handler) {
  const reqs = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(body));
      reqs.push(params);
      const [status, json] = handler(params);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, reqs, url: `http://127.0.0.1:${srv.address().port}/token` };
}

function oauthSetup(tokenUrl, token) {
  const dir = tmp();
  const secret = path.join(dir, 'client_secret.json');
  fs.writeFileSync(secret, JSON.stringify({ installed: { client_id: 'cid', client_secret: 'cs', token_uri: tokenUrl } }));
  const tokenPath = path.join(dir, 'google-token.json');
  if (token) fs.writeFileSync(tokenPath, JSON.stringify(token));
  return { settings: { ...SETTINGS, clientSecretFile: secret }, tokenPath };
}

const EXPIRED = { token: 'old', refresh_token: 'rt-old', expiry: '2020-01-01T00:00:00Z' };

test('refresh persists token and keeps refresh_token', async () => {
  const ts = await tokenServer(() => [200, { access_token: 'fresh', expires_in: 3600, token_type: 'Bearer' }]);
  try {
    const { settings, tokenPath } = oauthSetup(ts.url, EXPIRED);
    await new GoogleSync(settings, { tokenPath }).init();
    assert.strictEqual(ts.reqs[0].grant_type, 'refresh_token');
    assert.strictEqual(ts.reqs[0].refresh_token, 'rt-old');
    const saved = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    assert.strictEqual(saved.access_token, 'fresh');
    assert.strictEqual(saved.refresh_token, 'rt-old');
    assert.ok(saved.expiry_date > Date.now());
  } finally { ts.srv.close(); }
});

test('valid token: no refresh request, no browser', async () => {
  const ts = await tokenServer(() => [500, {}]);
  try {
    const { settings, tokenPath } = oauthSetup(ts.url, { access_token: 'a', refresh_token: 'r', expiry_date: Date.now() + 3600e3 });
    await new GoogleSync(settings, { tokenPath, openExternal: () => assert.fail('browser opened') }).init();
    assert.strictEqual(ts.reqs.length, 0);
  } finally { ts.srv.close(); }
});

test('invalid_grant without openExternal: token deleted, clear error', async () => {
  const ts = await tokenServer(() => [400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }]);
  try {
    const { settings, tokenPath } = oauthSetup(ts.url, EXPIRED);
    await assert.rejects(new GoogleSync(settings, { tokenPath }).init(), /вход в Google/);
    assert.strictEqual(fs.existsSync(tokenPath), false);
  } finally { ts.srv.close(); }
});

test('invalid_grant with openExternal: loopback flow gets and saves new token', async () => {
  const ts = await tokenServer((p) => p.grant_type === 'refresh_token'
    ? [400, { error: 'invalid_grant' }]
    : [200, { access_token: 'new', refresh_token: 'rt-new', expires_in: 3600 }]);
  try {
    const { settings, tokenPath } = oauthSetup(ts.url, EXPIRED);
    let page;
    const openExternal = async (url) => {
      const u = new URL(url);
      assert.strictEqual(u.searchParams.get('access_type'), 'offline');
      assert.match(u.searchParams.get('scope'), /spreadsheets/);
      const redirect = new URL(u.searchParams.get('redirect_uri'));
      assert.strictEqual(redirect.hostname, '127.0.0.1');
      // wrong state is rejected and does not finish the flow
      const bad = await fetch(`${redirect}?code=evil&state=wrong`);
      assert.strictEqual(bad.status, 400);
      const res = await fetch(`${redirect}?code=CODE&state=${u.searchParams.get('state')}`);
      page = await res.text();
    };
    await new GoogleSync(settings, { tokenPath, openExternal }).init();
    assert.match(page, /можно закрыть/);
    const exchange = ts.reqs.find((r) => r.grant_type === 'authorization_code');
    assert.strictEqual(exchange.code, 'CODE');
    assert.ok(exchange.code_verifier);
    const saved = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    assert.strictEqual(saved.access_token, 'new');
    assert.strictEqual(saved.refresh_token, 'rt-new');
  } finally { ts.srv.close(); }
});

test('loopback server times out and closes', async () => {
  const { settings, tokenPath } = oauthSetup('http://127.0.0.1:1/token', null);
  let redirect;
  const openExternal = async (url) => { redirect = new URL(url).searchParams.get('redirect_uri'); };
  await assert.rejects(new GoogleSync(settings, { tokenPath, openExternal, authTimeoutMs: 100 }).init(), /истекло/);
  await assert.rejects(fetch(redirect));
});

test('invalid_grant mid-session: token removed, clear error, re-init next time', async () => {
  const { settings, tokenPath } = oauthSetup('http://127.0.0.1:1/token', { refresh_token: 'r' });
  const { clients } = fakeClients({ failGet: [new Error('invalid_grant')] });
  const gs = new GoogleSync(settings, { tokenPath, clients });
  await assert.rejects(gs.uploadAndUpdate(imageFile()), /повторный вход/);
  assert.strictEqual(fs.existsSync(tokenPath), false);
  assert.strictEqual(gs.clients, null);
});

test('service mode builds real drive/sheets clients without network', async () => {
  const key = path.join(tmp(), 'sa.json');
  const { privateKey } = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(key, JSON.stringify({ type: 'service_account', client_email: 'x@y.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  const gs = new GoogleSync({ ...SETTINGS, authMode: 'service', credentialsFile: key }, {});
  await gs.init();
  assert.strictEqual(typeof gs.clients.drive.files.create, 'function');
  assert.strictEqual(typeof gs.clients.sheets.spreadsheets.values.update, 'function');
});

test('module does not load electron', () => {
  assert.ok(!Object.keys(require.cache).some((k) => /[\\/]electron[\\/]/.test(k)));
});

test('oauth: missing client secret file gives clear error', async () => {
  const gs = new GoogleSync({ ...SETTINGS, clientSecretFile: path.join(tmp(), 'missing.json') }, { tokenPath: path.join(tmp(), 't.json') });
  await assert.rejects(gs.init(), /client_secret/i);
});

test('service: missing key file gives clear error', async () => {
  const gs = new GoogleSync({ ...SETTINGS, authMode: 'service', credentialsFile: path.join(tmp(), 'missing.json') }, {});
  await assert.rejects(gs.init(), /сервисного аккаунта/);
});

test('concurrent init() calls share one in-flight init', async () => {
  const ts = await tokenServer(() => [200, { access_token: 'fresh', expires_in: 3600, token_type: 'Bearer' }]);
  try {
    const { settings, tokenPath } = oauthSetup(ts.url, EXPIRED);
    const gs = new GoogleSync(settings, { tokenPath });
    const a = gs.init();
    assert.strictEqual(gs.init(), a);
    await a;
    assert.strictEqual(ts.reqs.length, 1);
  } finally { ts.srv.close(); }
});
