import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { LocalD1 } from './scripts/sqlite-d1.mjs';
import { handleApi } from './server/api.mjs';
import { handleMcp } from './server/mcp.mjs';
import { AccountStore } from './server/store.mjs';
import { WalletVault } from './server/vault.mjs';
import { commission, feeFor, consentTypedData, withdrawalTypedData } from './shared/commission.mjs';
import { paymentTypedData, liveTotals } from './shared/payment.mjs';
import { MockChainProvider } from './test/fixtures/chain.mjs';
import { isLiveMarketRequest, assistantControlIntent } from './server/assistant.mjs';

async function fixture(t) {
 const db=new LocalD1();db.migrate();t.after(()=>db.close());
 const provider=new MockChainProvider(),owner=privateKeyToAccount(generatePrivateKey());
 const env={DB:db,GRANTFOLD_WALLET_KEY_V1:'ab'.repeat(32)};
 const headers=user=>({'oai-authenticated-user-id':user,'oai-authenticated-user-email':user+'@test.example','content-type':'application/json','x-grantfold-client':'browser','idempotency-key':crypto.randomUUID()});
 async function api(route,body,user='alice',key) {const response=await handleApi(new Request('https://grantfold.test'+route,{method:body===undefined?'GET':'POST',headers:{...headers(user),...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{marketProvider:provider});return{status:response.status,data:await response.json()};}
 async function mcp(name,args={},user='alice') {const response=await handleMcp(new Request('https://grantfold.test/mcp',{method:'POST',headers:user?headers(user):{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),env,{marketProvider:provider});const rpc=await response.json();return{...rpc.result,data:rpc.result?.content?.[0]?.text?JSON.parse(rpc.result.content[0].text):null};}
 await api('/api/account/bootstrap',{legacy:null});
 async function enable(){const r=await api('/api/agent/prepare',{cardId:'card-1',owner:owner.address});assert.equal(r.status,200);const setup=r.data.effect.setup;const signature=await owner.signTypedData(consentTypedData(setup,'https://grantfold.test'));const enabled=await api('/api/agent/enable',{cardId:'card-1',signature});assert.equal(enabled.status,200);return enabled.data.state.agents['card-1'];}
 const buy=(request_id=crypto.randomUUID(),max_total_micros=15750)=>mcp('grantfold_buy_market',{card_id:'card-1',request_id,max_total_micros});
 return{db,env,provider,owner,api,mcp,enable,buy,state:async()=> (await api('/api/account')).data.state};
}

test('commission is 5% with no flat minimum and preserves micro-USDG precision',()=>{assert.equal(commission.bps,500);assert.equal(feeFor(15000),750);assert.equal(feeFor(1000000),50000);assert.equal(feeFor(1),1);assert.equal(commission.recipient,'0x1425a0947d12c883e347c1dfe5e43b7f92fa0cd4');});

test('agent control commands require exact intent and refuse negations or bundled requests',()=>{
 for(const [text,intent] of [['Check agent balance','balance'],['Проверь баланс агента','balance'],['Какая у меня скидка?','fee'],['Check my GFLD fee','fee'],['Pause agent','pause'],['Поставь агента на паузу.','pause']])assert.equal(assistantControlIntent(text),intent);
 for(const text of ["Don't pause agent",'Не останавливай агента','Pause agent?','Can you pause agent?','Pause agent and buy a market overview','Check my GFLD fee then buy','Купи обзор рынка'])assert.equal(assistantControlIntent(text),null);
});

test('Assistant live balance is read-only, works while paused and replays without another chain check',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address,20000n,20000000000000n);
 await f.api('/api/agent/revoke',{cardId:'card-1'});
 let calls=0;const rpc=f.provider.rpc.bind(f.provider);f.provider.rpc=(...args)=>{calls++;return rpc(...args);};
 const key=crypto.randomUUID(),body={type:'assistant',cardId:'card-1',text:'Check agent balance'};
 const first=await f.api('/api/actions',body,'alice',key);assert.equal(first.status,200);assert.equal(first.data.effect.agentControl,'balance');
 const answer=first.data.state.messages['card-1'].at(-1).text;assert.match(answer,/0\.02 USDG/);assert.match(answer,/0\.00002 ETH/);assert.match(answer,/paused/);assert.ok(answer.includes(grant.address));
 const after=calls;assert.ok(after>0);const replay=await f.api('/api/actions',body,'alice',key);assert.equal(replay.data.replayed,true);assert.equal(calls,after);
 assert.equal(first.data.state.agents['card-1'].enabled,false);assert.equal(first.data.state.liveOrders?.length||0,0);assert.equal(f.provider.providerCalls,0);assert.equal(f.provider.broadcasts,0);
});

test('Assistant pause disables new purchases atomically without releasing a submitted-order hold',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);
 const quoted=await f.api('/api/actions',{type:'assistant',cardId:'card-1',text:'Buy a live market overview'}),order=quoted.data.state.liveOrders[0];
 const paused=await f.api('/api/actions',{type:'assistant',cardId:'card-1',text:'Поставь агента на паузу'});assert.equal(paused.status,200);assert.equal(paused.data.state.agents['card-1'].enabled,false);
 assert.equal(paused.data.state.liveOrders[0].id,order.id);assert.equal(paused.data.state.liveOrders[0].status,order.status);
 assert.equal((await f.api('/api/agent/check',{orderId:order.id})).status,403);assert.equal(f.provider.providerCalls,0);assert.equal(f.provider.broadcasts,0);
});

test('Assistant controls reject foreign cards before RPC and never invent balances after an outage',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);let calls=0;f.provider.rpc=async()=>{calls++;throw Error('offline');};
 assert.equal((await f.api('/api/actions',{type:'assistant',cardId:'foreign',text:'Check agent balance'})).status,404);assert.equal(calls,0);
 assert.equal((await f.api('/api/actions',{type:'assistant',cardId:'card-1',text:'Check agent balance',owner:f.owner.address})).status,422);assert.equal(calls,0);
 const r=await f.api('/api/actions',{type:'assistant',cardId:'card-1',text:'Check agent balance'});assert.equal(r.status,200);assert.match(r.data.state.messages['card-1'].at(-1).text,/could not be verified/);assert.equal(r.data.state.agents['card-1'].enabled,true);assert.equal(f.provider.providerCalls,0);
});

test('wallet key is encrypted and bound to account/card; snapshots never expose it',async t=>{
 const f=await fixture(t),grant=await f.enable();const store=new AccountStore(f.db),vault=new WalletVault(store,f.env),row=await vault.row('alice','card-1');
 assert.equal(row.address,grant.address);assert.equal(row.iv.length,24);assert.ok(row.encrypted_key.length>132);
 assert.equal((await vault.signer('alice','card-1')).address,grant.address);
 assert.ok(!JSON.stringify(await f.state()).includes(row.encrypted_key));assert.ok(!JSON.stringify((await f.api('/api/audit')).data).includes(row.encrypted_key));
 await assert.rejects(()=>new WalletVault(store,{GRANTFOLD_WALLET_KEY_V1:'cd'.repeat(32)}).signer('alice','card-1'),/could not be unlocked/);
 await f.api('/api/account/bootstrap',{legacy:null},'bob');
 f.db.connection.prepare('INSERT INTO agent_wallets (user_id,card_id,address,owner_address,encrypted_key,iv,created_at) VALUES (?,?,?,?,?,?,?)').run('bob','card-1',row.address,row.owner_address,row.encrypted_key,row.iv,Date.now());
 await assert.rejects(()=>vault.signer('bob','card-1'),/could not be unlocked/);
});

test('a different owner or different Site origin cannot enable agent consent',async t=>{
 const f=await fixture(t);const prepared=await f.api('/api/agent/prepare',{cardId:'card-1',owner:f.owner.address}),setup=prepared.data.effect.setup;
 const other=privateKeyToAccount(generatePrivateKey());
 for(const signature of[await other.signTypedData(consentTypedData(setup,'https://grantfold.test')),await f.owner.signTypedData(consentTypedData(setup,'https://another.test'))])assert.equal((await f.api('/api/agent/enable',{cardId:'card-1',signature})).status,422);
 assert.equal((await f.state()).agents,undefined);assert.equal(f.provider.providerTransfers,0);
});

test('missing wallet protection configuration fails closed without creating a key',async t=>{
 const f=await fixture(t);delete f.env.GRANTFOLD_WALLET_KEY_V1;
 assert.equal((await f.api('/api/agent/prepare',{cardId:'card-1',owner:f.owner.address})).status,503);
 assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM agent_wallets').get().n,0);
});

test('an empty client wallet or missing client gas never causes a provider payment',async t=>{
 const f=await fixture(t),grant=await f.enable();let r=await f.buy();assert.equal(r.isError,true);assert.equal(r.data.code,'agent_usdg_balance');
 f.provider.fund(grant.address,1000000n,0n);r=await f.buy();assert.equal(r.isError,true);assert.equal(r.data.code,'fee_gas_balance');
 assert.equal(f.provider.providerTransfers,0);assert.equal(f.provider.feeTransfers,0);
});

test('autonomous MCP purchase charges the client wallet and exact fee once, then releases report',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);
 const requestId=crypto.randomUUID(),result=await f.buy(requestId);assert.equal(result.isError,false,JSON.stringify(result.data));
 assert.equal(result.data.order.status,'completed');assert.equal(result.data.order.feeMicros,750);assert.equal(result.data.order.totalMicros,15750);assert.equal(result.data.order.report.coins.length,2);
 assert.equal(f.provider.providerTransfers,1);assert.equal(f.provider.feeTransfers,1);assert.equal(f.provider.balance(commission.recipient),750n);assert.equal(f.provider.balance(grant.address),984250n);
 assert.equal((await f.state()).cards[0].balance,15000);assert.equal(liveTotals(await f.state(),'card-1').spent,15750);
 assert.equal((await f.buy(requestId)).data.order.id,result.data.order.id);assert.equal(f.provider.providerTransfers,1);assert.equal(f.provider.feeTransfers,1);
 const conflict=await f.buy(requestId,16000);assert.equal(conflict.isError,true);assert.equal(conflict.data.code,'idempotency_conflict');
});

test('anonymous callers and unknown MCP arguments cannot trigger a purchase or withdrawal',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);
 assert.equal((await f.mcp('grantfold_buy_market',{card_id:'card-1',request_id:crypto.randomUUID(),max_total_micros:15750},null)).isError,true);
 assert.equal((await f.mcp('grantfold_buy_market',{card_id:'card-1',request_id:crypto.randomUUID(),max_total_micros:15750,to:f.owner.address})).isError,true);
 assert.equal((await f.mcp('withdraw',{card_id:'card-1'})).data,null);
 assert.equal(f.provider.providerTransfers,0);assert.equal(f.provider.broadcasts,0);
});

test('freeze and revoke stop new autonomous spending',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);
 await f.api('/api/actions',{type:'freeze',cardId:'card-1',frozen:true});assert.equal((await f.buy()).data.code,'agent_frozen');
 await f.api('/api/actions',{type:'freeze',cardId:'card-1',frozen:false});await f.api('/api/agent/revoke',{cardId:'card-1'});assert.equal((await f.buy()).data.code,'agent_disabled');
 assert.equal(f.provider.providerTransfers,0);
});

test('above-threshold order waits for browser owner approval before any signature is submitted',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);
 await f.api('/api/actions',{type:'rules',cardId:'card-1',name:'Research',perBuy:5000,perDay:10000,askAbove:0,categories:['Market data']});
 const result=await f.buy();assert.equal(result.data.order.status,'agent_approval');assert.equal(f.provider.providerTransfers,0);
 const approved=await f.api('/api/agent/approve',{orderId:result.data.order.id});assert.equal(approved.status,200,JSON.stringify(approved.data));assert.equal(approved.data.state.liveOrders[0].status,'completed');
 assert.equal(f.provider.providerTransfers,1);assert.equal(f.provider.feeTransfers,1);
});

test('lost settled provider response does not collect a fee early and reuses the same purchase',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);f.provider.loseProviderResponse=true;
 const id=crypto.randomUUID(),first=await f.buy(id);assert.equal(first.data.order.status,'needs_review');assert.equal(first.data.order.report,undefined);assert.equal(f.provider.feeTransfers,0);
 const recovered=await f.buy(id);assert.equal(recovered.data.order.status,'completed');assert.equal(f.provider.providerTransfers,1);assert.equal(f.provider.feeTransfers,1);
});

test('lost fee broadcast response is reconciled by the saved transaction hash without duplicate payment',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);f.provider.loseBroadcastResponse=true;
 const id=crypto.randomUUID(),result=await f.buy(id);assert.equal(result.data.order.status,'completed');
 await f.buy(id);assert.equal(f.provider.feeTransfers,1);assert.equal(f.provider.broadcasts,1);
});

test('high network gas is refused before spending the provider price',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);f.provider.gasPrice=1_000_000_000n;
 const result=await f.buy();assert.equal(result.isError,true);assert.equal(result.data.code,'fee_gas_cap');assert.equal(f.provider.providerTransfers,0);
});

test('manual wallet report stays private until its separately authorized fee is confirmed',async t=>{
 const f=await fixture(t);f.provider.fund(f.owner.address);
 const quote=await f.api('/api/live/quote',{cardId:'card-1'}),orderId=quote.data.effect.orderId;
 const prepared=await f.api('/api/live/prepare',{orderId,wallet:f.owner.address}),order=prepared.data.state.liveOrders[0];
 const signature=await f.owner.signTypedData(paymentTypedData(order.authorization)),feeSignature=await f.owner.signTypedData(paymentTypedData(order.feeAuthorization));
 assert.equal((await f.api('/api/live/pay',{orderId,signature})).status,422);assert.equal(f.provider.providerTransfers,0);
 const paid=await f.api('/api/live/pay',{orderId,signature,feeSignature});assert.equal(paid.status,200);assert.equal(paid.data.state.liveOrders[0].status,'fee_due');assert.equal(paid.data.state.liveOrders[0].report,undefined);
 const fee=await f.api('/api/live/fee_transaction',{orderId});assert.ok(fee.data.effect.transaction);
 const tx=fee.data.effect.transaction,raw=await f.owner.signTransaction({chainId:4663,type:'legacy',to:tx.to,data:tx.data,value:0n,nonce:0,gas:BigInt(tx.gas),gasPrice:BigInt(tx.gasPrice)});
 const hash=await f.provider.rpc('eth_sendRawTransaction',[raw]);
 const done=await f.api('/api/live/fee_check',{orderId,transaction:hash});assert.equal(done.data.state.liveOrders[0].status,'completed');assert.equal(done.data.state.liveOrders[0].report.coins.length,2);
 assert.equal(f.provider.feeTransfers,1);
});

test('only the linked owner can return client funds, and a repeated withdrawal transfers once',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);
 const prepared=await f.api('/api/agent/withdraw_prepare',{cardId:'card-1',asset:'USDG',amount:'0.5'}),w=prepared.data.effect.withdrawal;
 const other=privateKeyToAccount(generatePrivateKey()),bad=await other.signTypedData(withdrawalTypedData(w,'https://grantfold.test'));
 assert.equal((await f.api('/api/agent/withdraw',{withdrawalId:w.id,signature:bad})).status,422);assert.equal(f.provider.broadcasts,0);
 const signature=await f.owner.signTypedData(withdrawalTypedData(w,'https://grantfold.test'));
 const returned=await f.api('/api/agent/withdraw',{withdrawalId:w.id,signature});assert.equal(returned.status,200,JSON.stringify(returned.data));assert.equal(returned.data.state.agentWithdrawals[0].status,'completed');
 assert.equal(f.provider.balance(f.owner.address),500000n);assert.equal(f.provider.balance(commission.recipient),0n);assert.equal(returned.data.state.agents['card-1'].enabled,false);
 await f.api('/api/agent/withdraw',{withdrawalId:w.id,signature});assert.equal(f.provider.broadcasts,1);
});

test('MCP discovery advertises exact tools without disclosing any account data',async t=>{
 const f=await fixture(t);const response=await handleMcp(new Request('https://grantfold.test/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),f.env);
 const r=await response.json();assert.equal(r.result.tools.length,4);assert.ok(r.result.tools.some(t=>t.name==='grantfold_buy_market'));assert.ok(!JSON.stringify(r).includes(f.owner.address));
});

test('revocation during preflight is rechecked atomically before the provider can charge',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);
 f.provider.beforeEstimate=()=>f.api('/api/agent/revoke',{cardId:'card-1'});
 const result=await f.buy();assert.equal(result.isError,true);assert.equal(result.data.code,'agent_revoked');assert.equal(f.provider.providerTransfers,0);assert.equal(f.provider.feeTransfers,0);
});

test('owner-address tampering makes the encrypted wallet fail closed',async t=>{
 const f=await fixture(t);await f.enable();const other=privateKeyToAccount(generatePrivateKey());
 f.db.connection.prepare('UPDATE agent_wallets SET owner_address = ?').run(other.address);
 await assert.rejects(()=>new WalletVault(new AccountStore(f.db),f.env).signer('alice','card-1'),/could not be unlocked/);
});

test('prepared withdrawals can be cancelled, and duplicate preparation reuses the same intent',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);
 const body={cardId:'card-1',asset:'USDG',amount:'0.1'},a=await f.api('/api/agent/withdraw_prepare',body),b=await f.api('/api/agent/withdraw_prepare',body);
 assert.equal(a.data.effect.withdrawal.id,b.data.effect.withdrawal.id);
 assert.equal((await f.api('/api/agent/withdraw_cancel',{withdrawalId:a.data.effect.withdrawal.id})).status,200);
 assert.equal(f.provider.broadcasts,0);
 const next=await f.api('/api/agent/withdraw_prepare',{...body,amount:'0.2'});assert.equal(next.status,200);assert.notEqual(next.data.effect.withdrawal.id,a.data.effect.withdrawal.id);
});

test('replaying consumed enable consent after revocation does not reactivate spending',async t=>{
 const f=await fixture(t);const prepared=await f.api('/api/agent/prepare',{cardId:'card-1',owner:f.owner.address}),setup=prepared.data.effect.setup;
 const signature=await f.owner.signTypedData(consentTypedData(setup,'https://grantfold.test'));
 await f.api('/api/agent/enable',{cardId:'card-1',signature});await f.api('/api/agent/revoke',{cardId:'card-1'});
 const replay=await f.api('/api/agent/enable',{cardId:'card-1',signature});assert.equal(replay.status,200);assert.equal(replay.data.state.agents['card-1'].enabled,false);
});

test('ETH return is paid from client gas and cannot be redirected through request fields',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);
 assert.equal((await f.api('/api/agent/withdraw_prepare',{cardId:'card-1',asset:'ETH',amount:'0.000001',to:commission.recipient})).status,422);
 const prepared=await f.api('/api/agent/withdraw_prepare',{cardId:'card-1',asset:'ETH',amount:'0.000001'}),w=prepared.data.effect.withdrawal;
 const signature=await f.owner.signTypedData(withdrawalTypedData(w,'https://grantfold.test'));
 assert.equal((await f.api('/api/agent/withdraw',{withdrawalId:w.id,signature})).data.state.agentWithdrawals[0].status,'completed');
 assert.equal(f.provider.eth(f.owner.address),1000000000000n);assert.equal(f.provider.balance(commission.recipient),0n);
});

test('daily gas consent is checked before the provider price can be spent',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);
 const store=new AccountStore(f.db),vault=new WalletVault(store,f.env);
 for(let i=0;i<64;i++)await vault.signTransaction('alice','card-1','fee-seed-'+i,{to:f.owner.address,value:'0x0'},f.provider);
 const result=await f.buy();assert.equal(result.isError,true);assert.equal(result.data.code,'agent_daily_gas');assert.equal(f.provider.providerTransfers,0);
});


test('a proven reverted fee retries the same authorization without buying the provider again',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);f.provider.revertNext=true;
 const id=crypto.randomUUID(),first=await f.buy(id);assert.equal(first.data.order.status,'fee_due');assert.equal(first.data.order.feeAttempt,1);assert.equal(f.provider.feeTransfers,0);assert.equal(f.provider.providerTransfers,1);
 const next=await f.buy(id);assert.equal(next.data.order.status,'completed',JSON.stringify(next));assert.equal(f.provider.feeTransfers,1);assert.equal(f.provider.providerTransfers,1);assert.equal(f.provider.broadcasts,2);
 assert.equal(next.data.order.feeAuthorization.nonce,first.data.order.feeAuthorization.nonce);assert.equal(f.provider.balance(commission.recipient),750n);
});

test('manual endpoints cannot replace or execute an agent order wallet action',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);
 await f.api('/api/actions',{type:'rules',cardId:'card-1',name:'Research',perBuy:5000,perDay:10000,askAbove:0,categories:['Market data']});
 const orderId=(await f.buy()).data.order.id;
 for(const [route,body] of [['prepare',{orderId,wallet:f.owner.address}],['pay',{orderId,signature:'0x'+'ab'.repeat(65)}],['check',{orderId}],['fee_declined',{orderId}],['fee_transaction',{orderId}]]){
  const result=await f.api('/api/live/'+route,body);assert.equal(result.status,409);assert.equal(result.data.error.code,'agent_order_route');
 }
 assert.equal(f.provider.providerTransfers,0);
});

test('an expired unsigned approval does not permanently block a fresh quote',async t=>{
 const f=await fixture(t);await f.enable();await f.api('/api/actions',{type:'rules',cardId:'card-1',name:'Research',perBuy:5000,perDay:10000,askAbove:0,categories:['Market data']});
 await f.buy();const store=new AccountStore(f.db);await store.mutate('alice','expire-test-'+crypto.randomUUID(),'x',state=>{state.liveOrders[0].expiresAt=Date.now()-1;return{state,effect:{},audit:{kind:'test'}}});
 assert.equal((await f.api('/api/live/quote',{cardId:'card-1'})).status,200);assert.equal(f.provider.providerTransfers,0);
});


test('preparing a return invalidates pending consent and prevents a stale re-enable',async t=>{
 const f=await fixture(t);await f.enable();const prepared=await f.api('/api/agent/prepare',{cardId:'card-1',owner:f.owner.address});const signature=await f.owner.signTypedData(consentTypedData(prepared.data.effect.setup,'https://grantfold.test'));
 await f.api('/api/agent/withdraw_prepare',{cardId:'card-1',asset:'USDG',amount:'0.1'});const result=await f.api('/api/agent/enable',{cardId:'card-1',signature});assert.ok(result.status>=400);assert.equal((await f.state()).agents['card-1'].enabled,false);
});


test('revoked agent can release a failed provider attempt after its unused authorization expires',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);f.provider.failProvider=true;const id=crypto.randomUUID();await f.buy(id);await f.api('/api/agent/revoke',{cardId:'card-1'});
 const store=new AccountStore(f.db);await store.mutate('alice','age-test-'+crypto.randomUUID(),'age',state=>{state.liveOrders[0].authorization.validBefore=String(Math.floor(Date.now()/1000)-60);return{state,effect:{},audit:{kind:'test'}}});
 const checked=await f.buy(id);assert.equal(checked.data.order.status,'failed',JSON.stringify(checked));assert.equal(f.provider.providerTransfers,0);
 assert.equal((await f.api('/api/agent/withdraw_prepare',{cardId:'card-1',asset:'USDG',amount:'0.1'})).status,200);
});


test('the exact real-world malformed extension is refused before money moves and its reason survives',async t=>{
 const f=await fixture(t);f.provider.fund(f.owner.address);const quoted=await f.api('/api/live/quote',{cardId:'card-1'}),orderId=quoted.data.effect.orderId;
 const store=new AccountStore(f.db);await store.mutate('alice','broken-echo-'+crypto.randomUUID(),'broken',state=>{delete state.liveOrders[0].paymentExtensions['payment-identifier'].info.required;return{state,effect:{orderId},audit:{kind:'test'}}});
 const prepared=await f.api('/api/live/prepare',{orderId,wallet:f.owner.address}),order=prepared.data.state.liveOrders[0],signature=await f.owner.signTypedData(paymentTypedData(order.authorization)),feeSignature=await f.owner.signTypedData(paymentTypedData(order.feeAuthorization));
 const result=await f.api('/api/live/pay',{orderId,signature,feeSignature});assert.equal(result.data.state.liveOrders[0].status,'needs_review');assert.equal(result.data.state.liveOrders[0].deliveryIssue.reason,'extension_echo_mismatch');assert.equal(f.provider.providerTransfers,0);assert.equal(f.provider.feeTransfers,0);
});

test('paid assistant intent requires an explicit supported purchase, not a question or negation',()=>{
 for(const text of ['Buy a live market overview','Get me a market overview','Please buy a crypto market overview.','Купи обзор рынка','Закажи мне обзор крипторынка!'])assert.equal(isLiveMarketRequest(text),true,text);
 for(const text of ['What is a live market overview?','Do not buy a live market overview','Не покупай обзор рынка','Buy a $40 market data pass','Buy a live market overview for Bob','Buy ten live market overviews','market overview'])assert.equal(isLiveMarketRequest(text),false,text);
});

test('Assistant guides an unconfigured wallet to setup without a quote or payment',async t=>{
 const f=await fixture(t);
 const r=await f.api('/api/actions',{type:'assistant',cardId:'card-1',text:'Buy a live market overview'});
 assert.equal(r.status,200);assert.equal(r.data.effect.connectAgent,true);assert.equal(r.data.state.liveOrders,undefined);
 assert.equal(r.data.state.messages['card-1'].at(-1).connectAgent,true);assert.equal(f.provider.providerTransfers,0);assert.equal(f.provider.broadcasts,0);
});

test('Assistant gives an unpaid exact-price quote; replay and a repeated request reuse it',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);
 const body={type:'assistant',cardId:'card-1',text:'Buy a live market overview'},key=crypto.randomUUID();
 const first=await f.api('/api/actions',body,'alice',key),replay=await f.api('/api/actions',body,'alice',key);
 assert.equal(first.status,200);assert.equal(first.data.effect.live,true);assert.equal(first.data.effect.orderId,replay.data.effect.orderId);
 assert.equal(replay.data.state.liveOrders.length,1);assert.equal(replay.data.state.messages['card-1'].length,2);
 const order=first.data.state.liveOrders[0];assert.equal(order.agent,true);assert.equal(order.status,'quoted');assert.equal(order.totalMicros,15750);assert.equal(order.authorization,undefined);
 assert.match(first.data.state.messages['card-1'].at(-1).text,/0\.01575 USDG/);assert.equal(f.provider.providerTransfers,0);assert.equal(f.provider.feeTransfers,0);
 const repeat=await f.api('/api/actions',body);assert.equal(repeat.data.effect.reused,true);assert.equal(repeat.data.effect.orderId,order.id);assert.equal(repeat.data.state.liveOrders.length,1);
 const paid=await f.api('/api/agent/check',{orderId:order.id});assert.equal(paid.status,200);assert.equal(paid.data.state.liveOrders[0].status,'completed');
 await f.api('/api/agent/check',{orderId:order.id});assert.equal(f.provider.providerTransfers,1);assert.equal(f.provider.feeTransfers,1);assert.equal(paid.data.state.liveOrders[0].report.coins.length,2);
 assert.equal(paid.data.state.cards[0].balance,15000);
});

test('Assistant confirmation rechecks revocation, freeze and expired quotes before any charge',async t=>{
 for(const condition of ['revoked','frozen','expired']) {
  const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);
  const r=await f.api('/api/actions',{type:'assistant',cardId:'card-1',text:'Купи обзор рынка'}),order=r.data.state.liveOrders[0];
  if(condition==='revoked')await f.api('/api/agent/revoke',{cardId:'card-1'});
  if(condition==='frozen')await f.api('/api/actions',{type:'freeze',cardId:'card-1',frozen:true});
  if(condition==='expired')await new AccountStore(f.db).mutate('alice',crypto.randomUUID(),'expire',state=>{state.liveOrders[0].expiresAt=Date.now()-1;return{state,effect:{},audit:{kind:'test_expire'}};});
  assert.notEqual((await f.api('/api/agent/check',{orderId:order.id})).status,200,condition);
  assert.equal(f.provider.providerTransfers,0,condition);assert.equal(f.provider.feeTransfers,0,condition);
 }
});

test('Assistant above-threshold requests cannot bypass owner approval through recovery',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);
 await f.api('/api/actions',{type:'rules',cardId:'card-1',name:'Research',perBuy:5000,perDay:10000,askAbove:0,categories:['Market data']});
 const r=await f.api('/api/actions',{type:'assistant',cardId:'card-1',text:'Buy a live market overview'}),order=r.data.state.liveOrders[0];
 assert.equal(order.status,'agent_approval');assert.equal((await f.api('/api/agent/check',{orderId:order.id})).data.state.liveOrders[0].status,'agent_approval');assert.equal(f.provider.providerTransfers,0);
 const approved=await f.api('/api/agent/approve',{orderId:order.id});assert.equal(approved.data.state.liveOrders[0].status,'completed');assert.equal(f.provider.providerTransfers,1);assert.equal(f.provider.feeTransfers,1);
});

test('Assistant recovers a lost provider response without creating a second purchase',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);
 const body={type:'assistant',cardId:'card-1',text:'Buy a live market overview'};
 const quote=await f.api('/api/actions',body),orderId=quote.data.effect.orderId;
 f.provider.loseProviderResponse=true;const uncertain=await f.api('/api/agent/check',{orderId});assert.equal(uncertain.data.state.liveOrders[0].status,'needs_review');
 const resumed=await f.api('/api/actions',body);assert.equal(resumed.data.effect.orderId,orderId);assert.equal(resumed.data.state.liveOrders.length,1);
 const recovered=await f.api('/api/agent/check',{orderId});assert.equal(recovered.data.state.liveOrders[0].status,'completed');assert.equal(f.provider.providerTransfers,1);assert.equal(f.provider.feeTransfers,1);
});

test('Assistant paid requests reject foreign cards and payment overrides; demo pass stays simulated',async t=>{
 const f=await fixture(t),grant=await f.enable();f.provider.fund(grant.address);
 const body={type:'assistant',cardId:'card-1',text:'Buy a live market overview'};
 assert.equal((await f.api('/api/actions',{...body,feeBps:0})).status,422);
 assert.equal((await f.api('/api/actions',{...body,cardId:'card-foreign'})).status,404);
 await f.api('/api/account/bootstrap',{legacy:null},'bob');const other=await f.api('/api/actions',body,'bob');assert.equal(other.data.effect.connectAgent,true);
 const demo=await f.api('/api/actions',{...body,text:'Buy a $40 market data pass'});assert.equal(demo.status,200);assert.equal(demo.data.effect.live,undefined);assert.equal(demo.data.state.orders.length,1);
 assert.equal(f.provider.providerTransfers,0);assert.equal(f.provider.feeTransfers,0);
});
