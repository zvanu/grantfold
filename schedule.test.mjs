import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { LocalD1 } from './scripts/sqlite-d1.mjs';
import { handleApi } from './server/api.mjs';
import { consentTypedData } from './shared/commission.mjs';
import { scheduleTypedData, nextScheduleWindow } from './shared/schedule.mjs';
import { MockChainProvider } from './test/fixtures/chain.mjs';
import { gfldFeePolicy } from './web/token.mjs';

async function fixture(t) {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const db = new LocalD1(); db.migrate(); t.after(() => db.close());
  const provider = new MockChainProvider(), owner = privateKeyToAccount(generatePrivateKey());
  const origin = 'https://grantfold.test', env = { DB: db, GRANTFOLD_WALLET_KEY_V1: 'ae'.repeat(32), CRON_SECRET: 'test-scheduler-authentication-secret-2026' };
  async function api(path, body, user = 'alice', key = crypto.randomUUID()) {
    const headers = { 'content-type': 'application/json', 'x-grantfold-client': 'browser', 'idempotency-key': key, ...(user ? { 'oai-authenticated-user-id': user, 'oai-authenticated-user-email': user + '@example.test' } : {}) };
    const r = await handleApi(new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, { marketProvider: provider });
    return { status: r.status, data: await r.json() };
  }
  async function cron(hour, secret = env.CRON_SECRET) {
    const r = await handleApi(new Request(origin + '/api/cron/schedules/' + String(hour).padStart(2, '0'), { headers: { authorization: 'Bearer ' + secret } }), env, { marketProvider: provider });
    return { status: r.status, data: await r.json() };
  }
  await api('/api/account/bootstrap', { legacy: null });
  const setup = (await api('/api/agent/prepare', { cardId: 'card-1', owner: owner.address })).data.effect.setup;
  await api('/api/agent/enable', { cardId: 'card-1', signature: await owner.signTypedData(consentTypedData(setup, origin)) });
  provider.fund(setup.address);
  async function prepare(extra = {}) {
    return api('/api/schedule/prepare', { cardId: 'card-1', utcHour: (new Date(clock).getUTCHours() + 1) % 24, maxRuns: 2, maxTotalMicros: 15750, ...extra });
  }
  async function enable(extra = {}) {
    const p = await prepare(extra); assert.equal(p.status, 200, JSON.stringify(p.data));
    const plan = p.data.effect.setup, signature = await owner.signTypedData(scheduleTypedData(plan));
    const result = await api('/api/schedule/enable', { cardId: 'card-1', signature }); assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data.state.schedules['card-1'];
  }
  return { db, env, api, cron, provider, owner, address: setup.address, prepare, enable,
    at: value => { clock = value; }, state: async () => (await api('/api/account')).data.state };
}

test('schedule consent binds exact product, site, owner, cap, run count and timestamps; pause cannot be replayed away', async t => {
  const f = await fixture(t), p = (await f.prepare()).data.effect.setup;
  const other = privateKeyToAccount(generatePrivateKey());
  for (const signature of [await other.signTypedData(scheduleTypedData(p)), await f.owner.signTypedData(scheduleTypedData({ ...p, maxRuns: 7 })), await f.owner.signTypedData(scheduleTypedData({ ...p, site: 'https://other.test' }))]) {
    assert.equal((await f.api('/api/schedule/enable', { cardId: p.cardId, signature })).status, 422);
  }
  const signature = await f.owner.signTypedData(scheduleTypedData(p));
  assert.equal((await f.api('/api/schedule/enable', { cardId: p.cardId, signature })).status, 200);
  await f.api('/api/schedule/pause', { cardId: p.cardId });
  await f.api('/api/schedule/enable', { cardId: p.cardId, signature });
  assert.equal((await f.state()).schedules[p.cardId].status, 'paused');
  assert.equal(f.provider.providerTransfers, 0);
});

test('scheduler rejects anonymous, forged, cross-card and altered configuration requests before paying', async t => {
  const f = await fixture(t);
  assert.equal((await f.prepare({ cardId: 'foreign' })).status, 404);
  assert.equal((await f.prepare({ maxRuns: 8 })).status, 422);
  assert.equal((await f.prepare({ intervalMs: 1000 })).status, 422);
  assert.equal((await f.api('/api/schedule/pause', { cardId: 'card-1' }, null)).status, 401);
  assert.equal((await f.cron(9, 'forged')).status, 401);
  delete f.env.CRON_SECRET; assert.equal((await f.prepare()).status, 503);
  assert.equal(f.provider.providerTransfers, 0); assert.equal(f.provider.broadcasts, 0);
});

test('daily scheduling runs while no browser is involved and repeated/concurrent cron delivery buys exactly once', async t => {
  const f = await fixture(t), plan = await f.enable();
  assert.equal(f.provider.providerTransfers, 0);
  assert.equal((await f.cron(plan.utcHour)).status, 200); assert.equal(f.provider.providerTransfers, 0);
  f.at(plan.firstRunAt + 1000);
  await Promise.all([f.cron(plan.utcHour), f.cron(plan.utcHour)]); await f.cron(plan.utcHour);
  const state = await f.state(), p = state.schedules['card-1'];
  assert.equal(state.liveOrders.length, 1); assert.equal(state.liveOrders[0].status, 'completed');
  assert.equal(p.completedRuns, 1); assert.equal(p.startedRuns, 1); assert.equal(p.status, 'active');
  assert.equal(f.provider.providerTransfers, 1); assert.equal(f.provider.feeTransfers, 1);
});

test('the signed maximum run count stops future purchases and total price stays inside the plan budget', async t => {
  const f = await fixture(t), plan = await f.enable();
  f.at(plan.firstRunAt + 1000); await f.cron(plan.utcHour);
  f.at((await f.state()).schedules['card-1'].nextRunAt + 1000); await f.cron(plan.utcHour);
  f.at(plan.firstRunAt + 2 * 86400000 + 1000); await f.cron(plan.utcHour);
  const state = await f.state(); assert.equal(state.schedules['card-1'].status, 'completed');
  assert.equal(f.provider.providerTransfers, 2); assert.equal(f.provider.feeTransfers, 2);
  assert.equal(state.liveOrders.reduce((n, o) => n + o.totalMicros, 0), 31500);
});

test('a missed daily window is skipped instead of making catch-up purchases', async t => {
  const f = await fixture(t), plan = await f.enable(); f.at(plan.firstRunAt + 3 * 86400000 + 3600001);
  await f.cron(plan.utcHour); const p = (await f.state()).schedules['card-1'];
  assert.equal(p.startedRuns, 0); assert.equal(p.skippedRuns, 1); assert.ok(p.nextRunAt > Date.now());
  assert.equal(f.provider.providerTransfers, 0);
});

test('price above the total cap skips payment, including the Grantfold fee', async t => {
  const f = await fixture(t), plan = await f.enable({ maxTotalMicros: 15000 }); f.at(plan.firstRunAt + 1000);
  await f.cron(plan.utcHour); assert.equal(f.provider.providerTransfers, 0); assert.equal(f.provider.broadcasts, 0);
  assert.match((await f.state()).schedules['card-1'].message, /exceeded/);
});

test('new GFLD eligibility is read for each daily run rather than cached across days', async t => {
  const f = await fixture(t); f.env.GRANTFOLD_FEE_POLICY = JSON.stringify(gfldFeePolicy);
  let balance = 0n; const rpc = f.provider.rpc.bind(f.provider);
  f.provider.rpc = async (method, params) => {
    if (method === 'eth_getCode' && params[0] === gfldFeePolicy.token) return '0x6001';
    if (method === 'eth_call' && params[0].to === gfldFeePolicy.token) return '0x' + (params[0].data === '0x313ce567' ? 18n : balance).toString(16).padStart(64, '0');
    return rpc(method, params);
  };
  const plan = await f.enable(); f.at(plan.firstRunAt + 1000); await f.cron(plan.utcHour);
  balance = 1000000n * 10n ** 18n; f.at((await f.state()).schedules['card-1'].nextRunAt + 1000); await f.cron(plan.utcHour);
  const orders = (await f.state()).liveOrders; assert.deepEqual(orders.map(o => o.feeBps), [300, 500]);
  assert.equal(f.provider.providerTransfers, 2); assert.equal(f.provider.feeTransfers, 2);
});

test('pausing after preflight stops the unsigned scheduled payment before provider dispatch', async t => {
  const f = await fixture(t), plan = await f.enable(); f.at(plan.firstRunAt + 1000);
  f.provider.beforeEstimate = () => f.api('/api/schedule/pause', { cardId: 'card-1' });
  await f.cron(plan.utcHour); const state = await f.state();
  assert.equal(state.schedules['card-1'].status, 'paused'); assert.equal(f.provider.providerTransfers, 0); assert.equal(f.provider.broadcasts, 0);
  assert.equal(state.liveOrders[0].status, 'cancelled');
});

test('pausing after provider settlement allows the same fee/report to finish without another purchase', async t => {
  const f = await fixture(t), plan = await f.enable(); f.at(plan.firstRunAt + 1000);
  const fetcher = f.provider.fetchMock.bind(f.provider); let paused = false;
  f.provider.fetchMock = async (url, init) => { const r = await fetcher(url, init); if (!paused && init?.headers?.['PAYMENT-SIGNATURE']) { paused = true; await f.api('/api/schedule/pause', { cardId: 'card-1' }); } return r; };
  await f.cron(plan.utcHour); await f.cron(plan.utcHour);
  const state = await f.state(); assert.equal(state.liveOrders[0].status, 'completed'); assert.equal(state.schedules['card-1'].status, 'paused');
  assert.equal(f.provider.providerTransfers, 1); assert.equal(f.provider.feeTransfers, 1);
});

test('an uncertain settled delivery recovers the same scheduled order and never starts the next day early', async t => {
  const f = await fixture(t), plan = await f.enable(); f.at(plan.firstRunAt + 1000); f.provider.loseProviderResponse = true;
  await f.cron(plan.utcHour); const before = await f.state(); assert.equal(before.liveOrders[0].status, 'needs_review');
  await f.cron(plan.utcHour); const after = await f.state(); assert.equal(after.liveOrders.length, 1); assert.equal(after.liveOrders[0].id, before.liveOrders[0].id); assert.equal(after.liveOrders[0].status, 'completed');
  assert.equal(f.provider.providerTransfers, 1); assert.equal(f.provider.feeTransfers, 1);
});

test('agent pause and renewal invalidate the old recurring permission', async t => {
  const f = await fixture(t), plan = await f.enable(); await f.api('/api/actions', { type: 'assistant', cardId: 'card-1', text: 'Pause agent' });
  f.at(plan.firstRunAt + 1000); await f.cron(plan.utcHour); assert.equal(f.provider.providerTransfers, 0); assert.equal((await f.state()).schedules['card-1'].status, 'paused');
  const setup = (await f.api('/api/agent/prepare', { cardId: 'card-1', owner: f.owner.address })).data.effect.setup;
  await f.api('/api/agent/enable', { cardId: 'card-1', signature: await f.owner.signTypedData(consentTypedData(setup, 'https://grantfold.test')) });
  await f.cron(plan.utcHour); assert.equal(f.provider.providerTransfers, 0); assert.equal((await f.state()).schedules['card-1'].status, 'paused');
});

test('approval rules remain enforced and an expired unsigned scheduled approval never turns into a payment', async t => {
  const f = await fixture(t); await f.api('/api/actions', { type: 'rules', cardId: 'card-1', name: 'Research agent', perBuy: 5000, perDay: 10000, askAbove: 0, categories: ['Market data'] });
  const plan = await f.enable(); f.at(plan.firstRunAt + 1000); await f.cron(plan.utcHour);
  const state = await f.state(); assert.equal(state.liveOrders[0].status, 'agent_approval'); assert.equal(state.schedules['card-1'].status, 'awaiting_approval'); assert.equal(f.provider.providerTransfers, 0);
  f.at(plan.firstRunAt + 10 * 60000); await f.cron(plan.utcHour);
  assert.equal((await f.state()).liveOrders[0].status, 'cancelled'); assert.equal(f.provider.providerTransfers, 0);
});

test('missing client gas pauses the plan before a provider charge', async t => {
  const f = await fixture(t), plan = await f.enable(); f.provider.fund(f.address, 20000n, 0n); f.at(plan.firstRunAt + 1000);
  await f.cron(plan.utcHour); assert.equal(f.provider.providerTransfers, 0); assert.equal((await f.state()).schedules['card-1'].status, 'paused');
});

test('an expired schedule, a frozen card and a pre-existing manual order never trigger a new scheduled charge', async t => {
  const f = await fixture(t), plan = await f.enable();
  await f.api('/api/actions', { type: 'freeze', cardId: 'card-1', frozen: true });
  f.at(plan.firstRunAt + 1000); await f.cron(plan.utcHour); assert.equal(f.provider.providerTransfers, 0);
  await f.api('/api/actions', { type: 'freeze', cardId: 'card-1', frozen: false });
  const next = await f.enable();
  f.at(next.firstRunAt - 10000); await f.api('/api/live/quote', { cardId: 'card-1' }); f.at(next.firstRunAt + 1000);
  await f.cron(next.utcHour); assert.equal((await f.state()).liveOrders.length, 1); assert.equal(f.provider.providerTransfers, 0);
  f.at(next.validUntil + 1); await f.cron(next.utcHour); assert.notEqual((await f.state()).schedules['card-1'].status, 'active'); assert.equal(f.provider.providerTransfers, 0);
});

test('a failed atomic scheduled-order commit leaves no payment or partial run counter', async t => {
  const f = await fixture(t), plan = await f.enable(); f.at(plan.firstRunAt + 1000); f.db.failStatement = 2;
  await f.cron(plan.utcHour); const state = await f.state();
  assert.equal(state.liveOrders?.length || 0, 0); assert.equal(state.schedules['card-1'].startedRuns, 0);
  assert.equal(f.provider.providerTransfers, 0); assert.equal(f.provider.broadcasts, 0);
  await f.cron(plan.utcHour); assert.equal(f.provider.providerTransfers, 1);
});

test('schedule activity persists one verified receipt across concurrent cron retries and stays account-scoped', async t => {
  const f = await fixture(t), plan = await f.enable(); f.at(plan.firstRunAt + 1000);
  await Promise.all([f.cron(plan.utcHour), f.cron(plan.utcHour)]); await f.cron(plan.utcHour);
  const state = await f.state(), order = state.liveOrders[0], items = state.scheduleActivity;
  assert.equal(items.filter(item => item.kind === 'completed').length, 1);
  const receipt = items.find(item => item.kind === 'completed');
  assert.equal(receipt.orderId, order.id); assert.equal(receipt.cardId, 'card-1');
  assert.equal(receipt.amountMicros, 15000); assert.equal(receipt.feeMicros, 750); assert.equal(receipt.feeBps, 500);
  assert.equal(receipt.providerTransaction, order.receipt.transaction); assert.equal(receipt.feeTransaction, order.feeReceipt.transaction);
  assert.ok(!JSON.stringify(items).includes('signature')); assert.equal(f.provider.providerTransfers, 1);
  await f.api('/api/account/bootstrap', { legacy: null }, 'bob');
  assert.deepEqual((await f.api('/api/account', undefined, 'bob')).data.state.scheduleActivity || [], []);
});

test('skipped windows and agent pause are saved without claiming a payment or repeating an event', async t => {
  const f = await fixture(t), plan = await f.enable({ maxTotalMicros: 15000 }); f.at(plan.firstRunAt + 1000);
  await f.cron(plan.utcHour); await f.cron(plan.utcHour);
  let items = (await f.state()).scheduleActivity;
  assert.equal(items.filter(item => item.kind === 'skipped').length, 1);
  assert.match(items.find(item => item.kind === 'skipped').text, /cap/);
  assert.ok(items.every(item => item.amountMicros === undefined));
  await f.api('/api/actions', { type: 'assistant', cardId: 'card-1', text: 'Pause agent' });
  items = (await f.state()).scheduleActivity;
  assert.equal(items.filter(item => item.kind === 'paused').length, 1);
  assert.equal(f.provider.providerTransfers, 0); assert.equal(f.provider.feeTransfers, 0);
});

test('uncertain schedule delivery stays unconfirmed until the same payment is recovered', async t => {
  const f = await fixture(t), plan = await f.enable(); f.at(plan.firstRunAt + 1000); f.provider.loseProviderResponse = true;
  await f.cron(plan.utcHour);
  const before = await f.state(), checking = before.scheduleActivity.find(item => item.kind === 'checking');
  assert.ok(checking); assert.ok(!before.scheduleActivity.some(item => item.kind === 'completed'));
  assert.equal(checking.amountMicros, undefined); assert.equal(checking.orderId, before.liveOrders[0].id);
  await f.cron(plan.utcHour); await f.cron(plan.utcHour);
  const after = await f.state();
  assert.equal(after.scheduleActivity.filter(item => item.kind === 'completed').length, 1);
  assert.equal(after.scheduleActivity.find(item => item.kind === 'completed').orderId, checking.orderId);
  assert.equal(f.provider.providerTransfers, 1); assert.equal(f.provider.feeTransfers, 1);
});

test('scheduled approval requests appear in saved activity before any payment', async t => {
  const f = await fixture(t); await f.api('/api/actions', { type: 'rules', cardId: 'card-1', name: 'Research agent', perBuy: 5000, perDay: 10000, askAbove: 0, categories: ['Market data'] });
  const plan = await f.enable(); f.at(plan.firstRunAt + 1000); await f.cron(plan.utcHour); await f.cron(plan.utcHour);
  const state = await f.state(), notices = state.scheduleActivity.filter(item => item.kind === 'approval');
  assert.equal(notices.length, 1); assert.equal(notices[0].orderId, state.liveOrders[0].id);
  assert.equal(notices[0].amountMicros, undefined); assert.equal(f.provider.providerTransfers, 0);
});

test('schedule activity presentation escapes text, filters cards and links only saved valid transaction hashes', async () => {
  const { scheduleActivityHTML, newScheduleNotifications } = await import('./shared/schedule-activity.mjs');
  const a = { id: 'a', cardId: 'card-1', kind: 'checking', text: '<img onerror=attack()>', time: 1, orderId: 'live-1', providerTransaction: 'javascript:attack()' };
  const b = { ...a, id: 'b', cardId: 'card-2', text: 'Other card secret' };
  const state = { scheduleActivity: [a, b], liveOrders: [{ id: 'live-1', cardId: 'card-1', status: 'needs_review' }] };
  const html = scheduleActivityHTML(state, 'card-1');
  assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img')); assert.ok(!html.includes('Other card secret'));
  assert.ok(!html.includes('javascript:')); assert.ok(html.includes('Review same order')); assert.ok(!html.includes('View report &amp; receipt'));
  assert.deepEqual(newScheduleNotifications([a], [b, a]), [b]); assert.deepEqual(newScheduleNotifications([a, b], [a, b]), []);
});
