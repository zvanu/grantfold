import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { LocalD1 } from './scripts/sqlite-d1.mjs';
import { handleApi } from './server/api.mjs';
import { consentTypedData } from './shared/commission.mjs';
import { paymentTypedData } from './shared/payment.mjs';
import { MockChainProvider } from './test/fixtures/chain.mjs';
import { MarketProvider } from './server/market.mjs';
import { productRequest, normalizeToolReport } from './server/products.mjs';
import { productInputHTML, productResultHTML } from './shared/product-view.mjs';
import { gfldFeePolicy } from './web/token.mjs';
import { scheduledOrderAllowed } from './server/schedule-rules.mjs';

const inputs = {compute:{language:'python',code:'print(2 + 2)'},research:{query:'Robinhood Chain'}};
async function fixture(t) {
 const db=new LocalD1();db.migrate();t.after(()=>db.close());
 const provider=new MockChainProvider(),owner=privateKeyToAccount(generatePrivateKey()),env={DB:db,GRANTFOLD_WALLET_KEY_V1:'ac'.repeat(32)};
 async function api(path,body,user='alice',key=crypto.randomUUID()) {
  const headers={'content-type':'application/json','x-grantfold-client':'browser','idempotency-key':key,...(user?{'oai-authenticated-user-id':user,'oai-authenticated-user-email':user+'@test.example'}:{})};
  const r=await handleApi(new Request('https://grantfold.test'+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{marketProvider:provider});return {status:r.status,data:await r.json()};
 }
 await api('/api/account/bootstrap',{legacy:null});
 const setup=(await api('/api/agent/prepare',{cardId:'card-1',owner:owner.address})).data.effect.setup;
 await api('/api/agent/enable',{cardId:'card-1',signature:await owner.signTypedData(consentTypedData(setup,'https://grantfold.test'))});provider.fund(setup.address);provider.fund(owner.address);
 const quote=(productId='compute',extra={},key)=>api('/api/services/quote',{cardId:'card-1',productId,input:inputs[productId],agent:true,...extra},'alice',key);
 const state=async()=> (await api('/api/account')).data.state;
 return {db,provider,env,owner,api,quote,state,address:setup.address};
}
for(const productId of ['compute','research']) test(`${productId}: quote is unpaid; agent pays exact provider price and fee once; receipt survives replay`,async t=>{
 const f=await fixture(t),key=crypto.randomUUID(),q=await f.quote(productId,{},key);assert.equal(q.status,200,JSON.stringify(q.data));
 const id=q.data.effect.orderId,order=q.data.state.liveOrders[0],price=productId==='compute'?20000:10000;
 assert.equal(order.productId,productId);assert.equal(order.amountMicros,price);assert.equal(order.feeMicros,price/20);assert.deepEqual(order.input,inputs[productId]);
 assert.equal(f.provider.providerTransfers,0);assert.equal((await f.quote(productId,{},key)).data.effect.orderId,id);
 await f.api('/api/agent/check',{orderId:id});await f.api('/api/agent/check',{orderId:id});
 const paid=(await f.state()).liveOrders[0];assert.equal(paid.status,'completed');assert.equal(paid.report.kind,productId);assert.ok(paid.feeReceipt.transaction);
 assert.equal(f.provider.providerTransfers,1);assert.equal(f.provider.feeTransfers,1);assert.equal((await f.state()).liveOrders.length,1);
 if(productId==='compute')assert.equal(paid.report.stdout,'4\n');else assert.equal(paid.report.results[0].url,'https://docs.robinhood.com/');
});

test('new services enforce their own category, not the market overview category',async t=>{
 const f=await fixture(t);await f.api('/api/actions',{type:'rules',cardId:'card-1',name:'Code agent',perBuy:5000,perDay:10000,askAbove:2500,categories:['AI & compute']});
 const q=await f.quote();assert.equal(q.status,200);assert.equal((await f.quote('research')).status,422);
 await f.api('/api/actions',{type:'rules',cardId:'card-1',name:'Code agent',perBuy:5000,perDay:10000,askAbove:2500,categories:['Market data']});
 const pay=await f.api('/api/agent/check',{orderId:q.data.effect.orderId});assert.equal(pay.status,422);assert.equal(f.provider.providerTransfers,0);
});

test('new service quote refuses anonymous/foreign accounts, overrides, unknown products and changed request-key bodies',async t=>{
 const f=await fixture(t),body={cardId:'card-1',productId:'compute',input:inputs.compute,agent:true},key=crypto.randomUUID();
 assert.equal((await f.api('/api/services/quote',body,null)).status,401);
 assert.equal((await f.quote('compute',{cardId:'foreign'})).status,404);
 for(const extra of [{url:'https://evil.test'},{input:{...inputs.compute,url:'https://evil.test'}},{productId:'constructor'},{productId:'rpc'},{input:{language:'shell',code:'echo hi'}},{input:{language:'python',code:''}},{input:{language:'python',code:'x'.repeat(10001)}}])assert.equal((await f.quote('compute',extra)).status,422);
 await f.quote('compute',{},key);assert.equal((await f.quote('compute',{input:{...inputs.compute,code:'print(9)'}},key)).status,409);
 assert.equal(f.provider.providerTransfers,0);
});

test('lost code execution response recovers the exact saved task and never buys a second run',async t=>{
 const f=await fixture(t),q=await f.quote(),id=q.data.effect.orderId;f.provider.loseProviderResponse=true;
 await f.api('/api/agent/check',{orderId:id});let order=(await f.state()).liveOrders[0];assert.equal(order.status,'needs_review');assert.equal(order.report,undefined);assert.equal(f.provider.feeTransfers,0);
 await f.api('/api/agent/check',{orderId:id});order=(await f.state()).liveOrders[0];assert.equal(order.status,'completed');assert.equal(f.provider.providerTransfers,1);assert.equal(f.provider.feeTransfers,1);
 assert.deepEqual(order.input,inputs.compute);
});

test('service approvals and freeze stop provider charges before confirmation',async t=>{
 const f=await fixture(t);await f.api('/api/actions',{type:'rules',cardId:'card-1',name:'Code agent',perBuy:5000,perDay:10000,askAbove:0,categories:['AI & compute']});
 const q=await f.quote(),id=q.data.effect.orderId;assert.equal(q.data.state.liveOrders[0].status,'agent_approval');
 await f.api('/api/agent/check',{orderId:id});assert.equal(f.provider.providerTransfers,0);
 await f.api('/api/actions',{type:'freeze',cardId:'card-1',frozen:true});assert.equal((await f.api('/api/agent/approve',{orderId:id})).status,422);assert.equal(f.provider.providerTransfers,0);
});

test('code execution keeps verified GFLD holder fees and exact USDG precision',async t=>{
 const f=await fixture(t);f.env.GRANTFOLD_FEE_POLICY=JSON.stringify(gfldFeePolicy);const rpc=f.provider.rpc.bind(f.provider);
 f.provider.rpc=async(method,params)=>{
  if(method==='eth_getCode'&&params[0]===gfldFeePolicy.token)return '0x6001';
  if(method==='eth_call'&&params[0].to===gfldFeePolicy.token)return '0x'+(params[0].data==='0x313ce567'?18n:1000000n*10n**18n).toString(16).padStart(64,'0');
  return rpc(method,params);
 };
 const q=await f.quote();assert.equal(q.data.state.liveOrders[0].feeBps,300);assert.equal(q.data.state.liveOrders[0].feeMicros,600);
 await f.api('/api/agent/check',{orderId:q.data.effect.orderId});assert.equal((await f.state()).liveOrders[0].totalMicros,20600);
});

test('manual code quote does not expose a result before the separate service fee settles',async t=>{
 const f=await fixture(t),q=await f.quote('compute',{agent:false}),id=q.data.effect.orderId;
 const prepared=await f.api('/api/live/prepare',{orderId:id,wallet:f.owner.address}),order=prepared.data.state.liveOrders[0];
 const signature=await f.owner.signTypedData(paymentTypedData(order.authorization)),feeSignature=await f.owner.signTypedData(paymentTypedData(order.feeAuthorization));
 const paid=await f.api('/api/live/pay',{orderId:id,signature,feeSignature});assert.equal(paid.status,200,JSON.stringify(paid.data));
 assert.equal(paid.data.state.liveOrders[0].status,'fee_due');assert.equal(paid.data.state.liveOrders[0].report,undefined);assert.equal(f.provider.providerTransfers,1);
});

test('a paid code timeout is delivered honestly with its timeout/error flags',async t=>{
 const f=await fixture(t);f.provider.toolReportOverride={stdout:'partial output',stderr:'',timedOut:true,error:'Time limit exceeded'};
 const q=await f.quote();await f.api('/api/agent/check',{orderId:q.data.effect.orderId});const order=(await f.state()).liveOrders[0];
 assert.equal(order.status,'completed');assert.equal(order.report.timedOut,true);assert.match(productResultHTML(order.report),/Execution timed out/);assert.equal(f.provider.providerTransfers,1);
});

test('wrong product/chain/asset/recipient quotes are refused without sending a signed request',async()=>{
 for(const patch of [{resource:{url:'https://agent402.tools/api/crypto-market'}},{accept:{network:'eip155:8453'}},{accept:{asset:'0x'+'11'.repeat(20)}},{accept:{payTo:'0x'+'11'.repeat(20)}}]){
  let calls=0;const provider=new MarketProvider(async()=>{calls++;const accepted={scheme:'exact',network:'eip155:4663',amount:'20000',asset:'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',payTo:'0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0',maxTimeoutSeconds:300,extra:{name:'Global Dollar',version:'1'},...patch.accept};return new Response('{}',{status:402,headers:{'payment-required':btoa(JSON.stringify({x402Version:2,resource:patch.resource||{url:'https://agent402.tools/api/code-run'},accepts:[accepted]}))}});});
  await assert.rejects(()=>provider.quote('compute',inputs.compute));assert.equal(calls,1);
 }
});

test('tool results and task previews escape output; long Unicode receipts remain inside the reserved delivery capacity',()=>{
 const code={language:'python',stdout:'😀'.repeat(20000)+'<script>bad</script>',stderr:'x'.repeat(20000),result:'z'.repeat(20000),error:null};
 const report=normalizeToolReport('compute',code);assert.ok(report.truncated);assert.ok(new TextEncoder().encode(JSON.stringify(report)).length<10000);
 assert.ok(!productResultHTML(normalizeToolReport('compute',{language:'python',stdout:'<script>bad</script>',stderr:''})).includes('<script>'));
 assert.ok(productInputHTML({productId:'compute',input:{language:'python',code:'<script>bad</script>'}}).includes('&lt;script&gt;'));
 assert.throws(()=>normalizeToolReport('research',{query:'x',results:[{title:'x',url:'javascript:bad()',description:'x'}]}));
 assert.throws(()=>productRequest('constructor',{}));
});

test('free Robinhood reads return chain data without creating an order, signing or changing balances',async t=>{
 const f=await fixture(t),before=await f.state();
 const block=await f.api('/api/tools/rpc',{cardId:'card-1',read:'block'});assert.equal(block.status,200);assert.equal(block.data.chargedMicros,0);assert.equal(block.data.result.block,'10000');
 const balance=await f.api('/api/tools/rpc',{cardId:'card-1',read:'balance',value:f.address});assert.equal(balance.status,200);assert.ok(balance.data.result.balance.endsWith(' ETH'));
 const receipt=await f.api('/api/tools/rpc',{cardId:'card-1',read:'receipt',value:'0x'+'11'.repeat(32)});assert.equal(receipt.status,200);assert.match(receipt.data.result.message,/does not prove/);
 assert.deepEqual(await f.state(),before);assert.equal(f.provider.providerTransfers,0);assert.equal(f.provider.broadcasts,0);
});

test('free chain reads refuse foreign cards, arbitrary RPC methods and a wrong network',async t=>{
 const f=await fixture(t);
 for(const body of [{cardId:'foreign',read:'block'},{cardId:'card-1',read:'eth_sendRawTransaction'},{cardId:'card-1',read:'block',method:'eth_sendTransaction'},{cardId:'card-1',read:'balance',value:'bad'},{cardId:'card-1',read:'balance',value:[f.address]}])assert.ok((await f.api('/api/tools/rpc',body)).status>=400);
 f.provider.rpc=async()=> '0x1';assert.equal((await f.api('/api/tools/rpc',{cardId:'card-1',read:'block'})).status,503);assert.equal(f.provider.broadcasts,0);
});

test('market-only schedule consent cannot dispatch a compute order',()=>{
 const now=Date.now(),plan={id:'s',product:'agent402-market-overview',status:'running',currentRun:{orderId:'o',slotAt:now},firstRunAt:now,agentGrantNonce:'n',validUntil:now+10000,maxTotalMicros:30000,startedRuns:1,maxRuns:2};
 const state={schedules:{c:plan}},order={id:'o',cardId:'c',scheduleId:'s',scheduleSlotAt:now,agentGrantNonce:'n',totalMicros:21000,productId:'compute'};
 assert.equal(scheduledOrderAllowed(state,order,now),false);
});
