import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { LocalD1 } from './scripts/sqlite-d1.mjs';
import { handleApi } from './server/api.mjs';
import { consentTypedData, withdrawalTypedData } from './shared/commission.mjs';
import { MockChainProvider } from './test/fixtures/chain.mjs';
import { formatMicros, formatEth, confirmedAgentSpend } from './shared/card-balance.mjs';

async function fixture(t,setupWallet=true){
 const db=new LocalD1();db.migrate();t.after(()=>db.close());const provider=new MockChainProvider(),owner=privateKeyToAccount(generatePrivateKey()),env={DB:db,GRANTFOLD_WALLET_KEY_V1:'da'.repeat(32)};
 async function api(path,body,user='alice'){
  const headers={'content-type':'application/json','x-grantfold-client':'browser','idempotency-key':crypto.randomUUID(),...(user?{'oai-authenticated-user-id':user,'oai-authenticated-user-email':user+'@test.example'}:{})};
  const r=await handleApi(new Request('https://grantfold.test'+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{marketProvider:provider});return{status:r.status,data:await r.json()};
 }
 await api('/api/account/bootstrap',{legacy:null});let address;
 if(setupWallet){const setup=(await api('/api/agent/prepare',{cardId:'card-1',owner:owner.address})).data.effect.setup;address=setup.address;await api('/api/agent/enable',{cardId:'card-1',signature:await owner.signTypedData(consentTypedData(setup,'https://grantfold.test'))});provider.fund(address);}
 const balance=()=>api('/api/cards/balance',{cardId:'card-1'}),state=async()=> (await api('/api/account')).data.state;
 const quote=async()=> (await api('/api/actions',{type:'assistant',cardId:'card-1',text:'Buy a live market overview'})).data.effect.orderId;
 return {db,env,provider,owner,api,address,balance,state,quote};
}

test('a card without a wallet reports not_setup, never its demo balance, and creates no key',async t=>{
 const f=await fixture(t,false);f.provider.rpc=()=>{throw Error('No RPC should be called');};
 const before=await f.state(),r=await f.balance();assert.equal(r.status,200);assert.equal(r.data.status,'not_setup');assert.equal(r.data.usdgMicros,undefined);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM agent_wallets').first()).n,0);assert.deepEqual(await f.state(),before);
});

test('real agent balance is read at one block and contains only public fields',async t=>{
 const f=await fixture(t),calls=[],rpc=f.provider.rpc.bind(f.provider);f.provider.rpc=(method,params)=>{calls.push([method,params]);return rpc(method,params);};
 const before=await f.state(),r=await f.balance();assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.availableMicros,'1000000');assert.equal(r.data.reservedMicros,'0');assert.equal(r.data.spentTodayMicros,'0');assert.equal(r.data.address,f.address);
 const block='0x'+BigInt(r.data.blockNumber).toString(16);for(const [method,params] of calls)if(['eth_call','eth_getBalance'].includes(method))assert.equal(params[1],block);
 assert.ok(!JSON.stringify(r.data).includes('encrypted_key'));assert.ok(!JSON.stringify(r.data).includes('signature'));assert.equal(f.provider.broadcasts,0);assert.deepEqual(await f.state(),before);
});

test('pending quotes reserve only the agent wallet, excluding manual purchases and demo holds',async t=>{
 const f=await fixture(t);await f.quote();await f.api('/api/live/quote',{cardId:'card-1'});await f.api('/api/actions',{type:'purchase',cardId:'card-1',itemId:'market'});
 const r=await f.balance();assert.equal(r.data.reservedMicros,'15750');assert.equal(r.data.availableMicros,'984250');assert.equal(r.data.usdgMicros,'1000000');assert.equal(f.provider.providerTransfers,0);
});

test('a settled but unconfirmed provider authorization is not subtracted from the wallet twice',async t=>{
 const f=await fixture(t),id=await f.quote();f.provider.loseProviderResponse=true;await f.api('/api/agent/check',{orderId:id});
 let r=await f.balance();assert.equal(r.data.usdgMicros,'985000');assert.equal(r.data.reservedMicros,'750');assert.equal(r.data.availableMicros,'984250');assert.equal(r.data.spentTodayMicros,'0');
 await f.api('/api/agent/check',{orderId:id});r=await f.balance();assert.equal(r.data.usdgMicros,'984250');assert.equal(r.data.reservedMicros,'0');assert.equal(r.data.availableMicros,'984250');assert.equal(r.data.spentTodayMicros,'15750');
 assert.equal(f.provider.providerTransfers,1);assert.equal(f.provider.feeTransfers,1);
});

test('real deposits are visible without an account mutation or simulated top-up',async t=>{
 const f=await fixture(t),before=await f.state();f.provider.fund(f.address,4250n,18284826296000n);
 const r=await f.balance();assert.equal(r.data.usdgMicros,'4250');assert.equal(r.data.availableMicros,'4250');assert.equal(r.data.ethWei,'18284826296000');assert.deepEqual(await f.state(),before);
 assert.equal(f.provider.providerTransfers,0);assert.equal(f.provider.broadcasts,0);
});

test('prepared USDG returns reserve real funds and cancellation releases the reservation',async t=>{
 const f=await fixture(t),r=await f.api('/api/agent/withdraw_prepare',{cardId:'card-1',asset:'USDG',amount:'0.02'});assert.equal(r.status,200);
 let b=await f.balance();assert.equal(b.data.reservedMicros,'20000');assert.equal(b.data.availableMicros,'980000');
 await f.api('/api/agent/withdraw_cancel',{withdrawalId:r.data.effect.withdrawal.id});b=await f.balance();assert.equal(b.data.reservedMicros,'0');assert.equal(f.provider.broadcasts,0);
});

test('an on-chain USDG return is not deducted again while its receipt is awaiting reconciliation',async t=>{
 const f=await fixture(t),prepared=await f.api('/api/agent/withdraw_prepare',{cardId:'card-1',asset:'USDG',amount:'0.02'}),w=prepared.data.effect.withdrawal;
 f.provider.pendingReceipt=true;
 await f.api('/api/agent/withdraw',{withdrawalId:w.id,signature:await f.owner.signTypedData(withdrawalTypedData(w,'https://grantfold.test'))});
 f.provider.pendingReceipt=false;const b=await f.balance();assert.equal(b.data.usdgMicros,'980000');assert.equal(b.data.availableMicros,'980000');assert.equal(b.data.reservedMicros,'0');assert.equal(b.data.spentTodayMicros,'0');
});

test('a low wallet balance never produces negative available funds or credits from the demo',async t=>{
 const f=await fixture(t);await f.quote();f.provider.fund(f.address,1n);
 const r=await f.balance();assert.equal(r.data.reservedMicros,'15750');assert.equal(r.data.availableMicros,'0');assert.equal(r.data.usdgMicros,'1');
});

test('outages, wrong network and unreadable reservations fail without inventing a zero balance',async t=>{
 const f=await fixture(t);await f.quote();await f.api('/api/agent/check',{orderId:(await f.state()).liveOrders[0].id});
 f.provider.rpc=async()=>{throw Error('RPC unavailable');};assert.equal((await f.balance()).status,503);
 f.provider.rpc=async()=> '0x1';const r=await f.balance();assert.equal(r.status,503);assert.equal(r.data.usdgMicros,undefined);assert.equal(r.data.availableMicros,undefined);
});

test('card balance API rejects anonymous/foreign access and request overrides',async t=>{
 const f=await fixture(t);assert.equal((await f.api('/api/cards/balance',{cardId:'card-1'},null)).status,401);assert.equal((await f.api('/api/cards/balance',{cardId:'foreign'})).status,404);
 assert.equal((await f.api('/api/cards/balance',{cardId:'card-1',owner:f.owner.address})).status,422);
 await f.api('/api/account/bootstrap',{legacy:null},'bob');const r=await f.api('/api/cards/balance',{cardId:'card-1'},'bob');assert.equal(r.data.status,'not_setup');assert.equal(r.data.address,undefined);
});

test('paused or frozen cards remain readable without changing their permissions',async t=>{
 const f=await fixture(t);await f.api('/api/agent/revoke',{cardId:'card-1'});await f.api('/api/actions',{type:'freeze',cardId:'card-1',frozen:true});
 const before=await f.state(),r=await f.balance();assert.equal(r.data.availableMicros,'1000000');assert.deepEqual(await f.state(),before);assert.equal(f.provider.broadcasts,0);
});

test('USDG and ETH formatting preserves tiny values and balances above Number precision',()=>{
 assert.equal(formatMicros('0'),'0.00');assert.equal(formatMicros('1'),'0.000001');assert.equal(formatMicros('4250'),'0.00425');assert.equal(formatMicros('1000000'),'1.00');assert.equal(formatMicros('9007199254740993'),'9,007,199,254.740993');
 assert.equal(formatEth('18284826296000'),'0.000018284826296');assert.equal(formatEth('1'),'0.000000000000000001');
});

test('spent today includes verified agent provider/fee transfers only',()=>{
 const now=Date.now(),address='0x'+'11'.repeat(20),receipt={transaction:'0x'+'22'.repeat(32)},order={cardId:'c',agent:true,amountMicros:15000,feeMicros:750,authorization:{from:address},providerReceipt:receipt,feeReceipt:receipt,providerCompletedAt:now,completedAt:now};
 const state={liveOrders:[order,{...order,agent:false},{...order,cardId:'other'},{...order,providerReceipt:null,feeReceipt:null},{...order,providerCompletedAt:now-86400000,completedAt:now-86400000}]};
 assert.equal(confirmedAgentSpend(state,'c',address,now),'15750');
});

test('unreadable pending nonce state hides the entire balance instead of overstating availability',async t=>{
 const f=await fixture(t),id=await f.quote();f.provider.loseProviderResponse=true;await f.api('/api/agent/check',{orderId:id});
 const rpc=f.provider.rpc.bind(f.provider);f.provider.rpc=(method,params)=>method==='eth_call'&&!params[0].data.startsWith('0x70a08231')?Promise.resolve('0x123'):rpc(method,params);
 const r=await f.balance();assert.equal(r.status,503);assert.equal(r.data.availableMicros,undefined);assert.equal(f.provider.providerTransfers,1);assert.equal(f.provider.feeTransfers,0);
});
