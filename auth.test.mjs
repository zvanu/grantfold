import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { LocalD1 } from './scripts/sqlite-d1.mjs';
import { handleApi } from './server/api.mjs';
import { createServer, request as httpRequest } from 'node:http';
import { createNodeHandler } from './api/handler.mjs';

async function fixture(t) {
  const db = new LocalD1(); db.migrate(); t.after(() => db.close());
  const env = { DB: db, AUTH_MODE: 'wallet', GRANTFOLD_WALLET_KEY_V1: 'ab'.repeat(32) };
  const owner = privateKeyToAccount(generatePrivateKey());
  async function call(path, body, cookie = '', extra = {}) {
    const response = await handleApi(new Request('https://grantfold.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-grantfold-client': 'browser', origin: 'https://grantfold.test', 'idempotency-key': crypto.randomUUID(), cookie, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
    return { response, status: response.status, data: await response.json(), cookies: response.headers.getSetCookie() };
  }
  async function challenge(account = owner) {
    const c = await call('/api/auth/challenge', { address: account.address }); assert.equal(c.status, 200);
    return { ...c, cookie: c.cookies[0].split(';')[0], signature: await account.signMessage({ message: c.data.message }) };
  }
  async function login(account = owner) {
    const c = await challenge(account), result = await call('/api/auth/verify', { id: c.data.id, signature: c.signature }, c.cookie);
    assert.equal(result.status, 200); return { ...result, cookie: result.cookies.find(c => c.startsWith('__Host-grantfold_session=')).split(';')[0] };
  }
  return { db, env, owner, call, challenge, login };
}

test('wallet mode ignores forged platform identity and never opens accounts anonymously', async t => {
  const f = await fixture(t), headers = { 'oai-authenticated-user-id': 'victim', 'oai-authenticated-user-email': 'victim@example.com' };
  assert.equal((await f.call('/api/session', undefined, '', headers)).data.authenticated, false);
  assert.equal((await f.call('/api/account/bootstrap', { legacy: null }, '', headers)).status, 401);
  assert.equal((await f.call('/api/agent/prepare', { cardId: 'card-1', owner: f.owner.address }, '', headers)).status, 401);
});

test('SIWE login binds domain, chain, nonce and browser; only hashed session tokens persist', async t => {
  const f = await fixture(t), login = await f.login();
  assert.match(login.cookies[0], /HttpOnly; SameSite=Strict/); assert.match(login.cookies[0], /; Secure/);
  assert.equal(login.data.user.address, f.owner.address); assert.equal(login.data.user.authentication, 'wallet');
  const row = f.db.connection.prepare('SELECT * FROM wallet_sessions').get();
  assert.notEqual(row.token_hash, login.cookie.split('=')[1]); assert.equal(row.token_hash.length, 64);
  assert.equal((await f.call('/api/session', undefined, login.cookie)).data.authenticated, true);
  assert.equal((await f.call('/api/account/bootstrap', { legacy: null }, login.cookie)).status, 200);
  await f.call('/api/auth/logout', {}, login.cookie);
  assert.equal((await f.call('/api/account', undefined, login.cookie)).status, 401);
  const again = await f.login(); assert.equal((await f.call('/api/account', undefined, again.cookie)).status, 200);
});

test('wrong wallet, altered domain, missing browser cookie and reused signatures are refused', async t => {
  const f = await fixture(t), c = await f.challenge(), other = privateKeyToAccount(generatePrivateKey());
  for (const signature of [await other.signMessage({ message: c.data.message }), await f.owner.signMessage({ message: c.data.message.replace('grantfold.test', 'attacker.test') })]) assert.equal((await f.call('/api/auth/verify', { id: c.data.id, signature }, c.cookie)).status, 401);
  assert.equal((await f.call('/api/auth/verify', { id: c.data.id, signature: c.signature })).status, 401);
  assert.equal((await f.call('/api/auth/verify', { id: c.data.id, signature: c.signature }, c.cookie)).status, 200);
  assert.equal((await f.call('/api/auth/verify', { id: c.data.id, signature: c.signature }, c.cookie)).status, 401);
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM wallet_sessions').get().n, 1);
});

test('expired login and cross-origin browser writes cannot establish a session', async t => {
  const f = await fixture(t), c = await f.challenge();
  f.db.connection.prepare('UPDATE wallet_login_challenges SET expires_at = 0').run();
  assert.equal((await f.call('/api/auth/verify', { id: c.data.id, signature: c.signature }, c.cookie)).status, 401);
  assert.equal((await f.call('/api/auth/challenge', { address: f.owner.address }, '', { origin: 'https://attacker.test' })).status, 403);
  assert.equal((await f.call('/api/auth/challenge', { address: f.owner.address }, '', { 'x-grantfold-client': '' })).status, 403);
  const login = await f.login(); f.db.connection.prepare('UPDATE wallet_sessions SET expires_at = 0').run();
  assert.equal((await f.call('/api/account', undefined, login.cookie)).status, 401);
});

test('parallel verification consumes a wallet login once', async t => {
  const f = await fixture(t), c = await f.challenge(), body = { id: c.data.id, signature: c.signature };
  const results = await Promise.all([f.call('/api/auth/verify', body, c.cookie), f.call('/api/auth/verify', body, c.cookie)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM wallet_sessions').get().n, 1);
});

test('wallet accounts are isolated and agent setup cannot bind another owner', async t => {
  const f = await fixture(t), a = await f.login(), other = privateKeyToAccount(generatePrivateKey()), b = await f.login(other);
  await f.call('/api/account/bootstrap', { legacy: null }, a.cookie); await f.call('/api/account/bootstrap', { legacy: null }, b.cookie);
  await f.call('/api/actions', { type: 'new-card', name: 'Private card' }, a.cookie);
  assert.equal((await f.call('/api/account', undefined, a.cookie)).data.state.cards.length, 2);
  assert.equal((await f.call('/api/account', undefined, b.cookie)).data.state.cards.length, 1);
  assert.equal((await f.call('/api/agent/prepare', { cardId: 'card-1', owner: other.address }, a.cookie)).status, 403);
  const user = (await f.call('/api/session', undefined, a.cookie, { 'oai-authenticated-user-id': 'victim', 'oai-authenticated-user-email': 'victim@test.example' })).data.user;
  assert.equal(user.address, f.owner.address);
});

test('Vercel Node handler transports wallet cookies and rejects forged identity and Host headers', async t => {
  const f = await fixture(t), env = { GRANTFOLD_WALLET_KEY_V1: f.env.GRANTFOLD_WALLET_KEY_V1 };
  const server = createServer(createNodeHandler({ env, db: f.db }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port; env.GRANTFOLD_SITE_ORIGIN = base;
  const request = (path, body, cookie = '') => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-grantfold-client': 'browser', origin: base, cookie, 'oai-authenticated-user-id': 'victim', 'oai-authenticated-user-email': 'victim@example.com' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await (await request('/api/session')).json()).authenticated, false);
  const challengeResponse = await request('/api/auth/challenge', { address: f.owner.address }), challenge = await challengeResponse.json();
  const login = await request('/api/auth/verify', { id: challenge.id, signature: await f.owner.signMessage({ message: challenge.message }) }, challengeResponse.headers.getSetCookie()[0].split(';')[0]);
  assert.equal(login.status, 200); assert.equal(login.headers.getSetCookie().length, 2);
  const session = login.headers.getSetCookie().find(c => c.startsWith('grantfold_session=')).split(';')[0];
  assert.equal((await (await request('/api/session', undefined, session)).json()).user.address, f.owner.address);
  const forgedHostStatus = await new Promise((resolve, reject) => { const r = httpRequest(base + '/api/session', { headers: { host: 'attacker.test' } }, response => { response.resume(); resolve(response.statusCode); }); r.on('error', reject); r.end(); });
  assert.equal(forgedHostStatus, 400);
  env.GRANTFOLD_VERCEL_ORIGIN = 'http://temporary.grantfold.test';
  const allowedHostStatus = await new Promise((resolve, reject) => { const r = httpRequest(base + '/api/session', { headers: { host: 'temporary.grantfold.test' } }, response => { response.resume(); resolve(response.statusCode); }); r.on('error', reject); r.end(); });
  assert.equal(allowedHostStatus, 200);
});
