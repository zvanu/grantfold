import { AppError } from './store.mjs';
import { quoteForAgent, addAgentQuote, agentStatus } from './agents.mjs';
import { liveHeld, usdg } from '../shared/payment.mjs';
import { orderTotal } from '../shared/commission.mjs';
import { commissionQuote } from './discounts.mjs';
import { formatEther, formatUnits } from 'viem';
import { stopCardSchedule } from './schedule-rules.mjs';

// A fixed paid product, requested explicitly. Questions, negations and demo
// market-data passes must never become a live payment request.
export function isLiveMarketRequest(text) {
  return typeof text === 'string' && /^(?:(?:please\s+)?(?:buy|purchase|order|get(?:\s+me)?)\s+(?:a\s+)?(?:(?:live|crypto)\s+)?market overview|(?:купи|купить|закажи|заказать)\s+(?:мне\s+)?(?:обзор (?:крипто)?рынка|(?:live|crypto) market overview))[.!]?$/iu.test(text.trim());
}
const pendingOrder = (state, cardId) => (state.liveOrders || []).find(o => o.cardId === cardId && liveHeld(o));
function message(state, cardId, text, type, extra = {}) {
  state.messages ??= {}; state.messages[cardId] ??= [];
  state.messages[cardId].push({ type, text, ...extra });
  state.messages[cardId] = state.messages[cardId].slice(-40);
}

export function assistantControlIntent(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (/^(?:(?:check|show)(?: my)? agent balance|what(?:'s| is) my agent balance|(?:проверь|покажи) баланс(?: агента)?|баланс агента|сколько осталось на кошельке)[.!?]?$/iu.test(value)) return 'balance';
  if (/^(?:(?:check|show) my (?:GFLD fee|discount)|what(?:'s| is) my (?:fee|discount)|какая у меня (?:скидка|комиссия)|проверь скидку(?: GFLD)?|моя комиссия)[.!?]?$/iu.test(value)) return 'fee';
  if (/^(?:(?:pause|stop)(?: my)? agent|поставь агента на паузу|останови агента)[.!]?$/iu.test(value)) return 'pause';
  return null;
}

export async function assistantControl(store, env, user, key, hash, body, provider) {
  if (Object.keys(body).some(k => !['type', 'cardId', 'text'].includes(k)) || typeof body.cardId !== 'string' || typeof body.text !== 'string' || body.text.length > 200) throw new AppError(422, 'invalid_request', 'Use a card and a supported agent command.');
  const intent = assistantControlIntent(body.text);
  if (!intent) throw new AppError(422, 'assistant_command', 'Choose balance, fee or pause.');
  const prior = await store.receipt(user.id, key, hash);
  if (prior) return { ...await store.get(user.id), effect: prior, replayed: true };
  const { state: snapshot } = await store.get(user.id);
  if (!snapshot.cards.some(c => c.id === body.cardId)) throw new AppError(404, 'card_missing', 'This card was not found in your account.');
  const grant = snapshot.agents?.[body.cardId];
  const holder = grant?.owner || user.address;
  let reply, connectAgent = false;
  if (intent === 'balance') {
    try {
      const { wallet } = await agentStatus(store, env, user.id, body.cardId, provider);
      if (!wallet) { reply = 'This card has no agent wallet yet. Set one up in Connect AI; demo balance is separate.'; connectAgent = true; }
      else reply = `Live agent wallet: ${wallet.address}. Balance: ${usdg(Number(wallet.usdgMicros))} + ${formatEther(BigInt(wallet.ethWei))} ETH. New purchases: ${grant?.enabled && grant.validUntil > Date.now() ? 'enabled within consent' : 'paused or consent expired'}. Checked on Robinhood Chain at ${new Date().toISOString()}. This balance check made no purchase.`;
    } catch { reply = 'The live wallet balance could not be verified. Try Check agent balance again later. This check made no purchase and did not change your permissions.'; }
  } else if (intent === 'fee') {
    if (!holder) { reply = 'Link an owner wallet in Connect AI to check its GFLD service fee. This check does not buy tokens or authorize token spending.'; connectAgent = true; }
    else try {
      const pricing = await commissionQuote(1_000_000, holder, provider, env.GRANTFOLD_FEE_POLICY);
      const balance = pricing.feePolicy.balance ? `${formatUnits(BigInt(pricing.feePolicy.balance), pricing.feePolicy.decimals)} GFLD` : 'discounts inactive';
      reply = `Your service fee for a new quote is ${pricing.feeBps / 100}%. Holder: ${holder}. Balance snapshot: ${balance}. For a 1 USDG provider price, the fee would be ${usdg(pricing.feeMicros)}; network gas is separate. ${grant ? 'The linked owner’s GFLD counts, not tokens in the agent wallet. ' : ''}Existing quotes keep their saved fee. No purchase or token approval was made.`;
    } catch { reply = 'GFLD eligibility could not be verified. Try Check my GFLD fee again later. Existing quotes and permissions were not changed; no purchase or token approval was made.'; }
  }
  return store.mutate(user.id, key, hash, state => {
    if (!state.cards.some(c => c.id === body.cardId)) throw new AppError(404, 'card_missing', 'This card was not found in your account.');
    if (intent === 'pause') {
      if (state.agents?.[body.cardId]) state.agents[body.cardId].enabled = false;
      stopCardSchedule(state, body.cardId, 'The agent was paused from Assistant. Authorize a fresh schedule to restart daily purchases.');
      reply = 'Agent paused. New autonomous purchases are disabled for this card. Already submitted payments and their agreed fees can still finish. Your balance remains in the agent wallet; Return funds needs the linked owner’s signature.';
    }
    message(state, body.cardId, body.text.trim(), 'user');
    message(state, body.cardId, reply, 'assistant', connectAgent ? { connectAgent: true } : {});
    return { state, effect: { agentControl: intent, ...(connectAgent ? { connectAgent: true } : {}) }, audit: { kind: 'assistant_agent_' + intent, cardId: body.cardId, mode: 'agent' } };
  });
}

export async function prepareAssistantPurchase(store, env, userId, key, hash, body, provider) {
  if (Object.keys(body).some(k => !['type', 'cardId', 'text'].includes(k)) || typeof body.cardId !== 'string' || typeof body.text !== 'string' || body.text.trim().length > 200) throw new AppError(422, 'invalid_request', 'Use a card and an explicit market overview request.');
  const prior = await store.receipt(userId, key, hash);
  if (prior) return { ...await store.get(userId), effect: prior, replayed: true };
  const { state: snapshot } = await store.get(userId);
  if (!snapshot.cards.some(c => c.id === body.cardId)) throw new AppError(404, 'card_missing', 'This card was not found in your account.');
  const grant = snapshot.agents?.[body.cardId], pending = pendingOrder(snapshot, body.cardId);
  const active = grant?.enabled && grant.validUntil > Date.now();
  const quote = !pending && active ? await quoteForAgent(store, env, userId, body.cardId, provider) : null;
  return store.mutate(userId, key, hash, state => {
    const cardId = body.cardId, existing = pendingOrder(state, cardId);
    message(state, cardId, body.text.trim(), 'user');
    let effect, kind;
    if (existing) {
      message(state, cardId, 'Your previous live purchase is still open. Review or recover that same order before starting another.', 'assistant', { liveOrderId: existing.id });
      effect = { orderId: existing.id, live: true, reused: true }; kind = 'assistant_live_recovery';
    } else if (!active) {
      message(state, cardId, 'Set up or renew this card’s agent wallet in Connect AI, then fund it with USDG and ETH on Robinhood Chain. Return here to request a live market overview.', 'assistant', { connectAgent: true });
      effect = { connectAgent: true }; kind = 'assistant_agent_setup';
    } else {
      if (!quote) throw new AppError(409, 'assistant_order_changed', 'The previous order changed. Reload the account and review its status.');
      const created = addAgentQuote(state, cardId, quote), orderId = created.effect.orderId;
      message(state, cardId, `Live market overview: ${usdg(orderTotal(quote))} total (${usdg(quote.amountMicros)} provider + ${usdg(quote.feeMicros)} Grantfold fee). Review the exact price, then buy with your agent wallet. The wallet also pays network gas.`, 'assistant', { liveOrderId: orderId });
      effect = { orderId, live: true }; kind = 'assistant_live_quote';
    }
    return { state, effect, audit: { kind, cardId, mode: 'agent', ...(effect.orderId ? { orderId: effect.orderId } : {}) } };
  });
}
