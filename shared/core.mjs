export const categories=['Developer tools','AI & compute','Market data','Gift cards'];
export const catalog=[{id:'rpc',name:'RPC credits',merchant:'Chain access',category:'Developer tools',price:1000,icon:'⌘',color:'#dce9d1',description:'A test bundle of 100,000 RPC requests.'},{id:'compute',name:'Agent compute',merchant:'Compute desk',category:'AI & compute',price:2500,icon:'✳',color:'#eadff4',description:'A sample compute allowance for your agent.'},{id:'market',name:'Market data pass',merchant:'Market feed',category:'Market data',price:4000,icon:'∿',color:'#dfe8f5',description:'A test research data pass for seven days.'},{id:'steam',name:'Steam Wallet',merchant:'Steam',category:'Gift cards',price:1000,icon:'S',color:'#dde6ee',description:'A non-redeemable $10 sample code.'},{id:'apple',name:'App Store',merchant:'Apple',category:'Gift cards',price:2500,icon:'A',color:'#ececec',description:'A non-redeemable $25 sample code.'},{id:'research',name:'Research bundle',merchant:'Research desk',category:'Market data',price:7500,icon:'◈',color:'#f0e3d8',description:'A sample $75 multi-source research bundle.'}];
export function initialState(){return{version:1,cards:[{id:'card-1',name:'Research agent',balance:15000,perBuy:5000,perDay:10000,askAbove:2500,categories:[...categories],frozen:false}],orders:[],activity:[],selected:'card-1'};}
export const dollars=c=>'$'+(c/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
export function day(time){return new Date(time).toISOString().slice(0,10);}
export function ledger(state,id,now=Date.now()){
 const held=state.orders.filter(o=>o.cardId===id&&o.status==='pending').reduce((s,o)=>s+o.amount,0);
 const spent=state.orders.filter(o=>o.cardId===id&&o.status==='completed'&&day(o.completedAt)===day(now)).reduce((s,o)=>s+o.amount,0);
 const reservedToday=state.orders.filter(o=>o.cardId===id&&o.status==='pending'&&day(o.createdAt)===day(now)).reduce((s,o)=>s+o.amount,0);
 const card=state.cards.find(c=>c.id===id);return{held,spent,reservedToday,available:(card?.balance||0)-held};
}
export function checkPurchase(state,card,item,now=Date.now(),excludeOrderId=null){
 if(!card)throw Error('Choose an agent card.');if(card.frozen)throw Error('This card is frozen. Unfreeze it to make a purchase.');
 if(!item||!Number.isSafeInteger(item.price)||item.price<=0)throw Error('Choose an item from the demo shop.');
 if(!card.categories.includes(item.category))throw Error(item.category+' is not allowed on this card.');
 if(item.price>card.perBuy)throw Error('This purchase exceeds the '+dollars(card.perBuy)+' per-purchase limit.');
 const scoped={...state,orders:state.orders.filter(o=>o.id!==excludeOrderId)};const l=ledger(scoped,card.id,now);
 if(item.price>l.available)throw Error('Not enough available demo balance. Add funds or release a pending hold.');
 if(item.price+l.spent+l.reservedToday>card.perDay)throw Error('This purchase exceeds the daily limit, including pending approvals.');
}
function event(s,text,now,kind='info'){s.activity.unshift({text,time:now,kind});s.activity=s.activity.slice(0,100);}
export function purchase(state,cardId,itemId,now=Date.now()){
 const s=structuredClone(state),card=s.cards.find(c=>c.id===cardId),item=catalog.find(i=>i.id===itemId);checkPurchase(s,card,item,now);
 const order={id:'demo-'+now+'-'+s.orders.length,cardId,itemId,name:item.name,category:item.category,amount:item.price,createdAt:now,status:item.price>card.askAbove?'pending':'completed'};
 if(order.status==='completed'){card.balance-=item.price;order.completedAt=now;order.receipt='DEMO-'+(s.orders.length+1).toString().padStart(4,'0')+'-SAMPLE';}
 s.orders.unshift(order);event(s,order.name+(order.status==='pending'?' is waiting for approval.':' completed. No real purchase.'),now,order.status);return s;
}
export function resolveOrder(state,id,action,now=Date.now()){
 const s=structuredClone(state),order=s.orders.find(o=>o.id===id);if(!order||order.status!=='pending')throw Error('This approval has already been resolved.');
 if(!['approve','decline','cancel'].includes(action))throw Error('Choose approve, decline or cancel.');
 if(action==='approve'){const card=s.cards.find(c=>c.id===order.cardId),item=catalog.find(i=>i.id===order.itemId);checkPurchase(s,card,item,now,id);card.balance-=order.amount;order.status='completed';order.completedAt=now;order.receipt='DEMO-'+id.split('-').slice(1).join('-')+'-SAMPLE';}
 else order.status=action==='decline'?'declined':'cancelled';
 event(s,order.name+': '+order.status+'.',now,order.status);return s;
}
export function fundCard(state,id,cents,now=Date.now()){if(!Number.isSafeInteger(cents)||cents<100||cents>100000)throw Error('Add between $1 and $1,000 in demo funds.');const s=structuredClone(state),c=s.cards.find(c=>c.id===id);if(!c)throw Error('Choose a card.');c.balance+=cents;event(s,dollars(cents)+' in demo funds added to '+c.name+'.',now,'fund');return s;}
export function saveRules(state,id,rules){if(![rules.perBuy,rules.perDay,rules.askAbove].every(x=>Number.isSafeInteger(x)&&x>=0)||rules.perBuy<100||rules.perDay<100||rules.askAbove>rules.perBuy||rules.perBuy>rules.perDay||rules.categories.some(x=>!categories.includes(x)))throw Error('Use positive limits: approval threshold ≤ purchase limit ≤ daily limit.');const s=structuredClone(state),c=s.cards.find(c=>c.id===id);if(!c)throw Error('Choose a card.');Object.assign(c,rules);return s;}
export function newCard(state,name,now=Date.now()){name=name.trim();if(!name||name.length>32)throw Error('Use a card name between 1 and 32 characters.');if(state.cards.length>=10)throw Error('You can create up to ten demo cards.');const s=structuredClone(state),id='card-'+now;s.cards.push({id,name,balance:0,perBuy:5000,perDay:10000,askAbove:2500,categories:[...categories],frozen:false});s.selected=id;event(s,name+' created.',now);return s;}
export function parseRequest(text){const t=text.toLowerCase();const match=/\$\s*(\d+(?:\.\d{1,2})?)|\b(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars)/.exec(t);const cents=match?Math.round(Number(match[1]||match[2])*100):null;let items=t.includes('steam')?catalog.filter(i=>i.id==='steam'):t.includes('apple')||t.includes('app store')?catalog.filter(i=>i.id==='apple'):t.includes('rpc')?catalog.filter(i=>i.id==='rpc'):t.includes('compute')||t.includes('credits for my agent')?catalog.filter(i=>i.id==='compute'):t.includes('research')?catalog.filter(i=>i.id==='research'):t.includes('market')||t.includes('data')?catalog.filter(i=>i.id==='market'):[];
 const item=items.find(i=>cents===null||i.price===cents);if(!item)throw Error('That exact item or amount is not in the demo shop. Choose a listed item; nothing has been spent.');return item;
}
