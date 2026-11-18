import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { keccak256, toHex } from 'viem';
import { LocalD1 } from './scripts/sqlite-d1.mjs';
import { AccountStore } from './server/store.mjs';
import { handleApi } from './server/api.mjs';
import { x402ResourceServer } from '@x402/core/server';
import { identifierDeclaration } from './test/fixtures/chain.mjs';
import { MarketProvider, addLiveQuote, prepareLiveOrder, makePaymentPayload } from './server/market.mjs';
import { liveMarket, paymentTypedData, liveTotals, usdg } from './shared/payment.mjs';
import { initialState, categories } from './shared/core.mjs';
import { connectLiveWallet, signLiveOrder } from './shared/wallet.mjs';

const tx = '0x' + '12'.repeat(32), blockHash = '0x' + '34'.repeat(32);
const topicAddress = a => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const offer = () => ({ scheme: 'exact', network: liveMarket.network, amount: '15000', asset: liveMarket.asset, payTo: liveMarket.payTo, maxTimeoutSeconds: 300, extra: { name: 'Global Dollar', version: '1' } });
const report = { currency: 'usd', count: 1, coins: [{ name: 'Bitcoin', symbol: 'btc', price: 65000, change24hPct: 1.5, marketCap: 1e12 }], credit: 'CoinGecko' };
function providerFixture() {
 const config = { quoteOffer: offer(), paidCalls: [], rpcCalls: [], failPurchase: false, receiptPending: false, nonceUsed: false, chain: '0x1237', receiptMutator: r => r };
 const provider = new MarketProvider(async (url, init) => {
  if (url === liveMarket.url) {
   const signature = init.headers['PAYMENT-SIGNATURE'];
   if (!signature) return new Response('{}', { status: 402, headers: { 'payment-required': btoa(JSON.stringify({ x402Version: 2, resource: { url: liveMarket.url }, accepts: [{ ...offer(), network: 'eip155:8453' }, config.quoteOffer] })) } });
   const payload = JSON.parse(atob(signature)); config.paidCalls.push({ header: signature, key: init.headers['Idempotency-Key'], payload });
   if (config.wait) await config.wait;
   if (config.failPurchase) throw Error('Simulated lost response');
   const settlement = { success: true, transaction: tx, network: liveMarket.network, payer: payload.payload.authorization.from };
   if (config.omitPayer) delete settlement.payer;
   return new Response(JSON.stringify(report), { headers: { 'payment-response': btoa(JSON.stringify(settlement)) } });
  }
  assert.equal(url, liveMarket.rpc, 'tests never send a signed payment to a real service');
  const { method } = JSON.parse(init.body); config.rpcCalls.push(method);
  let result;
  if (method === 'eth_chainId') result = config.chain;
  else if (method === 'eth_getBlockByNumber') result = { timestamp: '0x' + (Math.floor(Date.now() / 1000) + 1000).toString(16) };
  else if (method === 'eth_call') result = '0x' + '0'.repeat(63) + (config.nonceUsed ? '1' : '0');
  else if (method === 'eth_getTransactionReceipt') {
   const a = config.paidCalls.at(-1).payload.payload.authorization;
   result = config.receiptPending ? null : config.receiptMutator({ status: '0x1', transactionHash: tx, blockHash, logs: [
    { address: liveMarket.asset, topics: [keccak256(toHex('Transfer(address,address,uint256)')), topicAddress(a.from), topicAddress(a.to)], data: '0x' + BigInt(a.value).toString(16).padStart(64, '0') },
    { address: liveMarket.asset, topics: [keccak256(toHex('AuthorizationUsed(address,bytes32)')), topicAddress(a.from), a.nonce], data: '0x' },
   ] });
  } else throw Error('Unexpected mock RPC: ' + method);
  return Response.json({ jsonrpc: '2.0', id: 1, result });
 });
 // Preserve coverage for fee-free v4 orders already stored before this rollout.
 const currentQuote = provider.quote.bind(provider);
 provider.quote = async () => { const { feeMicros, totalMicros, feeBps, feeRecipient, ...legacy } = await currentQuote(); return legacy; };
 return { config, provider };
}
async function fixture(t, legacy = null) {
 const db = new LocalD1(); db.migrate(); t.after(() => db.close());
 const { config, provider } = providerFixture(), wallet = privateKeyToAccount(generatePrivateKey());
 async function api(route, body, { user = 'alice', key = crypto.randomUUID(), headers = {} } = {}) {
  const response = await handleApi(new Request('https://grantfold.test' + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(user ? { 'oai-authenticated-user-id': user, 'oai-authenticated-user-email': user + '@example.test' } : {}), 'content-type': 'application/json', 'x-grantfold-client': 'browser', 'idempotency-key': key, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { DB: db }, { marketProvider: provider });
  return { status: response.status, data: await response.json() };
 }
 await api('/api/account/bootstrap', { legacy });
 async function ready() {
  const quote = await api('/api/live/quote', { cardId: 'card-1' }); assert.equal(quote.status, 200);
  const orderId = quote.data.effect.orderId;
  const prepared = await api('/api/live/prepare', { orderId, wallet: wallet.address }); assert.equal(prepared.status, 200);
  const order = prepared.data.state.liveOrders.find(o => o.id === orderId), signature = await wallet.signTypedData(paymentTypedData(order.authorization));
  return { orderId, order, signature };
 }
 return { db, config, provider, wallet, api, ready, state: async () => (await api('/api/account')).data.state };
}

test('live quote chooses USDG on Robinhood instead of the first Base offer', async t => {
 const f = await fixture(t), quote = await f.provider.quote();
 assert.equal(quote.accepted.network, 'eip155:4663'); assert.equal(quote.amountMicros, 15000);
 assert.equal(usdg(quote.amountMicros), '0.015 USDG'); assert.equal(f.config.paidCalls.length, 0);
 for (const patch of [{ network: 'eip155:8453' }, { asset: '0x' + '11'.repeat(20) }, { payTo: '0x' + '11'.repeat(20) }, { amount: 15000 }, { amount: '1000001' }, { amount: '-1' }, { amount: '1.5' }, { extra: { name: 'USD Coin', version: '2' } }, { maxTimeoutSeconds: 9999 }]) {
  f.config.quoteOffer = { ...offer(), ...patch }; await assert.rejects(() => f.provider.quote());
 }
});

test('live routes reject anonymous, cross-site, malformed and foreign order access', async t => {
 const f = await fixture(t), ready = await f.ready();
 assert.equal((await f.api('/api/live/quote', { cardId: 'card-1' }, { user: null })).status, 401);
 assert.equal((await f.api('/api/live/quote', { cardId: 'card-1' }, { headers: { origin: 'https://other.test' } })).status, 403);
 for (const body of [{}, { cardId: 'card-1', amountMicros: 1 }, { cardId: null }]) assert.equal((await f.api('/api/live/quote', body)).status, 422);
 await f.api('/api/account/bootstrap', { legacy: null }, { user: 'bob' });
 assert.equal((await f.api('/api/live/prepare', { orderId: ready.orderId, wallet: f.wallet.address }, { user: 'bob' })).status, 404);
 assert.equal((await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature }, { user: 'bob' })).status, 404);
 assert.equal((await f.api('/api/live/check', { orderId: ready.orderId }, { user: 'bob' })).status, 409);
 assert.equal(f.config.paidCalls.length, 0);
});

test('live quote is idempotent and never consumes a simulated card balance', async t => {
 const legacy = initialState(); legacy.cards[0].balance = 0; const f = await fixture(t, legacy), key = crypto.randomUUID();
 const a = await f.api('/api/live/quote', { cardId: 'card-1' }, { key }), b = await f.api('/api/live/quote', { cardId: 'card-1' }, { key });
 assert.equal(a.data.effect.orderId, b.data.effect.orderId); assert.equal(b.data.state.liveOrders.length, 1);
 assert.equal(b.data.state.cards[0].balance, 0); assert.equal(liveTotals(b.data.state, 'card-1').held, 15000);
 assert.equal((await f.api('/api/live/cancel', { orderId: a.data.effect.orderId }, { key })).status, 409);
});

test('fractional-cent live reservations enforce the exact daily budget in parallel', async t => {
 const f = await fixture(t); f.config.quoteOffer.amount = '600000';
 await f.api('/api/actions', { type: 'rules', cardId: 'card-1', name: 'Small budget', perBuy: 100, perDay: 100, askAbove: 0, categories });
 const results = await Promise.all([f.api('/api/live/quote', { cardId: 'card-1' }), f.api('/api/live/quote', { cardId: 'card-1' })]);
 assert.deepEqual(results.map(r => r.status).sort(), [200, 422]);
 assert.equal(liveTotals(await f.state(), 'card-1').held, 600000);
});

test('exact EIP-3009 signature delivers report and verifies payment without debiting demo funds', async t => {
 const f = await fixture(t), ready = await f.ready();
 const result = await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature });
 assert.equal(result.status, 200); const order = result.data.state.liveOrders[0];
 assert.equal(order.status, 'completed'); assert.equal(order.amountMicros, 15000); assert.equal(order.report.coins[0].name, 'Bitcoin');
 assert.equal(order.receipt.transaction, tx); assert.equal(result.data.state.cards[0].balance, 15000);
 assert.deepEqual(liveTotals(result.data.state, 'card-1'), { held: 0, spent: 15000 });
 assert.ok(!JSON.stringify(result.data).includes(ready.signature));
 assert.ok(!JSON.stringify((await f.api('/api/audit')).data).includes(ready.signature));
 const job = await new AccountStore(f.db).paymentJob('alice', ready.orderId); assert.equal(job.payload.payload.signature, ready.signature);
 assert.equal(f.config.paidCalls[0].key, ready.orderId);
 assert.equal(f.config.paidCalls[0].payload.accepted.network, 'eip155:4663');
});

test('wrong signer, amount or domain signatures never reach the paid endpoint', async t => {
 const f = await fixture(t), ready = await f.ready(), other = privateKeyToAccount(generatePrivateKey());
 const data = paymentTypedData(ready.order.authorization);
 const signatures = [await other.signTypedData(data), await f.wallet.signTypedData({ ...data, message: { ...data.message, value: '1' } }), await f.wallet.signTypedData({ ...data, domain: { ...data.domain, chainId: 8453 } }), '0x' + '00'.repeat(65)];
 for (const signature of signatures) assert.equal((await f.api('/api/live/pay', { orderId: ready.orderId, signature })).status, 422);
 assert.equal(f.config.paidCalls.length, 0); assert.equal((await f.state()).liveOrders[0].status, 'ready');
});

test('card freeze, category and limit changes are rechecked immediately before payment', async t => {
 const f = await fixture(t), ready = await f.ready();
 await f.api('/api/actions', { type: 'freeze', cardId: 'card-1', frozen: true });
 assert.equal((await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature })).status, 422);
 await f.api('/api/actions', { type: 'freeze', cardId: 'card-1', frozen: false });
 await f.api('/api/actions', { type: 'rules', cardId: 'card-1', name: 'Research', perBuy: 5000, perDay: 10000, askAbove: 0, categories: ['Developer tools'] });
 assert.equal((await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature })).status, 422);
 assert.equal(f.config.paidCalls.length, 0);
});

test('cancel and wallet changes cannot repurpose an existing authorization', async t => {
 const f = await fixture(t), ready = await f.ready();
 const other = privateKeyToAccount(generatePrivateKey());
 assert.equal((await f.api('/api/live/prepare', { orderId: ready.orderId, wallet: other.address })).status, 409);
 const repeated = await f.api('/api/live/prepare', { orderId: ready.orderId, wallet: f.wallet.address });
 assert.deepEqual(repeated.data.state.liveOrders[0].authorization, ready.order.authorization);
 assert.equal((await f.api('/api/live/cancel', { orderId: ready.orderId })).status, 200);
 assert.equal((await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature })).status, 409);
 assert.equal(f.config.paidCalls.length, 0); assert.equal(liveTotals(await f.state(), 'card-1').held, 0);
});

test('atomic job persistence failure dispatches no payment and leaves order ready for a safe retry', async t => {
 const f = await fixture(t), ready = await f.ready(); f.db.failStatement = 3;
 assert.equal((await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature })).status, 500);
 assert.equal(f.config.paidCalls.length, 0); assert.equal((await f.state()).liveOrders[0].status, 'ready');
 assert.equal(await new AccountStore(f.db).paymentJob('alice', ready.orderId), null);
 assert.equal((await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature })).data.state.liveOrders[0].status, 'completed');
});

test('concurrent submissions dispatch only once and all later retries return the saved report', async t => {
 const f = await fixture(t), ready = await f.ready(); let release;
 f.config.wait = new Promise(r => { release = r; });
 const first = f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature });
 await new Promise(resolve => { const poll = () => f.config.paidCalls.length ? resolve() : setTimeout(poll, 1); poll(); });
 const second = await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature });
 assert.equal(second.data.state.liveOrders[0].status, 'processing'); assert.equal(f.config.paidCalls.length, 1);
 release(); assert.equal((await first).data.state.liveOrders[0].status, 'completed');
 const replay = await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature });
 assert.equal(replay.data.state.liveOrders[0].status, 'completed'); assert.equal(f.config.paidCalls.length, 1);
});

test('lost provider response retains the exact payment and blocks a second order until resolved', async t => {
 const f = await fixture(t), ready = await f.ready(); f.config.failPurchase = true;
 assert.equal((await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature })).data.state.liveOrders[0].status, 'needs_review');
 assert.equal((await f.api('/api/live/quote', { cardId: 'card-1' })).status, 409);
 assert.equal((await f.api('/api/live/cancel', { orderId: ready.orderId })).status, 409);
 assert.equal((await f.api('/api/live/pay', { orderId: ready.orderId, signature: '0x' + '11'.repeat(65) })).status, 409);
 f.config.failPurchase = false;
 const check = await f.api('/api/live/check', { orderId: ready.orderId });
 assert.equal(check.data.state.liveOrders[0].status, 'completed');
 assert.equal(f.config.paidCalls.length, 2); assert.equal(f.config.paidCalls[0].header, f.config.paidCalls[1].header); assert.equal(f.config.paidCalls[0].key, f.config.paidCalls[1].key);
});

test('captured delivery survives chain outage and check retries verification without another paid call', async t => {
 const f = await fixture(t), ready = await f.ready(); f.config.receiptPending = true;
 const result = await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature });
 assert.equal(result.data.state.liveOrders[0].status, 'checking'); assert.equal(liveTotals(result.data.state, 'card-1').held, 15000);
 f.config.receiptPending = false;
 assert.equal((await f.api('/api/live/check', { orderId: ready.orderId })).data.state.liveOrders[0].status, 'completed');
 assert.equal(f.config.paidCalls.length, 1);
});

test('wrong network, reverted receipt, wrong transfer amount or nonce cannot mark order completed', async t => {
 for (const mutate of [r => ({ ...r, status: '0x0' }), r => ({ ...r, transactionHash: '0x' + 'ff'.repeat(32) }), r => ({ ...r, logs: r.logs.slice(0, 1) }), r => { r.logs[0].data = '0x' + '0'.repeat(63) + '1'; return r; }, r => { r.logs[1].topics[2] = '0x' + 'ff'.repeat(32); return r; }]) {
  const f = await fixture(t), ready = await f.ready(); f.config.receiptMutator = mutate;
  assert.equal((await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature })).data.state.liveOrders[0].status, 'checking');
 }
 const f = await fixture(t), ready = await f.ready(); f.config.chain = '0x2105';
 assert.equal((await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature })).data.state.liveOrders[0].status, 'checking');
});

test('non-indexed AuthorizationUsed nonce is verified against the exact signed authorization', async t => {
 const f = await fixture(t), ready = await f.ready();
 f.config.receiptMutator = r => { const event = r.logs[1]; event.data = event.topics.pop(); return r; };
 assert.equal((await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature })).data.state.liveOrders[0].status, 'completed');
});

test('expired unused signed payment releases its reservation after on-chain verification', async t => {
 const f = await fixture(t), ready = await f.ready(); f.config.failPurchase = true;
 await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature });
 const store = new AccountStore(f.db);
 await store.mutate('alice', crypto.randomUUID(), 'expire-fixture', state => { state.liveOrders[0].authorization.validBefore = String(Math.floor(Date.now()/1000)-60); return { state, effect: {}, audit: { kind: 'test_expiry' } }; });
 const result = await f.api('/api/live/check', { orderId: ready.orderId });
 assert.equal(result.data.state.liveOrders[0].status, 'failed'); assert.equal(liveTotals(result.data.state, 'card-1').held, 0);
 assert.equal(f.config.paidCalls.length, 1); assert.ok(f.config.rpcCalls.includes('eth_call'));
});

test('unsigned expired quote does not reserve a new day and cannot be prepared', () => {
 const state = initialState(), quote = { amountMicros: 15000, accepted: offer(), resource: { url: liveMarket.url } };
 addLiveQuote(state, 'card-1', quote, 1000);
 assert.equal(liveTotals(state, 'card-1', 400000).held, 0);
 assert.throws(() => prepareLiveOrder(state, state.liveOrders[0].id, '0x' + '11'.repeat(20), 400000), /expired/);
});

test('account reserves delivery storage before dispatching a real payment', async t => {
 const f = await fixture(t), ready = await f.ready();
 const state = await f.state(); state.testCapacityPadding = 'x'.repeat(1_490_000 - JSON.stringify(state).length);
 f.db.connection.prepare('UPDATE accounts SET state_json = ? WHERE user_id = ?').run(JSON.stringify(state), 'alice');
 const result = await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature });
 assert.equal(result.status, 422); assert.equal(f.config.paidCalls.length, 0);
 assert.equal(await new AccountStore(f.db).paymentJob('alice', ready.orderId), null);
});

test('wallet requires RH, sufficient USDG and unchanged account before any signature', async t => {
 const f = await fixture(t), ready = await f.ready(); let signed = 0, chain = '0x2105', account = f.wallet.address;
 const provider = { async request({ method }) {
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
  if (method === 'eth_chainId') return chain;
  if (method === 'wallet_switchEthereumChain') { chain = '0x1237'; return; }
  if (method === 'eth_call') return '0x1000000';
  if (method === 'eth_signTypedData_v4') { signed++; return ready.signature; }
  throw Error(method);
 } };
 assert.equal(await connectLiveWallet(provider), f.wallet.address); assert.equal(chain, '0x1237');
 assert.equal(await signLiveOrder(ready.order, provider), ready.signature); assert.equal(signed, 1);
 account = '0x' + '11'.repeat(20); await assert.rejects(() => signLiveOrder(ready.order, provider), /account changed/);
 account = f.wallet.address; chain = '0x2105'; await assert.rejects(() => signLiveOrder(ready.order, provider), /network changed/);
 chain = '0x1237'; const poor = { request: p => p.method === 'eth_call' ? Promise.resolve('0x0') : provider.request(p) };
 await assert.rejects(() => signLiveOrder(ready.order, poor), /needs at least/); assert.equal(signed, 1);
 await assert.rejects(() => connectLiveWallet({}), /wallet browser/);
});

// x402 SettleResponse.payer is optional; the on-chain log remains mandatory.
test('optional receipt payer is accepted only with an exact independently verified on-chain transfer', async t => {
 const f = await fixture(t), ready = await f.ready(); f.config.omitPayer = true;
 assert.equal((await f.api('/api/live/pay', { orderId: ready.orderId, signature: ready.signature })).data.state.liveOrders[0].status, 'completed');
});


test('the provider SDK rejects the old incomplete identifier and accepts the full advertised echo',async()=>{
 const validator=new x402ResourceServer(),paymentRequired={extensions:{'payment-identifier':identifierDeclaration}};
 const previous={x402Version:2,extensions:{'payment-identifier':{info:{id:'live-compatibility-test'}}}};
 assert.equal(validator.validateExtensions(paymentRequired,previous).invalidReason,'extension_echo_mismatch');
 const order={id:'live-compatibility-test',resource:{url:liveMarket.url},accepted:offer(),authorization:{},paymentExtensions:structuredClone(paymentRequired.extensions)};
 const payload=makePaymentPayload(order,'0x'+'11'.repeat(65));
 assert.equal(validator.validateExtensions(paymentRequired,payload).valid,true);assert.equal(payload.extensions['payment-identifier'].info.required,false);assert.equal(payload.extensions['payment-identifier'].info.id,order.id);assert.deepEqual(payload.extensions['payment-identifier'].schema,identifierDeclaration.schema);assert.equal(order.paymentExtensions['payment-identifier'].info.id,undefined);
 assert.equal(makePaymentPayload({...order,paymentExtensions:undefined},'signature').extensions,undefined);
});

test('live quote preserves the selected requirement and full resource declaration verbatim',async()=>{
 const accepted={...offer(),outputSchema:{type:'object',properties:{extra:{type:'number'}}}},resource={url:liveMarket.url,mimeType:'application/json',description:'Exact quote metadata',serviceName:'Market',tags:['crypto'],iconUrl:'https://agent402.tools/favicon.png'};
 const declaration={...identifierDeclaration,info:{required:false,context:'preserve-me'}};
 const provider=new MarketProvider(async()=>new Response('{}',{status:402,headers:{'payment-required':btoa(JSON.stringify({x402Version:2,resource,accepts:[{...offer(),network:'eip155:8453'},accepted],extensions:{'payment-identifier':declaration}}))}}));
 const quote=await provider.quote();assert.deepEqual(quote.accepted,accepted);assert.deepEqual(quote.resource,resource);assert.deepEqual(quote.paymentExtensions['payment-identifier'],declaration);
 const signed=makePaymentPayload({...quote,id:'live-compatibility-test'},'signature');assert.equal(new x402ResourceServer().validateExtensions({extensions:{'payment-identifier':declaration}},signed).valid,true);
});

test('provider refusals retain safe protocol diagnostics without exposing signed headers',async()=>{
 const signature='0x'+'ab'.repeat(65),provider=new MarketProvider(async()=>new Response(JSON.stringify({reason:'unclassified',hint:signature}),{status:402,headers:{'payment-required':btoa(JSON.stringify({error:'extension_echo_mismatch'})),'retry-after':'5'}}));
 await assert.rejects(()=>provider.purchase({id:'live-refusal-test'},{x402Version:2,accepted:offer(),payload:{signature,authorization:{}}}),e=>{assert.equal(e.providerReason,'extension_echo_mismatch');assert.equal(e.providerStatus,402);assert.equal(e.retryAfter,5);assert.ok(!JSON.stringify(e).includes(signature));return true;});
});

test('payment headers encode non-ASCII provider resource metadata as UTF-8',async()=>{
 let decoded;const provider=new MarketProvider(async(url,init)=>{decoded=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(init.headers['PAYMENT-SIGNATURE']),c=>c.charCodeAt(0))));return new Response('{}',{status:402});});
 await assert.rejects(()=>provider.purchase({id:'live-utf8-test'},{x402Version:2,resource:{url:liveMarket.url,description:'Market — обзор'},accepted:offer(),payload:{signature:'test'}}));assert.equal(decoded.resource.description,'Market — обзор');
});


test('a provider balance refusal becomes a safe diagnostic code without saving balance text',async()=>{
 const provider=new MarketProvider(async()=>new Response(JSON.stringify({hint:'simulation refused'}),{status:402,headers:{'payment-required':btoa(JSON.stringify({error:'Payer balance 0 is less than the authorized 15000'}))}}));
 await assert.rejects(()=>provider.purchase({id:'live-balance-test'},{x402Version:2,payload:{signature:'temporary'}}),e=>{assert.equal(e.providerReason,'insufficient_funds');assert.ok(!JSON.stringify(e).includes('Payer balance'));return true;});
});
