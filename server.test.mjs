import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalD1 } from './scripts/sqlite-d1.mjs';
import { handleApi } from './server/api.mjs';
import { initialState, ledger, categories } from './shared/core.mjs';
import { createWorker } from './server/worker.mjs';

function fixture(t, filename) {
  const db = new LocalD1(filename); db.migrate(); t.after(() => db.close());
  async function request(route, { user = 'alice', method, body, key, headers = {} } = {}) {
    const response = await handleApi(new Request('https://grantfold.test' + route, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...(user ? { 'oai-authenticated-user-id': user, 'oai-authenticated-user-email': user + '@example.test' } : {}),
        'x-grantfold-client': 'browser', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { 'idempotency-key': key } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { DB: db });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  const bootstrap = (legacy = null, user = 'alice') => request('/api/account/bootstrap', { body: { legacy }, user });
  const action = (body, key = crypto.randomUUID(), user = 'alice') => request('/api/actions', { body, key, user });
  return { db, request, bootstrap, action };
}
const buy = (itemId = 'rpc') => ({ type: 'purchase', cardId: 'card-1', itemId });
const rules = values => ({ type: 'rules', cardId: 'card-1', name: 'Research agent', perBuy: 5000, perDay: 10000, askAbove: 2500, categories, ...values });

test('session requires trusted identity; account APIs cannot read or write anonymously', async t => {
  const f = fixture(t);
  const session = await f.request('/api/session', { user: null });
  assert.equal(session.status, 200); assert.equal(session.data.authenticated, false);
  assert.equal(session.data.chainId, 4663); assert.equal(session.data.paymentAsset, 'USDG');
  assert.equal(session.data.mode, 'pilot'); assert.equal(session.data.sandboxBalances, true);
  assert.equal(session.data.liveMarket.settlement, 'customer_wallet'); assert.equal(session.data.liveMarket.automaticAgentPayments, true);
  assert.equal((await f.request('/api/account', { user: null })).status, 401);
  assert.equal((await f.request('/api/account/bootstrap', { user: null, body: { legacy: null } })).status, 401);
  assert.equal(session.headers.get('cache-control'), 'no-store');
});

test('writes reject cross-origin requests and missing client marker', async t => {
  const f = fixture(t); await f.bootstrap();
  for (const headers of [{ origin: 'https://other.test' }, { 'sec-fetch-site': 'cross-site' }, { 'x-grantfold-client': '' }]) {
    assert.equal((await f.request('/api/actions', { body: buy(), key: crypto.randomUUID(), headers })).status, 403);
  }
  assert.equal((await f.request('/api/account')).data.revision, 0);
});

test('accounts and audit events are isolated by platform user, ignoring body owner overrides', async t => {
  const f = fixture(t); await f.bootstrap(); await f.bootstrap(null, 'bob');
  await f.action(buy());
  const bob = (await f.request('/api/account', { user: 'bob' })).data;
  assert.equal(bob.state.cards[0].balance, 15000); assert.equal(bob.state.orders.length, 0);
  assert.equal((await f.action({ ...buy(), userId: 'bob' })).status, 422);
  assert.equal((await f.request('/api/audit', { user: 'bob' })).data.events.length, 1);
  assert.equal((await f.request('/api/audit')).data.events.length, 2);
});

test('the same purchase key debits once and replays its receipt, while changed payload conflicts', async t => {
  const f = fixture(t); await f.bootstrap(); const key = crypto.randomUUID();
  const a = await f.action(buy(), key), b = await f.action(buy(), key);
  assert.equal(a.status, 200); assert.equal(b.data.replayed, true);
  assert.deepEqual(a.data.effect, b.data.effect); assert.equal(b.data.state.orders.length, 1);
  assert.equal(b.data.state.cards[0].balance, 14000); assert.equal(b.data.revision, 1);
  assert.equal((await f.action(buy('compute'), key)).status, 409);
  assert.equal((await f.request('/api/audit')).data.events.length, 2);
});

test('concurrent identical requests create one order and a single audit record', async t => {
  const f = fixture(t); await f.bootstrap(); const key = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.action(buy(), key)));
  assert.ok(results.every(r => r.status === 200));
  assert.equal(new Set(results.map(r => r.data.effect.orderId)).size, 1);
  const account = (await f.request('/api/account')).data;
  assert.equal(account.state.orders.length, 1); assert.equal(account.revision, 1);
  assert.equal((await f.request('/api/audit')).data.events.length, 2);
});

test('parallel holds cannot overspend the daily budget', async t => {
  const f = fixture(t); await f.bootstrap();
  const results = await Promise.all(Array.from({ length: 5 }, () => f.action(buy('market'))));
  assert.equal(results.filter(r => r.status === 200).length, 2);
  assert.ok(results.filter(r => r.status !== 200).every(r => r.status === 422));
  const { state, revision } = (await f.request('/api/account')).data;
  assert.equal(revision, 2); assert.equal(state.orders.length, 2);
  assert.equal(state.cards[0].balance, 15000); assert.equal(ledger(state, 'card-1').held, 8000);
});

test('parallel purchases cannot spend the same available balance', async t => {
  const f = fixture(t), legacy = initialState(); legacy.cards[0].balance = 1000;
  await f.bootstrap(legacy);
  const results = await Promise.all([f.action(buy()), f.action(buy())]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 422]);
  const { state } = (await f.request('/api/account')).data;
  assert.equal(state.cards[0].balance, 0); assert.equal(state.orders.length, 1);
});

test('failed transaction rolls back balance, order, receipt and audit; retry safely completes', async t => {
  const f = fixture(t); await f.bootstrap(); const key = crypto.randomUUID();
  f.db.failStatement = 2;
  assert.equal((await f.action(buy(), key)).status, 500);
  const before = (await f.request('/api/account')).data;
  assert.equal(before.revision, 0); assert.equal(before.state.cards[0].balance, 15000); assert.equal(before.state.orders.length, 0);
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM mutation_receipts').get().n, 0);
  assert.equal((await f.request('/api/audit')).data.events.length, 1);
  assert.equal((await f.action(buy(), key)).data.state.cards[0].balance, 14000);
});

test('approval rechecks current freeze and category rules, then settles only once', async t => {
  const f = fixture(t); await f.bootstrap(); const order = (await f.action(buy('market'))).data.effect.orderId;
  const approve = { type: 'resolve', orderId: order, action: 'approve' };
  await f.action({ type: 'freeze', cardId: 'card-1', frozen: true });
  assert.equal((await f.action(approve)).status, 422);
  await f.action({ type: 'freeze', cardId: 'card-1', frozen: false });
  await f.action(rules({ categories: ['Developer tools'] }));
  assert.equal((await f.action(approve)).status, 422);
  await f.action(rules({})); const key = crypto.randomUUID();
  const results = await Promise.all([f.action(approve, key), f.action(approve, key)]);
  assert.ok(results.every(r => r.status === 200));
  assert.equal((await f.action(approve)).status, 422);
  const { state } = (await f.request('/api/account')).data;
  assert.equal(state.cards[0].balance, 11000); assert.equal(ledger(state, 'card-1').held, 0);
  assert.match(state.orders[0].receipt, /^DEMO-.*-SAMPLE$/);
});

test('declining and cancelling releases holds without debiting', async t => {
  const f = fixture(t); await f.bootstrap();
  for (const resolution of ['decline', 'cancel']) {
    const orderId = (await f.action(buy('market'))).data.effect.orderId;
    const result = await f.action({ type: 'resolve', orderId, action: resolution });
    assert.equal(result.status, 200); assert.equal(ledger(result.data.state, 'card-1').held, 0);
    assert.equal(result.data.state.cards[0].balance, 15000);
  }
});

test('browser backup imports once and can never overwrite the saved account', async t => {
  const f = fixture(t), backup = initialState(); backup.cards[0].balance = 2300;
  assert.equal((await f.bootstrap(backup)).data.imported, true);
  await f.action(buy()); backup.cards[0].balance = 999999;
  const a = await f.bootstrap(backup), b = await f.bootstrap({ malformed: true });
  assert.equal(a.data.imported, false); assert.equal(b.status, 200);
  assert.equal(b.data.state.cards[0].balance, 1300); assert.equal(b.data.state.orders.length, 1);
});

test('malformed backup is rejected without creating an account', async t => {
  const f = fixture(t);
  const inputs = [1, { ...initialState(), cards: [null] }, { ...initialState(), orders: [null] }];
  const polluted = initialState(); polluted.cards[0].id = '__proto__'; inputs.push(polluted);
  const invalidMoney = initialState(); invalidMoney.cards[0].balance = -1; inputs.push(invalidMoney);
  for (const input of inputs) {
    const r = await f.bootstrap(input); assert.equal(r.status, 422); assert.equal(r.data.error.code, 'invalid_backup');
    assert.equal((await f.request('/api/account')).status, 404);
  }
  assert.equal((await f.bootstrap()).status, 200);
});

test('server catalog refuses client prices, invalid cents and rule hierarchy without partial writes', async t => {
  const f = fixture(t); await f.bootstrap();
  for (const body of [{ ...buy(), amount: 1 }, buy('unknown'), { type: 'fund', cardId: 'card-1', amount: 100.5 }, rules({ perDay: 1000 }), { type: 'new-card', name: '' }]) {
    assert.equal((await f.action(body)).status, 422);
  }
  assert.equal((await f.request('/api/account')).data.revision, 0);
});

test('assistant stores exact item result and rejected request without a substitute purchase', async t => {
  const f = fixture(t); await f.bootstrap();
  const send = text => f.action({ type: 'assistant', cardId: 'card-1', text });
  const rejected = await send('Buy $7 of RPC credits');
  assert.equal(rejected.data.effect.rejected, true); assert.equal(rejected.data.state.orders.length, 0);
  const accepted = await send('Buy $10 of RPC credits');
  assert.equal(accepted.data.state.cards[0].balance, 14000);
  assert.equal(accepted.data.state.orders.length, 1); assert.equal(accepted.data.state.messages['card-1'].length, 4);
  assert.match(accepted.data.state.messages['card-1'][3].text, /No actual service/);
});

test('new cards have isolated balances, and funding is persisted as a server action', async t => {
  const f = fixture(t); await f.bootstrap();
  const cardId = (await f.action({ type: 'new-card', name: 'Coding agent' })).data.effect.cardId;
  assert.match(cardId, /^card-/);
  await f.action({ type: 'fund', cardId, amount: 5000 });
  const result = await f.action({ type: 'purchase', cardId, itemId: 'compute' });
  assert.equal(result.data.state.cards[0].balance, 15000); assert.equal(result.data.state.cards[1].balance, 2500);
  assert.equal((await f.request('/api/audit')).data.events[0].kind, 'purchase');
});

test('database restart retains account, orders and idempotency receipt', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'grantfold-test-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'account.sqlite'), key = crypto.randomUUID();
  const original = new LocalD1(filename); original.migrate();
  const headers = { 'oai-authenticated-user-id': 'alice', 'oai-authenticated-user-email': 'alice@example.test', 'x-grantfold-client': 'browser', 'content-type': 'application/json' };
  await handleApi(new Request('https://grantfold.test/api/account/bootstrap', { method: 'POST', headers, body: '{}' }), { DB: original });
  await handleApi(new Request('https://grantfold.test/api/actions', { method: 'POST', headers: { ...headers, 'idempotency-key': key }, body: JSON.stringify(buy()) }), { DB: original });
  original.close();
  const f = fixture(t, filename), replay = await f.action(buy(), key);
  assert.equal(replay.data.replayed, true); assert.equal(replay.data.state.cards[0].balance, 14000);
  assert.equal(replay.data.state.orders.length, 1); assert.equal(replay.data.revision, 1);
});

test('API validates content type, request size, idempotency key and method', async t => {
  const f = fixture(t); await f.bootstrap();
  assert.equal((await f.request('/api/actions', { body: buy() })).status, 400);
  assert.equal((await f.request('/api/actions', { body: buy(), key: 'short' })).status, 400);
  assert.equal((await f.request('/api/actions', { body: buy(), key: crypto.randomUUID(), headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.action({ type: 'assistant', cardId: 'card-1', text: 'x'.repeat(40000) })).status, 413);
  assert.equal((await f.request('/api/account', { method: 'DELETE' })).status, 405);
});

test('Worker serves embedded assets, handles HEAD, and rejects inherited object keys', async () => {
  const worker = createWorker({ '/index.html': { type: 'text/html', base64: btoa('<title>Grantfold</title>') } });
  assert.equal(await (await worker.fetch(new Request('https://grantfold.test/'), {})).text(), '<title>Grantfold</title>');
  assert.equal(await (await worker.fetch(new Request('https://grantfold.test/', { method: 'HEAD' }), {})).text(), '');
  assert.equal((await worker.fetch(new Request('https://grantfold.test/toString'), {})).status, 404);
});
