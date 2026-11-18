import { categories, catalog, initialState, ledger, purchase, resolveOrder, fundCard, saveRules, newCard, parseRequest, dollars } from '../shared/core.mjs';
import { AppError } from './store.mjs';

function requireValue(condition, message, code = 'invalid_request') { if (!condition) throw new AppError(422, code, message); }
function cents(value, max = 100_000_000) { requireValue(Number.isSafeInteger(value) && value >= 0 && value <= max, 'Use an amount in whole cents within the allowed range.'); return value; }
function cardName(value) { requireValue(typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 32, 'Use a card name between 1 and 32 characters.'); return value.trim(); }
function strictFields(value, fields) { requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key)), 'This request contains unsupported fields.'); }
function appendActivity(state, text, kind = 'info', now = Date.now()) { state.activity.unshift({ text, kind, time: now }); state.activity = state.activity.slice(0, 100); }
function appendMessage(state, cardId, text, type) { state.messages ??= {}; state.messages[cardId] ??= []; state.messages[cardId].push({ text, type }); state.messages[cardId] = state.messages[cardId].slice(-40); }
function assignOrderIdentity(state) { const order = state.orders[0]; order.id = 'demo-' + crypto.randomUUID(); if (order.status === 'completed') order.receipt = 'DEMO-' + crypto.randomUUID().slice(0, 8).toUpperCase() + '-SAMPLE'; return order; }

export function importLegacyState(input) {
  try { return validateLegacyState(input); }
  catch (error) { if (error instanceof AppError) throw new AppError(422, 'invalid_backup', error.message); throw error; }
}

function validateLegacyState(input) {
  if (input == null) return { state: initialState(), imported: false };
  requireValue(typeof input === 'object' && !Array.isArray(input), 'The browser backup must be an account object.', 'invalid_backup');
  requireValue(input.version === 1 && Array.isArray(input.cards) && input.cards.length >= 1 && input.cards.length <= 10, 'The browser backup has an invalid card list.', 'invalid_backup');
  requireValue(Array.isArray(input.orders) && input.orders.length <= 5000, 'The browser backup has too many orders.', 'invalid_backup');
  const state = { version: 1, cards: [], orders: [], activity: [], selected: '', messages: {} }, ids = new Set();
  for (const c of input.cards) {
    requireValue(c && typeof c === 'object' && typeof c.id === 'string' && /^card-[\w-]{1,95}$/.test(c.id) && !ids.has(c.id), 'The browser backup has invalid card identifiers.', 'invalid_backup'); ids.add(c.id);
    requireValue(Array.isArray(c.categories) && c.categories.every(v => categories.includes(v)), 'The browser backup has invalid categories.', 'invalid_backup');
    const rules = { perBuy: cents(c.perBuy), perDay: cents(c.perDay), askAbove: cents(c.askAbove), categories: [...new Set(c.categories)] };
    requireValue(rules.perBuy >= 100 && rules.perBuy <= rules.perDay && rules.askAbove <= rules.perBuy, 'The browser backup has invalid spending rules.', 'invalid_backup');
    state.cards.push({ id: c.id, name: cardName(c.name), balance: cents(c.balance), ...rules, frozen: c.frozen === true });
  }
  const orderIds = new Set();
  for (const o of input.orders) {
    requireValue(o && typeof o === 'object', 'The browser backup has an invalid order.', 'invalid_backup');
    const item = catalog.find(i => i.id === o.itemId);
    requireValue(item && ids.has(o.cardId) && typeof o.id === 'string' && /^[\w-]{1,150}$/.test(o.id) && !orderIds.has(o.id), 'The browser backup has an invalid order.', 'invalid_backup'); orderIds.add(o.id);
    requireValue(o.amount === item.price && ['pending', 'completed', 'declined', 'cancelled'].includes(o.status) && Number.isSafeInteger(o.createdAt) && o.createdAt >= 0 && o.createdAt <= Date.now() + 60_000, 'The browser backup has invalid order details.', 'invalid_backup');
    const order = { id: o.id, cardId: o.cardId, itemId: item.id, name: item.name, category: item.category, amount: item.price, status: o.status, createdAt: o.createdAt };
    if (o.status === 'completed') { requireValue(Number.isSafeInteger(o.completedAt) && o.completedAt >= o.createdAt && o.completedAt <= Date.now() + 60_000, 'The browser backup has an invalid receipt.', 'invalid_backup'); order.completedAt = o.completedAt; order.receipt = typeof o.receipt === 'string' && /^DEMO-[\w-]{1,160}-SAMPLE$/.test(o.receipt) ? o.receipt : 'DEMO-IMPORTED-SAMPLE'; }
    state.orders.push(order);
  }
  for (const c of state.cards) {
    requireValue(ledger(state, c.id).available >= 0, 'The browser backup reserves more funds than the card holds.', 'invalid_backup');
    const messages = input.messages?.[c.id];
    if (Array.isArray(messages)) state.messages[c.id] = messages.slice(-40).filter(m => m && ['user', 'assistant'].includes(m.type) && typeof m.text === 'string').map(m => ({ type: m.type, text: m.text.slice(0, 1000) }));
  }
  if (Array.isArray(input.activity)) state.activity = input.activity.slice(0, 99).filter(a => a && typeof a.text === 'string' && Number.isSafeInteger(a.time) && a.time >= 0).map(a => ({ text: a.text.slice(0, 300), time: a.time, kind: ['info', 'fund', 'pending', 'completed', 'declined', 'cancelled'].includes(a.kind) ? a.kind : 'info' }));
  state.selected = ids.has(input.selected) ? input.selected : state.cards[0].id;
  appendActivity(state, 'Browser demo imported to your Grantfold account. All funds remain simulated.');
  return { state, imported: true };
}

export function applyAction(state, body) {
  const types = {
    'new-card': ['type', 'name'], fund: ['type', 'cardId', 'amount'], rules: ['type', 'cardId', 'name', 'perBuy', 'perDay', 'askAbove', 'categories'],
    freeze: ['type', 'cardId', 'frozen'], purchase: ['type', 'cardId', 'itemId'], resolve: ['type', 'orderId', 'action'], assistant: ['type', 'cardId', 'text'],
  };
  requireValue(typeof body?.type === 'string' && Object.hasOwn(types, body.type), 'Choose a supported account action.'); strictFields(body, types[body.type]);
  const now = Date.now(), c = state.cards.find(c => c.id === body.cardId);
  if (!['new-card', 'resolve'].includes(body.type) && !c) throw new AppError(404, 'card_missing', 'This card was not found in your account.');
  let next = state, effect = {}, audit = { kind: body.type, cardId: c?.id, mode: 'sandbox' };
  try {
    if (body.type === 'new-card') {
      next = newCard(state, cardName(body.name), now); const created = next.cards.at(-1); created.id = 'card-' + crypto.randomUUID(); next.selected = created.id;
      effect = { cardId: created.id }; audit.cardId = created.id;
    } else if (body.type === 'fund') {
      next = fundCard(state, c.id, cents(body.amount, 100_000), now); effect = { cardId: c.id, amount: body.amount }; audit.amount = body.amount;
    } else if (body.type === 'rules') {
      requireValue(Array.isArray(body.categories) && body.categories.length <= categories.length && body.categories.every(v => categories.includes(v)), 'Choose supported spending categories.');
      next = saveRules(state, c.id, { perBuy: cents(body.perBuy), perDay: cents(body.perDay), askAbove: cents(body.askAbove), categories: [...new Set(body.categories)] });
      next.cards.find(x => x.id === c.id).name = cardName(body.name); appendActivity(next, 'Spending rules updated for ' + cardName(body.name) + '.'); effect = { cardId: c.id };
    } else if (body.type === 'freeze') {
      requireValue(typeof body.frozen === 'boolean', 'Choose whether to freeze or unfreeze this card.'); c.frozen = body.frozen;
      appendActivity(next, c.name + (c.frozen ? ' frozen.' : ' unfrozen.'), 'info', now); effect = { cardId: c.id, frozen: c.frozen };
    } else if (body.type === 'purchase') {
      requireValue(state.orders.length < 5000, 'This sandbox account has reached its order limit.');
      next = purchase(state, c.id, body.itemId, now); const order = assignOrderIdentity(next); effect = { orderId: order.id, status: order.status }; audit.amount = order.amount;
    } else if (body.type === 'resolve') {
      const order = state.orders.find(o => o.id === body.orderId); if (!order) throw new AppError(404, 'order_missing', 'This order was not found in your account.');
      next = resolveOrder(state, order.id, body.action, now); effect = { orderId: order.id, status: next.orders.find(o => o.id === order.id).status }; audit.cardId = order.cardId; audit.amount = order.amount; audit.resolution = body.action;
    } else if (body.type === 'assistant') {
      requireValue(typeof body.text === 'string' && body.text.trim().length > 0 && body.text.trim().length <= 200, 'Use a request between 1 and 200 characters.');
      const text = body.text.trim(); appendMessage(state, c.id, text, 'user');
      try {
        requireValue(state.orders.length < 5000, 'This sandbox account has reached its order limit.');
        const item = parseRequest(text); next = purchase(state, c.id, item.id, now); const order = assignOrderIdentity(next);
        const reply = order.status === 'pending' ? `${item.name}: ${dollars(item.price)} reserved. Open Approvals to approve or decline this demo purchase.` : `${item.name} purchased for ${dollars(item.price)} in demo funds. Sample receipt: ${order.receipt}. No actual service or redeemable code was issued.`;
        appendMessage(next, c.id, reply, 'assistant'); effect = { orderId: order.id, status: order.status }; audit.amount = order.amount;
      } catch (error) { appendMessage(state, c.id, error.message, 'assistant'); next = state; effect = { rejected: true, message: error.message }; audit.rejected = true; audit.reason = error.message; }
    }
  } catch (error) { if (error instanceof AppError) throw error; throw new AppError(422, 'action_refused', error.message); }
  for (const accountCard of next.cards) cents(accountCard.balance);
  return { state: next, effect, audit };
}
