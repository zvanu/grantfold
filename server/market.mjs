import { recoverTypedDataAddress, keccak256, toHex } from 'viem';
import { AppError } from './store.mjs';
import { commission, feeFor, orderTotal } from '../shared/commission.mjs';
import { feeAuthorization, feeGasQuote } from './commission.mjs';
import { liveMarket, liveHeld, liveTotals, paymentTypedData } from '../shared/payment.mjs';
import { scheduledOrderAllowed, assertScheduledOrder } from './schedule-rules.mjs';

const addressPattern = /^0x[0-9a-fA-F]{40}$/, signaturePattern = /^0x[0-9a-fA-F]{130}$/;
const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
function liveAssert(value, code, message, status = 422) { if (!value) throw new AppError(status, code, message); }
export function liveFields(body, fields, optional = []) { liveAssert(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(k => [...fields, ...optional].includes(k)) && fields.every(k => typeof body[k] === 'string' && body[k].length > 0 && body[k].length <= 500), 'invalid_request', 'This live order request contains missing or unsupported fields.'); }
function findLiveOrder(state, id) { const order = state.liveOrders?.find(o => o.id === id); liveAssert(order, 'live_order_missing', 'This live order was not found in your account.', 404); return order; }
function liveBudget(state, cardId, amountMicros, excludeId, now) {
  const card = state.cards.find(c => c.id === cardId);
  liveAssert(card, 'card_missing', 'This card was not found in your account.', 404);
  liveAssert(!card.frozen, 'live_card_frozen', 'Unfreeze this card before paying for a live report.');
  liveAssert(card.categories.includes(liveMarket.category), 'live_category_refused', 'Market data is not allowed on this card.');
  liveAssert(amountMicros <= card.perBuy * 10_000, 'live_purchase_limit', 'The live price exceeds this card’s per-purchase limit.');
  const scoped = { ...state, liveOrders: (state.liveOrders || []).filter(o => o.id !== excludeId) }, totals = liveTotals(scoped, cardId, now);
  liveAssert(totals.spent + totals.held + amountMicros <= card.perDay * 10_000, 'live_daily_limit', 'The live price exceeds the daily limit, including live orders still being checked.');
  return card;
}
function liveMutation(state, order, kind, extra = {}) {
  return { state, effect: { orderId: order.id, ...extra }, audit: { kind, cardId: order.cardId, amountMicros: orderTotal(order), network: liveMarket.network, mode: 'live' } };
}
export function addLiveQuote(state, cardId, quote, now = Date.now()) {
  state.liveOrders ??= [];
  liveAssert(state.liveOrders.length < 100, 'live_order_capacity', 'This pilot account has reached its 100 live-order limit.');
  liveAssert(!state.liveOrders.some(o => o.cardId === cardId && (['processing', 'checking', 'needs_review', 'fee_due', 'fee_checking'].includes(o.status) || (o.status === 'agent_approval' && o.expiresAt > now))), 'live_order_unresolved', 'Check the previous live payment on this card before requesting another purchase.', 409);
  liveBudget(state, cardId, orderTotal(quote), null, now);
  liveAssert(state.liveOrders.filter(o => liveHeld(o, now)).length < 10, 'live_order_busy', 'Finish or cancel an existing live quote first.');
  const order = { id: 'live-' + crypto.randomUUID(), cardId, name: liveMarket.name, provider: liveMarket.provider, status: 'quoted', createdAt: now, expiresAt: now + Math.min(quote.accepted.maxTimeoutSeconds, 300) * 1000, ...quote };
  state.liveOrders.unshift(order);
  return liveMutation(state, order, 'live_quote');
}
export function prepareLiveOrder(state, orderId, wallet, now = Date.now(), pricing) {
  const order = findLiveOrder(state, orderId);
  liveAssert(addressPattern.test(wallet), 'wallet_invalid', 'Connect an Ethereum-compatible wallet.');
  liveAssert(['quoted', 'ready'].includes(order.status), 'live_order_started', 'This order has already started. Open it from Activity.', 409);
  liveAssert(order.expiresAt > now + 15_000, 'live_quote_expired', 'This quote expired. Request a fresh price before signing.');
  if (pricing && !order.authorization && Number.isInteger(order.feeBps)) {
    liveAssert(pricing.feePolicy?.holder === wallet.toLowerCase() && pricing.feeMicros === feeFor(order.amountMicros, pricing.feeBps) && pricing.totalMicros === order.amountMicros + pricing.feeMicros && pricing.feeRecipient === commission.recipient, 'fee_quote_invalid', 'This fee does not match the connected wallet.');
    Object.assign(order, pricing);
  }
  liveBudget(state, order.cardId, orderTotal(order), order.id, now);
  if (order.authorization) liveAssert(sameAddress(order.authorization.from, wallet), 'live_wallet_changed', 'This quote belongs to another wallet. Cancel it and request a new quote.', 409);
  else {
    const bytes = crypto.getRandomValues(new Uint8Array(32)), nonce = '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    order.authorization = { from: wallet, to: order.accepted.payTo, value: order.accepted.amount, validAfter: '0', validBefore: String(Math.floor(order.expiresAt / 1000) - 5), nonce };
  }
  if (order.feeMicros && !order.feeAuthorization) order.feeAuthorization = feeAuthorization(wallet, order.feeMicros, now);
  order.status = 'ready';
  return liveMutation(state, order, 'live_wallet_prepared');
}
export function cancelLiveOrder(state, orderId) {
  const order = findLiveOrder(state, orderId);
  liveAssert(['quoted', 'ready', 'agent_approval', 'cancelled'].includes(order.status), 'live_cancel_refused', 'A submitted payment must be checked before its reservation can be released.', 409);
  order.status = 'cancelled'; return liveMutation(state, order, 'live_cancelled');
}
export function makePaymentPayload(order, signature) {
  const extensions = order.paymentExtensions ? structuredClone(order.paymentExtensions) : undefined;
  if (extensions?.['payment-identifier']) extensions['payment-identifier'].info.id = order.id;
  return { x402Version: 2, resource: order.resource, accepted: order.accepted, payload: { signature, authorization: order.authorization }, ...(extensions ? { extensions } : {}) };
}
export async function verifyLiveSignature(order, signature) {
  liveAssert(order.authorization && signaturePattern.test(signature), 'live_signature_invalid', 'A valid one-time wallet signature is required.');
  try { const signer = await recoverTypedDataAddress({ ...paymentTypedData(order.authorization), signature }); liveAssert(sameAddress(signer, order.authorization.from), 'live_signature_invalid', 'The signature does not match this order’s wallet.'); }
  catch { throw new AppError(422, 'live_signature_invalid', 'The signature does not match this order’s exact payment.'); }
}

async function boundedJson(response, limit = 100_000) {
  if (!response.body) throw Error('Empty response');
  const reader = response.body.getReader(), parts = []; let size = 0;
  for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); throw Error('Response too large'); } parts.push(part.value); }
  const bytes = new Uint8Array(size); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
function decodePaymentHeader(value) { liveAssert(value && value.length < 20_000, 'live_receipt_missing', 'The provider response needs payment reconciliation.', 502); try { return JSON.parse(atob(value)); } catch { throw new AppError(502, 'live_receipt_invalid', 'The provider payment receipt could not be read.'); } }
async function providerRefusal(response) {
  let challenge, body;
  try { const header = response.headers.get('payment-required'); if (header && header.length < 60_000) challenge = JSON.parse(atob(header)); } catch {}
  try { body = await boundedJson(response); } catch {}
  const safeCode = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,79}$/i.test(value) ? value : undefined;
  const error = new AppError(502, 'live_provider_refused', 'The provider did not accept this payment. Check this same order before starting another purchase.');
  error.providerStatus = response.status;
  error.providerReason = safeCode(challenge?.error) || safeCode(body?.reason) || safeCode(body?.errorReason) || safeCode(body?.invalidReason) || safeCode(body?.error) || (/^Payer balance \d+ is less than the authorized \d+$/.test(challenge?.error || '') ? 'insufficient_funds' : 'unconfirmed_response');
  const delay = response.headers.get('retry-after');
  if (/^\d{1,4}$/.test(delay || '')) error.retryAfter = Math.min(Number(delay), 300);
  return error;
}
function normalizeReport(data) {
  liveAssert(data?.currency === 'usd' && Array.isArray(data.coins) && data.coins.length >= 1 && data.coins.length <= 100, 'live_report_invalid', 'The provider did not return the expected market overview.', 502);
  return { currency: 'usd', count: Math.min(10, data.coins.length), credit: 'Data provided by CoinGecko via Agent402.', coins: data.coins.slice(0, 10).map(c => {
    liveAssert(typeof c.name === 'string' && typeof c.symbol === 'string' && Number.isFinite(c.price) && c.price >= 0, 'live_report_invalid', 'The market overview contains invalid prices.', 502);
    return { name: c.name.slice(0, 80), symbol: c.symbol.slice(0, 20), price: c.price, change24hPct: Number.isFinite(c.change24hPct) ? c.change24hPct : null, marketCap: Number.isFinite(c.marketCap) ? c.marketCap : null };
  }) };
}
export class MarketProvider {
  constructor(fetcher = fetch) { this.fetcher = fetcher; }
  async quote() {
    try {
      const response = await this.fetcher(liveMarket.url, { redirect: 'error', signal: AbortSignal.timeout(12_000), headers: { Accept: 'application/json' } });
      liveAssert(response.status === 402, 'live_quote_unavailable', 'The provider is not offering a paid quote right now.', 503);
      const raw = response.headers.get('payment-required'); liveAssert(raw && raw.length < 60_000, 'live_quote_invalid', 'The provider payment quote is missing.', 503);
      const challenge = JSON.parse(atob(raw)); await response.body?.cancel();
      liveAssert(challenge.x402Version === 2 && challenge.resource?.url === liveMarket.url && Array.isArray(challenge.accepts), 'live_quote_invalid', 'The provider quote does not match this product.', 503);
      const accepted = challenge.accepts.find(a => a.scheme === 'exact' && a.network === liveMarket.network && sameAddress(a.asset, liveMarket.asset) && a.extra?.name === 'Global Dollar' && a.extra?.version === '1' && !a.extra?.assetTransferMethod);
      liveAssert(accepted && sameAddress(accepted.payTo, liveMarket.payTo) && typeof accepted.amount === 'string' && /^\d{1,7}$/.test(accepted.amount) && Number(accepted.amount) > 0 && Number(accepted.amount) <= liveMarket.maxAmountMicros && Number.isSafeInteger(accepted.maxTimeoutSeconds) && accepted.maxTimeoutSeconds >= 60 && accepted.maxTimeoutSeconds <= 600, 'live_rail_unavailable', 'A supported USDG quote on Robinhood Chain is not available. No payment was requested.', 503);
      const amountMicros = Number(accepted.amount), feeMicros = feeFor(amountMicros);
      const declaration = challenge.extensions?.['payment-identifier'];
      if (declaration !== undefined) liveAssert(declaration && typeof declaration === 'object' && !Array.isArray(declaration) && declaration.info && typeof declaration.info === 'object' && typeof declaration.info.required === 'boolean' && declaration.schema && typeof declaration.schema === 'object' && !Array.isArray(declaration.schema) && JSON.stringify(declaration).length <= 10_000, 'live_extension_invalid', 'The provider payment identifier declaration is unsupported. No payment was requested.', 503);
      return { amountMicros, feeMicros, totalMicros: amountMicros + feeMicros, feeBps: commission.bps, feeRecipient: commission.recipient, accepted: structuredClone(accepted), resource: structuredClone(challenge.resource), ...(declaration ? { paymentExtensions: { 'payment-identifier': structuredClone(declaration) } } : {}) };
    } catch (error) { if (error instanceof AppError) throw error; throw new AppError(503, 'live_quote_unavailable', 'The provider quote could not be loaded. No payment was requested.'); }
  }
  async purchase(order, payload) {
    const { x402Version, resource, accepted, payload: signed, extensions } = payload;
    const payment = btoa(Array.from(new TextEncoder().encode(JSON.stringify({ x402Version, resource, accepted, payload: signed, extensions })), byte => String.fromCharCode(byte)).join(''));
    const response = await this.fetcher(liveMarket.url, { redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json', 'PAYMENT-SIGNATURE': payment, 'Idempotency-Key': order.id } });
    if (response.status !== 200) throw await providerRefusal(response);
    const data = await boundedJson(response), settlement = decodePaymentHeader(response.headers.get('payment-response'));
    liveAssert(settlement.success === true && settlement.network === liveMarket.network && (settlement.payer === undefined || sameAddress(settlement.payer, order.authorization.from)) && /^0x[0-9a-fA-F]{64}$/.test(settlement.transaction), 'live_receipt_invalid', 'The provider receipt needs reconciliation on Robinhood Chain.', 502);
    return { report: normalizeReport(data), settlement };
  }
  async rpc(method, params) {
    const response = await this.fetcher(liveMarket.rpc, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    liveAssert(response.ok, 'live_chain_unavailable', 'Payment verification is waiting for Robinhood Chain.', 503);
    const data = await boundedJson(response, 500_000); liveAssert(!data.error, 'live_chain_unavailable', 'Payment verification is waiting for Robinhood Chain.', 503); return data.result;
  }
  async verifySettlement(order, capture, expectedRecipient = liveMarket.payTo) {
    liveAssert(await this.rpc('eth_chainId', []) === '0x1237', 'live_chain_invalid', 'The settlement network could not be verified.', 503);
    const receipt = await this.rpc('eth_getTransactionReceipt', [capture.settlement.transaction]);
    liveAssert(receipt?.status === '0x1' && receipt.transactionHash?.toLowerCase() === capture.settlement.transaction.toLowerCase() && /^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash || ''), 'live_settlement_pending', 'The payment receipt is waiting for on-chain confirmation.', 503);
    const transferTopic = keccak256(toHex('Transfer(address,address,uint256)')), usedTopic = keccak256(toHex('AuthorizationUsed(address,bytes32)'));
    const topicAddress = value => typeof value === 'string' && value.length === 66 ? '0x' + value.slice(-40) : '';
    const logs = (receipt.logs || []).filter(l => sameAddress(l.address, liveMarket.asset));
    const transfer = logs.some(l => l.topics?.[0] === transferTopic && sameAddress(topicAddress(l.topics[1]), order.authorization.from) && sameAddress(topicAddress(l.topics[2]), expectedRecipient) && /^0x[0-9a-fA-F]{64}$/.test(l.data) && BigInt(l.data) === BigInt(order.amountMicros));
    const used = logs.some(l => {
      if (l.topics?.[0] !== usedTopic) return false;
      const data = /^0x(?:[0-9a-fA-F]{64}){1,2}$/.test(l.data || '') ? l.data.slice(2) : '';
      const authorizer = l.topics[1] ? topicAddress(l.topics[1]) : topicAddress('0x' + data.slice(0, 64));
      const nonce = l.topics[2] || ('0x' + data.slice(l.topics[1] ? 0 : 64, l.topics[1] ? 64 : 128));
      return sameAddress(authorizer, order.authorization.from) && nonce.toLowerCase() === order.authorization.nonce.toLowerCase();
    });
    liveAssert(transfer && used, 'live_transfer_mismatch', 'The transaction does not match this order’s exact USDG authorization.', 503);
    return { transaction: capture.settlement.transaction, blockHash: receipt.blockHash, gasWei: receipt.gasUsed && receipt.effectiveGasPrice ? String(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)) : null };
  }
  async expiredAuthorization(order) {
    liveAssert(await this.rpc('eth_chainId', []) === '0x1237', 'live_chain_invalid', 'The settlement network could not be verified.', 503);
    const block = await this.rpc('eth_getBlockByNumber', ['latest', false]);
    liveAssert(/^0x[0-9a-f]+$/i.test(block?.timestamp || '') && Number(BigInt(block.timestamp)) > Number(order.authorization.validBefore) + 30, 'live_expiry_pending', 'Wait for the authorization to expire on-chain before releasing this order.', 503);
    const data = keccak256(toHex('authorizationState(address,bytes32)')).slice(0, 10) + order.authorization.from.slice(2).toLowerCase().padStart(64, '0') + order.authorization.nonce.slice(2);
    const result = await this.rpc('eth_call', [{ to: liveMarket.asset, data }, 'latest']);
    liveAssert(/^0x0{63}[01]$/.test(result || ''), 'live_nonce_unknown', 'The payment authorization state could not be verified.', 503);
    return { used: result.endsWith('1') };
  }
}

export async function submitLivePayment(store, userId, orderId, signature, provider = new MarketProvider(), options = {}) {
  let snapshot = await store.get(userId), order = findLiveOrder(snapshot.state, orderId);
  if (order.status === 'completed' || (order.providerReceipt && ['fee_due', 'fee_checking'].includes(order.status))) return { ...snapshot, effect: { orderId } };
  const existing = await store.paymentJob(userId, orderId);
  if (existing) liveAssert(existing.payload.payload.signature === signature, 'live_payment_changed', 'Recover the saved payment for this order. A new signature is not accepted.', 409);
  else { liveAssert(order.status === 'ready', 'live_order_not_ready', 'Connect a wallet and prepare this order first.', 409); await verifyLiveSignature(order, signature); }
  const feeSignature = existing?.payload?._feeSignature || options.feeSignature;
  if (!existing && order.feeMicros) {
    await verifyLiveSignature({ authorization: order.feeAuthorization }, feeSignature);
    await feeGasQuote(order, feeSignature, provider);
  }
  let capture = existing?.capture;
  const attempt = crypto.randomUUID(), now = Date.now();
  let recoveryOnly = false;
  if (existing && !capture && Number(order.authorization.validBefore) * 1000 <= now + 3000) {
    const authorization = await provider.expiredAuthorization(order);
    if (!authorization.used) return store.mutate(userId, 'live-expired-' + orderId, orderId, state => { const current = findLiveOrder(state, orderId); if (current.status !== 'completed') { current.status = 'failed'; current.message = 'Authorization expired unused on-chain. No payment settled; this reservation was released.'; } return liveMutation(state, current, 'live_expired_unpaid'); });
    recoveryOnly = true;
  }
  if (existing && !capture && !recoveryOnly && order.agent) {
    const grant = snapshot.state.agents?.[order.cardId];
    if (!grant?.enabled || grant.validUntil <= now || grant.nonce !== order.agentGrantNonce || snapshot.state.cards.find(c => c.id === order.cardId)?.frozen || !scheduledOrderAllowed(snapshot.state, order, now)) {
      const data = keccak256(toHex('authorizationState(address,bytes32)')).slice(0, 10) + order.authorization.from.slice(2).toLowerCase().padStart(64, '0') + order.authorization.nonce.slice(2);
      const used = await provider.rpc('eth_call', [{ to: liveMarket.asset, data }, 'latest']);
      liveAssert(/^0x0{63}1$/.test(used || ''), 'agent_revoked', 'This agent consent no longer allows a new provider payment.', 403);
      recoveryOnly = true;
    }
  }
  if (!capture) {
    const claimed = await store.mutate(userId, 'live-claim-' + attempt, attempt, state => {
      const current = findLiveOrder(state, orderId);
      if (current.status === 'completed' || (current.status === 'processing' && current.leaseUntil > now)) return liveMutation(state, current, 'live_status', { dispatch: false });
      liveAssert(!['cancelled', 'expired', 'failed'].includes(current.status), 'live_order_closed', 'This live order is closed.', 409);
      if (!recoveryOnly) {
        assertScheduledOrder(state, current, now);
        if (current.agent) {
          const grant = state.agents?.[current.cardId];
          liveAssert(grant?.enabled && grant.validUntil > now && grant.nonce === current.agentGrantNonce && grant.feeBps === commission.bps && grant.feeRecipient === commission.recipient, 'agent_revoked', 'The agent consent changed before payment. No new payment was submitted.', 403);
          liveAssert(orderTotal(current) <= grant.perBuyMicros, 'agent_purchase_limit', 'The purchase exceeds the signed agent limit.');
          const totals = liveTotals({ ...state, liveOrders: state.liveOrders.filter(o => o.id !== current.id) }, current.cardId, now);
          liveAssert(totals.spent + totals.held + orderTotal(current) <= grant.perDayMicros, 'agent_daily_limit', 'The purchase exceeds the signed daily agent limit.');
        }
        liveBudget(state, current.cardId, orderTotal(current), current.id, now);
        liveAssert(Number(current.authorization.validBefore) * 1000 > now + 3000, 'live_payment_expired', 'This authorization expired. Its status must be checked before starting another payment.', 409);
      }
      current.status = 'processing'; current.attemptId = attempt; current.leaseUntil = now + 30_000; current.submittedAt ??= now; current.message = 'Payment submitted. Waiting for the provider.';
      const result = liveMutation(state, current, 'live_submitted', { dispatch: true });
      if (!existing) result.privateJob = { orderId, payload: { ...makePaymentPayload(current, signature), ...(current.feeMicros ? { _feeSignature: feeSignature } : {}) } };
      return result;
    });
    if (!claimed.effect.dispatch) return claimed;
    order = findLiveOrder(claimed.state, orderId);
    try {
      const job = await store.paymentJob(userId, orderId);
      capture = await provider.purchase(order, job.payload);
      await store.capturePayment(userId, orderId, capture);
    } catch (error) {
      return store.mutate(userId, 'live-uncertain-' + attempt, attempt, state => { const current = findLiveOrder(state, orderId); if (current.attemptId === attempt && current.status !== 'completed') { current.status = 'needs_review'; current.message = error?.providerStatus === 402 ? 'The provider refused this payment. Check this same order to reconcile its authorization before paying again.' : 'Delivery is unconfirmed. Check this same payment; do not create a second purchase.'; if (Number.isInteger(error?.providerStatus)) current.deliveryIssue = { httpStatus: error.providerStatus, reason: error.providerReason, ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }) }; } return liveMutation(state, current, 'live_delivery_uncertain'); });
    }
  }
  try {
    const verified = await provider.verifySettlement(order, capture);
    if (order.feeMicros) {
      const feeFromBlock = await provider.rpc('eth_blockNumber', []);
      return store.mutate(userId, 'live-provider-' + orderId, orderId, state => {
        const current = findLiveOrder(state, orderId);
        if (current.status !== 'completed') { current.status = 'fee_due'; current.providerReceipt = verified; current.providerCompletedAt = Date.now(); current.feeFromBlock = feeFromBlock; current.message = 'Provider delivery saved. Complete the agreed Grantfold fee to open the report.'; }
        return liveMutation(state, current, 'live_provider_confirmed');
      });
    }
    return store.mutate(userId, 'live-complete-' + orderId, orderId, state => { const current = findLiveOrder(state, orderId); current.status = 'completed'; current.completedAt = Date.now(); current.report = capture.report; current.receipt = verified; current.message = 'Paid in USDG on Robinhood Chain. Market overview delivered.'; return liveMutation(state, current, 'live_completed'); });
  } catch {
    return store.mutate(userId, 'live-check-' + crypto.randomUUID(), attempt, state => { const current = findLiveOrder(state, orderId); if (current.status !== 'completed') { current.status = 'checking'; current.message = 'Report received. On-chain payment confirmation is still being checked. Use Check payment to continue.'; } return liveMutation(state, current, 'live_confirmation_pending'); });
  }
}
