import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { LocalD1 } from './scripts/sqlite-d1.mjs';
import { handleApi } from './server/api.mjs';
import { handleMcp } from './server/mcp.mjs';
import { discountPolicy, publicFeePolicy, commissionQuote } from './server/discounts.mjs';
import { feeFor, commission, consentTypedData } from './shared/commission.mjs';
import { paymentTypedData, liveMarket } from './shared/payment.mjs';
import { signLiveOrder } from './shared/wallet.mjs';
import { MockChainProvider } from './test/fixtures/chain.mjs';
import { gfldFeePolicy, grantfoldToken } from './web/token.mjs';

const token='0x'+'a1'.repeat(20), unit=10n**18n;
const policy=()=>({enabled:true,version:'test-token-v1',chainId:4663,token,decimals:18,tiers:[{minBalance:String(unit),feeBps:400},{minBalance:String(10n*unit),feeBps:300},{minBalance:String(100n*unit),feeBps:0}]});

test('launched GFLD tiers price exact 18-decimal boundary balances without changing provider price', async () => {
 let balance = 0n;
 const holder = '0x' + '21'.repeat(20);
 const provider = { async rpc(method, params) {
  if (method === 'eth_chainId') return '0x1237';
  if (method === 'eth_blockNumber') return '0x123';
  assert.equal(params[0]?.to?.toLowerCase() || params[0]?.toLowerCase(), grantfoldToken.address);
  if (method === 'eth_getCode') return '0x6001';
  assert.equal(params[1], '0x123');
  if (params[0].data === '0x313ce567') return '0x' + (18n).toString(16).padStart(64, '0');
  assert.equal('0x' + params[0].data.slice(-40), holder);
  return '0x' + balance.toString(16).padStart(64, '0');
 }};
 for (const [raw, bps, fee] of [[0n,500,750],[100000n*unit-1n,500,750],[100000n*unit,400,600],[1000000n*unit-1n,400,600],[1000000n*unit,300,450],[10000000n*unit-1n,300,450],[10000000n*unit,200,300]]) {
  balance=raw;
  const q=await commissionQuote(15000,holder,provider,gfldFeePolicy);
  assert.equal(q.feeBps,bps); assert.equal(q.feeMicros,fee); assert.equal(q.totalMicros,15000+fee);
  assert.equal(q.feePolicy.holder,holder); assert.equal(q.feePolicy.token,grantfoldToken.address);
 }
});
async function setup(t,raw=policy()){
 const db=new LocalD1();db.migrate();t.after(()=>db.close());const provider=new MockChainProvider(),owner=privateKeyToAccount(generatePrivateKey()),holdings=new Map(),calls=[];
 const baseRpc=provider.rpc.bind(provider);provider.rpc=async(method,params)=>{calls.push({method,params});if(method==='eth_getCode'&&params[0].toLowerCase()===token)return'0x60016001';if(method==='eth_call'&&params[0].to?.toLowerCase()===token){if(params[0].data==='0x313ce567')return'0x'+(18n).toString(16).padStart(64,'0');return'0x'+(holdings.get('0x'+params[0].data.slice(-40).toLowerCase())||0n).toString(16).padStart(64,'0');}return baseRpc(method,params);};
 const env={DB:db,GRANTFOLD_WALLET_KEY_V1:'ac'.repeat(32),...(raw?{GRANTFOLD_FEE_POLICY:JSON.stringify(raw)}:{})};
 const headers={'content-type':'application/json','oai-authenticated-user-id':'alice','oai-authenticated-user-email':'alice@test.invalid','x-grantfold-client':'browser'};
 async function api(path,body){const r=await handleApi(new Request('https://grantfold.test'+path,{method:body?'POST':'GET',headers:{...headers,'idempotency-key':crypto.randomUUID()},...(body?{body:JSON.stringify(body)}:{})}),env,{marketProvider:provider});return{status:r.status,data:await r.json()};}
 await api('/api/account/bootstrap',{legacy:null});
 const state=async()=> (await api('/api/account')).data.state;
 async function quotePrepare(wallet=owner.address){const quoted=await api('/api/live/quote',{cardId:'card-1'}),orderId=quoted.data.effect.orderId;return api('/api/live/prepare',{orderId,wallet});}
 async function enable(){const r=await api('/api/agent/prepare',{cardId:'card-1',owner:owner.address}),signature=await owner.signTypedData(consentTypedData(r.data.effect.setup,'https://grantfold.test'));return(await api('/api/agent/enable',{cardId:'card-1',signature})).data.state.agents['card-1'];}
 async function buyAgent(){const r=await handleMcp(new Request('https://grantfold.test/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'grantfold_buy_market',arguments:{card_id:'card-1',request_id:crypto.randomUUID(),max_total_micros:15750}}})}),env,{marketProvider:provider});return(await r.json()).result;}
 return{db,provider,owner,env,holdings,calls,api,state,quotePrepare,enable,buyAgent};
}

test('unlaunched token leaves the base 5% unchanged and makes no token RPC call',async()=>{
 const provider={rpc(){throw Error('No token call expected');}};const result=await commissionQuote(15000,'0x'+'11'.repeat(20),provider);
 assert.equal(result.feeBps,500);assert.equal(result.feeMicros,750);assert.equal(result.totalMicros,15750);assert.equal(result.feePolicy.status,'inactive');assert.equal(publicFeePolicy().enabled,false);
 assert.deepEqual(discountPolicy(JSON.stringify({enabled:false,version:'not-launched',chainId:4663,token:null,decimals:null,tiers:[]})).tiers,[]);
});

test('invalid token policy cannot raise fees, redirect the recipient or select another chain',()=>{
 for(const bad of [{...policy(),chainId:8453},{...policy(),feeRecipient:token},{...policy(),token:'0x'+'00'.repeat(20)},{...policy(),tiers:[{minBalance:'1e18',feeBps:400}]},{...policy(),tiers:[{minBalance:'1',feeBps:501}]},{...policy(),tiers:[{minBalance:'1',feeBps:300},{minBalance:'10',feeBps:400}]},{...policy(),tiers:[{minBalance:'1',feeBps:400},{minBalance:'1',feeBps:300}]}])assert.throws(()=>discountPolicy(bad));
 assert.equal(publicFeePolicy('{bad').available,false);assert.equal(feeFor(15000,300),450);assert.equal(feeFor(1,300),1);assert.equal(feeFor(15000,0),0);assert.throws(()=>feeFor(15000,501));
});

test('verified tier thresholds use exact raw balances at one block and charge only the service fee less',async t=>{
 const f=await setup(t);for(const[balance,bps]of[[unit-1n,500],[unit,400],[10n*unit,300],[100n*unit,0]]){f.holdings.set(f.owner.address.toLowerCase(),balance);const q=await commissionQuote(15000,f.owner.address,f.provider,f.env.GRANTFOLD_FEE_POLICY);assert.equal(q.feeBps,bps);assert.equal(q.totalMicros,15000+feeFor(15000,bps));assert.equal(q.feeRecipient,commission.recipient);assert.equal(q.feePolicy.balance,balance.toString());assert.match(q.feePolicy.block,/^0x/);}
 const calls=f.calls.filter(c=>c.method==='eth_call'&&c.params[0].to===token);assert.ok(calls.every(c=>/^0x[0-9a-f]+$/i.test(c.params[1])));
});

test('a discounted manual quote is bound to the paying wallet signature',async t=>{
 const f=await setup(t),rich=privateKeyToAccount(generatePrivateKey());f.holdings.set(rich.address.toLowerCase(),10n*unit);const r=await f.quotePrepare(rich.address),order=r.data.state.liveOrders[0];assert.equal(r.status,200);assert.equal(order.amountMicros,15000);assert.equal(order.feeMicros,450);assert.equal(order.feeAuthorization.value,'450');assert.equal(order.feePolicy.holder,rich.address.toLowerCase());
 const signature=await f.owner.signTypedData(paymentTypedData(order.authorization)),feeSignature=await f.owner.signTypedData(paymentTypedData(order.feeAuthorization));assert.equal((await f.api('/api/live/pay',{orderId:order.id,signature,feeSignature})).status,422);assert.equal(f.provider.providerTransfers,0);
 assert.equal((await f.api('/api/live/prepare',{orderId:order.id,wallet:f.owner.address})).status,409);
});

test('a caller cannot supply its own discounted rate in a payment request',async t=>{
 const f=await setup(t),r=await f.quotePrepare();assert.equal(r.data.state.liveOrders[0].feeBps,500);
 assert.equal((await f.api('/api/live/prepare',{orderId:r.data.state.liveOrders[0].id,wallet:f.owner.address,feeBps:0})).status,422);assert.equal(f.provider.providerTransfers,0);
});

test('an agent receives the linked owner tier, not a claimed token holder address',async t=>{
 const f=await setup(t),grant=await f.enable();f.holdings.set(f.owner.address.toLowerCase(),10n*unit);f.provider.fund(grant.address);const result=await f.buyAgent();assert.equal(result.isError,false,JSON.stringify(result));const order=JSON.parse(result.content[0].text).order;
 assert.equal(order.status,'completed');assert.equal(order.feeBps,300);assert.equal(order.feeMicros,450);assert.equal(order.totalMicros,15450);assert.equal(order.feePolicy.holder,f.owner.address.toLowerCase());assert.equal(f.provider.balance(commission.recipient),450n);assert.equal(f.provider.balance(liveMarket.payTo),15000n);
});

test('Assistant fee preview uses the linked owner balance without making an order or token approval',async t=>{
 const f=await setup(t),grant=await f.enable();f.holdings.set(f.owner.address.toLowerCase(),10n*unit);f.holdings.set(grant.address.toLowerCase(),100n*unit);
 const r=await f.api('/api/actions',{type:'assistant',cardId:'card-1',text:'Какая у меня скидка?'});assert.equal(r.status,200);assert.equal(r.data.effect.agentControl,'fee');
 const answer=r.data.state.messages['card-1'].at(-1).text;assert.match(answer,/3%/);assert.ok(answer.includes(f.owner.address));assert.match(answer,/0\.03 USDG/);
 assert.equal(r.data.state.liveOrders?.length||0,0);assert.equal(f.provider.providerTransfers,0);assert.equal(f.provider.feeTransfers,0);assert.equal(f.provider.broadcasts,0);
});

test('a zero-fee tier delivers the paid provider report without a phantom commission transaction',async t=>{
 const f=await setup(t),grant=await f.enable();f.holdings.set(f.owner.address.toLowerCase(),100n*unit);f.provider.fund(grant.address);const result=await f.buyAgent();assert.equal(result.isError,false,JSON.stringify(result));const order=JSON.parse(result.content[0].text).order;assert.equal(order.status,'completed');assert.equal(order.feeMicros,0);assert.equal(order.totalMicros,15000);assert.equal(f.provider.providerTransfers,1);assert.equal(f.provider.feeTransfers,0);assert.equal(f.provider.broadcasts,0);assert.ok(order.report);
});

test('an enabled discount with unavailable chain data fails before any provider charge',async t=>{
 const f=await setup(t),grant=await f.enable();f.provider.fund(grant.address);const original=f.provider.rpc;f.provider.rpc=(method,params)=>method==='eth_getCode'?Promise.reject(Error('offline')):original(method,params);const result=await f.buyAgent();assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).code,'fee_discount_unavailable');assert.equal(f.provider.providerTransfers,0);assert.equal(f.provider.feeTransfers,0);
});

test('readiness is unpaid and a malformed discount configuration does not lock withdrawals or account login',async t=>{
 const f=await setup(t,null);const ready=await f.api('/api/live/status');assert.equal(ready.status,200);assert.equal(ready.data.chainId,4663);assert.equal(ready.data.quote.totalMicros,15750);assert.equal(ready.data.paidPurchaseVerified,false);assert.equal(f.provider.providerTransfers,0);
 f.env.GRANTFOLD_FEE_POLICY='{invalid';const session=await f.api('/api/session');assert.equal(session.status,200);assert.equal(session.data.fees.available,false);assert.equal((await f.api('/api/account')).status,200);
});


test('the browser signs the exact discounted fee and the server completes that same payment',async t=>{
 const f=await setup(t);f.holdings.set(f.owner.address.toLowerCase(),10n*unit);f.provider.fund(f.owner.address);const prepared=await f.quotePrepare(),order=prepared.data.state.liveOrders[0];let signatures=0;
 const wallet={request:async({method,params})=>{if(method==='eth_accounts')return[f.owner.address];if(method==='eth_chainId')return'0x1237';if(method==='eth_signTypedData_v4'){signatures++;return f.owner.signTypedData(JSON.parse(params[1]));}return f.provider.rpc(method,params);}};
 const signed=await signLiveOrder(order,wallet);assert.equal(signatures,2);assert.ok(signed.signature&&signed.feeSignature);const paid=await f.api('/api/live/pay',{orderId:order.id,...signed});assert.equal(paid.status,200);assert.equal(paid.data.state.liveOrders[0].feeMicros,450);assert.equal(paid.data.state.liveOrders[0].status,'fee_due');assert.equal(f.provider.providerTransfers,1);assert.equal(f.provider.feeTransfers,0);
 const effect=(await f.api('/api/live/fee_transaction',{orderId:order.id})).data.effect,tx=effect.transaction;
 const raw=await f.owner.signTransaction({chainId:4663,type:'legacy',to:tx.to,data:tx.data,value:0n,nonce:0,gas:BigInt(tx.gas),gasPrice:BigInt(tx.gasPrice)}),hash=await f.provider.rpc('eth_sendRawTransaction',[raw]);
 const done=await f.api('/api/live/fee_check',{orderId:order.id,transaction:hash});assert.equal(done.data.state.liveOrders[0].status,'completed');assert.equal(f.provider.balance(commission.recipient),450n);assert.equal(f.provider.providerTransfers,1);
});
