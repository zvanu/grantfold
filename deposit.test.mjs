import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { keccak256, toHex } from 'viem';
import { LocalD1 } from './scripts/sqlite-d1.mjs';
import { handleApi } from './server/api.mjs';
import { depositUnits, depositTransaction, requestDeposit } from './shared/deposit.mjs';
import { verifyDeposit } from './server/deposits.mjs';
import { liveMarket } from './shared/payment.mjs';
import { MockChainProvider } from './test/fixtures/chain.mjs';

const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topic=address=>'0x'+address.slice(2).toLowerCase().padStart(64,'0');
async function fixture(t){
 const db=new LocalD1();db.migrate();t.after(()=>db.close());const provider=new MockChainProvider(),owner=privateKeyToAccount(generatePrivateKey()),origin='https://grantfold.test',jar=new Map();
 const env={DB:db,AUTH_MODE:'wallet',GRANTFOLD_SITE_ORIGIN:origin,GRANTFOLD_WALLET_KEY_V1:'ed'.repeat(32)},transactions=new Map();
 const rpc=provider.rpc.bind(provider);provider.rpc=async(method,params)=>{
  if(method==='eth_getTransactionByHash')return transactions.get(params[0])||null;
  if(method==='eth_getBlockByNumber'&&params[0]!=='latest'){const r=[...provider.receipts.values()].find(r=>r.blockNumber===params[0]);return r?{hash:r.blockHash,number:r.blockNumber}:null;}
  return rpc(method,params);
 };
 async function api(path,body,key=crypto.randomUUID(),cookies=jar){
  const headers={'content-type':'application/json','x-grantfold-client':'browser',origin,'idempotency-key':key,cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')};
  const r=await handleApi(new Request(origin+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{marketProvider:provider});
  for(const raw of r.headers.getSetCookie()){const first=raw.split(';')[0],at=first.indexOf('=');cookies.set(first.slice(0,at),first.slice(at+1));}
  return {status:r.status,data:await r.json()};
 }
 async function login(account,cookies=jar){const q=await api('/api/auth/challenge',{address:account.address},undefined,cookies);await api('/api/auth/verify',{id:q.data.id,signature:await account.signMessage({message:q.data.message})},undefined,cookies);await api('/api/account/bootstrap',{legacy:null},undefined,cookies);}
 await login(owner);const setup=(await api('/api/agent/prepare',{cardId:'card-1',owner:owner.address})).data.effect.setup;provider.fund(setup.address,0n,0n);
 const state=async()=> (await api('/api/account')).data.state;
 async function prepare(asset='USDG',amount='0.05',key){const r=await api('/api/deposit/prepare',{cardId:'card-1',asset,amount},key);assert.equal(r.status,200,JSON.stringify(r.data));return r.data.state.deposits.find(d=>d.id===r.data.effect.depositId);}
 function seed(d,{pending=false,reverted=false,txPatch={},logPatch={}}={}){
  const hash=keccak256(toHex(crypto.randomUUID())),request=depositTransaction(d),logs=d.asset==='USDG'?[{address:liveMarket.asset,topics:[transfer,topic(d.from),topic(d.to)],data:'0x'+BigInt(d.amountUnits).toString(16).padStart(64,'0'),...logPatch}]:[];
  const receipt=provider.receipt(hash,logs,d.from);if(reverted)receipt.status='0x0';
  transactions.set(hash,{hash,from:request.from,to:request.to,value:request.value,input:request.data,blockHash:receipt.blockHash,...txPatch});
  if(pending)provider.receipts.delete(hash);
  return hash;
 }
 return {db,provider,owner,jar,api,login,prepare,state,seed,address:setup.address,transactions};
}

test('USDG/ETH deposit amounts use exact units and refuse excess precision, negatives and oversized amounts',()=>{
 assert.equal(depositUnits('USDG','0.000001'),'1');assert.equal(depositUnits('ETH','0.000000000000000001'),'1');assert.equal(depositUnits('USDG','1000'),'1000000000');
 for(const [asset,amount] of [['USDG','0.0000001'],['USDG','0'],['USDG','-1'],['USDG','1,000'],['USDG','1000.01'],['ETH','0.100000000000000001'],['USDC','1']])assert.throws(()=>depositUnits(asset,amount));
});

test('deposit preparation binds the authenticated sender and agent address without crediting or creating money',async t=>{
 const f=await fixture(t),before=await f.state(),d=await f.prepare();assert.equal(d.from,f.owner.address);assert.equal(d.to,f.address);assert.equal(d.chainId,4663);assert.equal(d.amountUnits,'50000');assert.equal(d.status,'prepared');
 const balance=await f.api('/api/cards/balance',{cardId:'card-1'});assert.equal(balance.data.usdgMicros,'0');assert.deepEqual((await f.state()).agents,before.agents);assert.equal(f.provider.broadcasts,0);
});

test('same-key and concurrent start requests grant exactly one wallet dispatch',async t=>{
 const f=await fixture(t),d=await f.prepare(),key=crypto.randomUUID();
 const r=await Promise.all([f.api('/api/deposit/start',{depositId:d.id},key),f.api('/api/deposit/start',{depositId:d.id},key),f.api('/api/deposit/start',{depositId:d.id})]);
 assert.equal(r.filter(r=>r.data.effect?.maySend).length,1);assert.equal((await f.api('/api/deposit/start',{depositId:d.id},key)).data.effect.maySend,false);assert.equal(f.provider.broadcasts,0);
});

test('a repeated prepare reuses the existing unresolved intent instead of arming a second transfer',async t=>{
 const f=await fixture(t),d=await f.prepare();await f.api('/api/deposit/start',{depositId:d.id});const again=await f.prepare('ETH','0.00002');assert.equal(again.id,d.id);assert.equal(again.asset,'USDG');assert.equal((await f.state()).deposits.length,1);
});

test('expired reviews cannot start a wallet request and can be replaced with a fresh intent',async t=>{
 const f=await fixture(t),d=await f.prepare(),original=Date.now;t.mock.method(Date,'now',()=>original()+301000);
 assert.equal((await f.api('/api/deposit/start',{depositId:d.id})).status,422);assert.notEqual((await f.prepare()).id,d.id);
});

test('cancel/reset requires an explicit no-transfer check after a wallet request and never cancels a tracked hash',async t=>{
 const f=await fixture(t),d=await f.prepare();await f.api('/api/deposit/start',{depositId:d.id});assert.equal((await f.api('/api/deposit/cancel',{depositId:d.id})).status,409);
 assert.equal((await f.api('/api/deposit/cancel',{depositId:d.id,confirmNoTransfer:true})).status,200);
 const next=await f.prepare();await f.api('/api/deposit/start',{depositId:next.id});await f.api('/api/deposit/check',{depositId:next.id,transaction:'0x'+'11'.repeat(32)});
 assert.equal((await f.api('/api/deposit/cancel',{depositId:next.id,confirmNoTransfer:true})).status,409);
});

for(const asset of ['USDG','ETH'])test(`${asset}: confirmed transfer is verified on chain once; checking never sends another transaction`,async t=>{
 const f=await fixture(t),d=await f.prepare(asset,asset==='USDG'?'0.05':'0.00002');await f.api('/api/deposit/start',{depositId:d.id});const hash=f.seed(d);
 const r=await f.api('/api/deposit/check',{depositId:d.id,transaction:hash});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.state.deposits[0].status,'confirmed');
 assert.equal((await f.api('/api/deposit/check',{depositId:d.id,transaction:hash})).status,200);assert.equal((await f.state()).deposits.length,1);assert.equal(f.provider.broadcasts,0);assert.equal(f.provider.providerTransfers,0);
});

test('pending/unknown hashes never produce confirmed deposits; the same hash can be reconciled later',async t=>{
 const f=await fixture(t),d=await f.prepare();await f.api('/api/deposit/start',{depositId:d.id});const hash=f.seed(d),receipt=f.provider.receipts.get(hash);f.provider.receipts.delete(hash);
 let r=await f.api('/api/deposit/check',{depositId:d.id,transaction:hash});assert.equal(r.data.state.deposits[0].status,'checking');f.provider.receipts.set(hash,receipt);
 r=await f.api('/api/deposit/check',{depositId:d.id,transaction:hash});assert.equal(r.data.state.deposits[0].status,'confirmed');assert.equal(f.provider.broadcasts,0);
});

test('wrong sender, recipient, calldata, value, token or transfer amount are never accepted as a deposit',async t=>{
 const f=await fixture(t),d=await f.prepare();
 const bad='0x'+'33'.repeat(20);
 for(const patch of [{txPatch:{from:bad}},{txPatch:{to:bad}},{txPatch:{value:'0x1'}},{txPatch:{input:'0x'}},{logPatch:{address:bad}},{logPatch:{data:'0x'+(49999n).toString(16).padStart(64,'0')}}])await assert.rejects(()=>verifyDeposit(d,f.seed(d,patch),f.provider));
});

test('reverted or noncanonical receipts never claim successful funding',async t=>{
 const f=await fixture(t),d=await f.prepare();assert.equal((await verifyDeposit(d,f.seed(d,{reverted:true}),f.provider)).status,'failed');
 const hash=f.seed(d),rpc=f.provider.rpc.bind(f.provider);f.provider.rpc=(method,params)=>method==='eth_getBlockByNumber'?Promise.resolve({hash:'0x'+'44'.repeat(32)}):rpc(method,params);await assert.rejects(()=>verifyDeposit(d,hash,f.provider));
});

test('a transaction cannot be attached to two deposit intents',async t=>{
 const f=await fixture(t),first=await f.prepare();await f.api('/api/deposit/start',{depositId:first.id});const hash=f.seed(first);await f.api('/api/deposit/check',{depositId:first.id,transaction:hash});
 const second=await f.prepare();await f.api('/api/deposit/start',{depositId:second.id});assert.equal((await f.api('/api/deposit/check',{depositId:second.id,transaction:hash})).status,409);
});

test('deposit APIs reject anonymous callers, foreign wallets/cards and payment-field overrides',async t=>{
 const f=await fixture(t),d=await f.prepare(),emptyJar=new Map();assert.equal((await f.api('/api/deposit/prepare',{cardId:'card-1',asset:'USDG',amount:'0.05'},undefined,emptyJar)).status,401);
 assert.equal((await f.api('/api/deposit/prepare',{cardId:'foreign',asset:'USDG',amount:'0.05'})).status,404);
 assert.equal((await f.api('/api/deposit/prepare',{cardId:'card-1',asset:'USDG',amount:'0.05',to:'0x'+'11'.repeat(20)})).status,422);
 const bob=privateKeyToAccount(generatePrivateKey()),bobJar=new Map();await f.login(bob,bobJar);assert.equal((await f.api('/api/deposit/start',{depositId:d.id},undefined,bobJar)).status,404);
});

test('wallet sender dispatches the reviewed exact transfer once and recovery/replay has no send side effect',async t=>{
 const f=await fixture(t),d=await f.prepare(),sent=[];
 const provider={request:async({method,params})=>{if(method==='eth_accounts')return[f.owner.address];if(method==='eth_chainId')return'0x1237';if(method==='eth_sendTransaction'){sent.push(params[0]);return'0x'+'ab'.repeat(32);}throw Error('Unexpected wallet method');}};
 const claim=async()=> (await f.api('/api/deposit/start',{depositId:d.id})).data.effect.maySend;
 const first=await requestDeposit(d,f.owner.address,f.address,provider,claim);assert.ok(first.transaction);assert.deepEqual(sent,[depositTransaction(d)]);
 const retry=await requestDeposit(d,f.owner.address,f.address,provider,claim);assert.ok(retry.recoveryRequired);assert.equal(sent.length,1);
});

test('wallet account/network changes and changed recipient stop before an unintended transfer',async t=>{
 const f=await fixture(t),d=await f.prepare();let sent=0,claimed=false,reads=0;
 const provider={request:async({method})=>{if(method==='eth_accounts')return[f.owner.address];if(method==='eth_chainId')return++reads===1?'0x1237':'0x1';if(method==='eth_sendTransaction'){sent++;return'0x'+'11'.repeat(32);}}};
 await assert.rejects(()=>requestDeposit(d,f.owner.address,f.address,provider,async()=>{claimed=true;return true;}));assert.ok(claimed);assert.equal(sent,0);
 await assert.rejects(()=>requestDeposit(d,f.owner.address,'0x'+'11'.repeat(20),provider,async()=>true));assert.equal(sent,0);
});

test('a lost wallet response leaves the dispatch claimed and can never be automatically resent',async t=>{
 const f=await fixture(t),d=await f.prepare();let sent=0;
 const provider={request:async({method})=>{if(method==='eth_accounts')return[f.owner.address];if(method==='eth_chainId')return'0x1237';if(method==='eth_sendTransaction'){sent++;throw Error('Lost wallet response');}}};
 const claim=async()=> (await f.api('/api/deposit/start',{depositId:d.id})).data.effect.maySend;
 await assert.rejects(()=>requestDeposit(d,f.owner.address,f.address,provider,claim));assert.ok((await requestDeposit(d,f.owner.address,f.address,provider,claim)).recoveryRequired);assert.equal(sent,1);
});
