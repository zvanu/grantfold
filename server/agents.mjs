import { recoverTypedDataAddress, encodeFunctionData, parseUnits } from 'viem';
import { AppError } from './store.mjs';
import { commissionQuote } from './discounts.mjs';
import { WalletVault } from './vault.mjs';
import { addLiveQuote, prepareLiveOrder, submitLivePayment } from './market.mjs';
import { feeCall, checkCommission, rememberCommissionTransaction, randomNonce } from './commission.mjs';
import { liveMarket, liveHeld, liveTotals, paymentTypedData } from '../shared/payment.mjs';
import { commission, orderTotal, consentTypedData, withdrawalTypedData } from '../shared/commission.mjs';
import { assertScheduledOrder, stopCardSchedule } from './schedule-rules.mjs';

const address = /^0x[0-9a-f]{40}$/i;
function demand(ok, code, message, status = 422) { if (!ok) throw new AppError(status, code, message); }
function cardOf(state, id) { const card = state.cards.find(c => c.id === id); demand(card, 'card_missing', 'This card does not belong to your account.', 404); return card; }
function grantOf(state, cardId, amount = 0, excludeId) {
  const card = cardOf(state, cardId), grant = state.agents?.[cardId];
  demand(grant?.enabled && grant.validUntil > Date.now(), 'agent_disabled', 'Enable a current spending consent for this agent wallet.', 403);
  demand(!card.frozen, 'agent_frozen', 'This card is frozen.');
  demand(card.categories.includes(liveMarket.category), 'agent_category_refused', 'Market data is not allowed on this card.');
  demand(grant.feeBps === commission.bps && grant.feeRecipient === commission.recipient, 'agent_consent_changed', 'Review the current fee and renew this wallet’s consent.', 403);
  demand(amount <= Math.min(grant.perBuyMicros, card.perBuy * 10000), 'agent_purchase_limit', 'The total including the fee exceeds the approved per-purchase limit.');
  const scoped = { ...state, liveOrders: (state.liveOrders || []).filter(o => o.id !== excludeId) }, totals = liveTotals(scoped, cardId);
  demand(totals.spent + totals.held + amount <= Math.min(grant.perDayMicros, card.perDay * 10000), 'agent_daily_limit', 'The total including the fee exceeds the approved daily limit.');
  return grant;
}
const event = (state, effect, kind, cardId) => ({ state, effect, audit: { kind, cardId, mode: 'agent' } });
export async function prepareAgent(store, env, userId, cardId, owner, origin) {
  demand(address.test(owner) && !/^0x0{40}$/i.test(owner), 'agent_owner_invalid', 'Connect the wallet that should receive withdrawals.');
  const snapshot = await store.get(userId); cardOf(snapshot.state, cardId);
  const pendingSetup = snapshot.state.agentSetups?.[cardId];
  if (pendingSetup && pendingSetup.owner.toLowerCase() === owner.toLowerCase() && pendingSetup.site === origin && pendingSetup.setupExpiresAt > Date.now()) return { ...snapshot, effect: { cardId, setup: pendingSetup } };
  const vault = new WalletVault(store, env), row = await vault.create(userId, cardId, owner);
  return store.mutate(userId, 'agent-setup-' + crypto.randomUUID(), cardId, state => {
    const card = cardOf(state, cardId);
    demand(!(state.agentWithdrawals || []).some(w => w.cardId === cardId && !['completed', 'cancelled', 'failed'].includes(w.status)), 'agent_withdrawal_pending', 'Finish this wallet’s withdrawal before enabling new purchases.', 409);
    state.agentSetups ??= {};
    const setup = { cardId, address: row.address, owner: row.owner_address, site: origin, perBuyMicros: card.perBuy * 10000, perDayMicros: card.perDay * 10000, validUntil: Date.now() + 7 * 86400_000, setupExpiresAt: Date.now() + 300_000, nonce: randomNonce() };
    state.agentSetups[cardId] = setup;
    return event(state, { cardId, setup }, 'agent_consent_prepared', cardId);
  });
}
export async function enableAgent(store, userId, cardId, signature, origin) {
  const snapshot = await store.get(userId), setup = snapshot.state.agentSetups?.[cardId];
  if (!setup && snapshot.state.agents?.[cardId]) {
    const grant = snapshot.state.agents[cardId]; let replaySigner;
    try { replaySigner = await recoverTypedDataAddress({ ...consentTypedData(grant, origin), signature }); } catch {}
    if (grant.site === origin && replaySigner?.toLowerCase() === grant.owner.toLowerCase()) return { ...snapshot, effect: { cardId, replayed: true } };
  }
  demand(setup && setup.site === origin && setup.setupExpiresAt > Date.now(), 'agent_setup_expired', 'Prepare a fresh agent consent.');
  let signer; try { signer = await recoverTypedDataAddress({ ...consentTypedData(setup, origin), signature }); } catch {}
  demand(signer?.toLowerCase() === setup.owner.toLowerCase(), 'agent_owner_signature', 'The linked owner wallet must sign this exact consent.');
  return store.mutate(userId, 'agent-enable-' + setup.nonce, setup.nonce, state => {
    demand(!(state.agentWithdrawals || []).some(w => w.cardId === cardId && !['completed', 'cancelled', 'failed'].includes(w.status)), 'agent_withdrawal_pending', 'Finish or cancel this wallet’s return before enabling purchases.', 409);
    demand(state.agentSetups?.[cardId]?.nonce === setup.nonce, 'agent_setup_changed', 'This setup was replaced. Review the latest consent.', 409);
    state.agents ??= {}; state.agents[cardId] = { ...setup, consentSignature: signature, enabled: true, feeBps: commission.bps, feeRecipient: commission.recipient, maxGasWei: commission.maxGasWei, dailyGasWei: commission.dailyGasWei };
    stopCardSchedule(state, cardId, 'The agent consent changed. Authorize a fresh daily schedule.');
    delete state.agentSetups[cardId]; return event(state, { cardId }, 'agent_enabled', cardId);
  });
}
export async function revokeAgent(store, userId, cardId) {
  return store.mutate(userId, 'agent-revoke-' + crypto.randomUUID(), cardId, state => { cardOf(state, cardId); if (state.agents?.[cardId]) state.agents[cardId].enabled = false; stopCardSchedule(state, cardId, 'The agent was paused. Authorize a fresh daily schedule to restart.'); return event(state, { cardId }, 'agent_revoked', cardId); });
}
export async function agentStatus(store, env, userId, cardId, provider) {
  const snapshot = await store.get(userId); cardOf(snapshot.state, cardId);
  const row = await new WalletVault(store, env).row(userId, cardId);
  if (!row) return { ...snapshot, wallet: null };
  demand(await provider.rpc('eth_chainId', []) === '0x1237', 'agent_chain_mismatch', 'The wallet network could not be verified.', 503);
  const tokenBalance = await provider.rpc('eth_call', [{ to: liveMarket.asset, data: '0x70a08231' + row.address.slice(2).padStart(64, '0') }, 'latest']);
  const nativeBalance = await provider.rpc('eth_getBalance', [row.address, 'latest']);
  return { ...snapshot, wallet: { address: row.address, owner: row.owner_address, usdgMicros: BigInt(tokenBalance).toString(), ethWei: BigInt(nativeBalance).toString(), grant: snapshot.state.agents?.[cardId] || null } };
}
async function dailyGasCapacity(store, userId, cardId, provider, walletAddress) {
  const dateStart = new Date().setUTCHours(0, 0, 0, 0);
  const rows = await store.db.prepare('SELECT raw_transaction FROM agent_transactions WHERE user_id = ? AND wallet_address = ? AND job_id LIKE ? AND created_at >= ?').bind(userId, walletAddress.toLowerCase(), 'fee-%', dateStart).all();
  const { parseTransaction } = await import('viem');
  let reserved = 0n; for (const row of rows.results) { const tx = parseTransaction(row.raw_transaction); reserved += tx.gas * tx.gasPrice; }
  demand(reserved + BigInt(commission.maxGasWei) <= BigInt(commission.dailyGasWei), 'agent_daily_gas', 'This wallet reached its consented daily network gas cap.');
}
export async function settleAgentFee(store, env, userId, orderId, provider, vault = new WalletVault(store, env)) {
  let snapshot = await checkCommission(store, userId, orderId, provider), order = snapshot.state.liveOrders.find(o => o.id === orderId);
  if (order.status === 'completed') return snapshot;
  const feeJobId = 'fee-' + orderId + (order.feeAttempt ? '-retry-' + order.feeAttempt : '');
  demand((order.feeAttempt || 0) < 3, 'agent_fee_retries', 'Three fee attempts reverted. No new purchase was made; review the saved order before trying again.');
  const existing = await vault.savedTransaction(userId, feeJobId);
  if (existing) {
    const job = await store.paymentJob(userId, orderId);
    await vault.signTransaction(userId, order.cardId, feeJobId, feeCall(order, job.payload._feeSignature), provider);
    await rememberCommissionTransaction(store, userId, orderId, existing.transaction_hash);
    await vault.broadcast(existing, provider);
    return checkCommission(store, userId, orderId, provider, existing.transaction_hash);
  }
  await dailyGasCapacity(store, userId, order.cardId, provider, order.authorization.from);
  const job = await store.paymentJob(userId, orderId), request = feeCall(order, job.payload._feeSignature);
  const saved = await vault.signTransaction(userId, order.cardId, feeJobId, request, provider);
  await rememberCommissionTransaction(store, userId, orderId, saved.transaction_hash);
  await vault.broadcast(saved, provider);
  return checkCommission(store, userId, orderId, provider, saved.transaction_hash);
}
export async function executeAgentOrder(store, env, userId, orderId, provider) {
  let snapshot = await store.get(userId), order = snapshot.state.liveOrders?.find(o => o.id === orderId);
  demand(order?.agent === true, 'agent_order_missing', 'This agent order was not found.', 404);
  if (order.status === 'completed' || order.status === 'agent_approval') return snapshot;
  const vault = new WalletVault(store, env);
  return vault.withLock(userId, order.cardId, async () => {
    snapshot = await store.get(userId); order = snapshot.state.liveOrders.find(o => o.id === orderId);
    if (['fee_due', 'fee_checking'].includes(order.status)) return settleAgentFee(store, env, userId, orderId, provider, vault);
    if (!order.submittedAt) {
      assertScheduledOrder(snapshot.state, order);
      const grant = grantOf(snapshot.state, order.cardId, orderTotal(order), order.id);
      let consentSigner; try { consentSigner = await recoverTypedDataAddress({ ...consentTypedData(grant, grant.site), signature: grant.consentSignature }); } catch {}
      demand(consentSigner?.toLowerCase() === grant.owner.toLowerCase() && grant.nonce === order.agentGrantNonce, 'agent_consent_invalid', 'The agent consent could not be verified. Renew it before a new purchase.', 403);
      const card = cardOf(snapshot.state, order.cardId);
      if (orderTotal(order) > card.askAbove * 10000 && !order.agentApprovedAt) return store.mutate(userId, 'agent-approval-' + order.id, order.id, state => { const current = state.liveOrders.find(o => o.id === order.id); current.status = 'agent_approval'; current.message = 'Owner approval required for the total including the service fee.'; return event(state, { orderId }, 'agent_approval_requested', order.cardId); });
      const signer = await vault.signer(userId, order.cardId);
      demand(signer.address.toLowerCase() === grant.address.toLowerCase(), 'agent_wallet_mismatch', 'This consent belongs to another agent wallet.', 403);
      const balance = BigInt(await provider.rpc('eth_call', [{ to: liveMarket.asset, data: '0x70a08231' + signer.address.slice(2).padStart(64, '0') }, 'latest']));
      demand(balance >= BigInt(orderTotal(order)), 'agent_usdg_balance', 'The client must fund this agent wallet with enough USDG for the purchase plus 5%.');
      await dailyGasCapacity(store, userId, order.cardId, provider, signer.address);
      const prepared = await store.mutate(userId, 'agent-prepare-' + order.id, order.id, state => prepareLiveOrder(state, order.id, signer.address));
      order = prepared.state.liveOrders.find(o => o.id === orderId);
      const signature = await signer.signTypedData(paymentTypedData(order.authorization));
      const feeSignature = order.feeMicros ? await signer.signTypedData(paymentTypedData(order.feeAuthorization)) : undefined;
      snapshot = await submitLivePayment(store, userId, orderId, signature, provider, { feeSignature });
    } else {
      const job = await store.paymentJob(userId, orderId);
      snapshot = await submitLivePayment(store, userId, orderId, job.payload.payload.signature, provider);
    }
    order = snapshot.state.liveOrders.find(o => o.id === orderId);
    if (['fee_due', 'fee_checking'].includes(order.status)) return settleAgentFee(store, env, userId, orderId, provider, vault);
    return snapshot;
  });
}
export async function quoteForAgent(store, env, userId, cardId, provider) {
  const grant = grantOf((await store.get(userId)).state, cardId);
  const quote = await provider.quote();
  return { ...quote, ...await commissionQuote(quote.amountMicros, grant.owner, provider, env.GRANTFOLD_FEE_POLICY) };
}
export function addAgentQuote(state, cardId, quote) {
  const grant = grantOf(state, cardId, orderTotal(quote));
  const result = addLiveQuote(state, cardId, quote), order = state.liveOrders[0];
  order.agent = true; order.agentGrantNonce = grant.nonce;
  if (orderTotal(order) > cardOf(state, cardId).askAbove * 10000) { order.status = 'agent_approval'; order.message = 'Approve this agent purchase including the service fee in Grantfold.'; }
  return result;
}
export async function buyAsAgent(store, env, userId, cardId, requestId, maxTotalMicros, provider) {
  demand(/^[a-zA-Z0-9_-]{16,100}$/.test(requestId || ''), 'agent_request_id', 'Use a stable request_id of 16–100 letters, digits, hyphens or underscores.');
  demand(Number.isSafeInteger(maxTotalMicros) && maxTotalMicros > 0 && maxTotalMicros <= 1_050_000, 'agent_price_cap', 'Set a total cap in micro-USDG, at most 1050000.');
  const key = 'agent-buy-' + requestId, hash = JSON.stringify([cardId, maxTotalMicros]);
  const prior = await store.receipt(userId, key, hash); let orderId;
  if (prior) orderId = prior.orderId;
  else {
    const quote = await quoteForAgent(store, env, userId, cardId, provider);
    demand(orderTotal(quote) <= maxTotalMicros, 'agent_quote_cap', 'The provider price plus fee exceeds the caller’s total cap.');
    const created = await store.mutate(userId, key, hash, state => addAgentQuote(state, cardId, quote)); orderId = created.effect.orderId;
  }
  return executeAgentOrder(store, env, userId, orderId, provider);
}
export async function approveAgentOrder(store, env, userId, orderId, provider) {
  await store.mutate(userId, 'agent-approved-' + orderId, orderId, state => {
    const order = state.liveOrders?.find(o => o.id === orderId); demand(order?.agent, 'agent_order_missing', 'This agent order was not found.', 404);
    grantOf(state, order.cardId, orderTotal(order), orderId);
    demand(order.status === 'agent_approval' && order.expiresAt > Date.now() + 15000, 'agent_approval_expired', 'This approval expired. Request a fresh purchase.');
    order.status = 'quoted'; order.agentApprovedAt = Date.now(); return event(state, { orderId }, 'agent_purchase_approved', order.cardId);
  });
  return executeAgentOrder(store, env, userId, orderId, provider);
}

export async function prepareWithdrawal(store, env, userId, cardId, asset, amount, origin) {
  demand(['USDG', 'ETH'].includes(asset) && typeof amount === 'string' && /^\d{1,12}(?:\.\d{1,18})?$/.test(amount), 'withdraw_amount', 'Enter a positive USDG or ETH amount.');
  const decimals = asset === 'USDG' ? 6 : 18;
  demand((amount.split('.')[1] || '').length <= decimals, 'withdraw_precision', 'Use the token’s supported decimal precision.');
  const units = parseUnits(amount, decimals); demand(units > 0n, 'withdraw_amount', 'Enter a positive amount.');
  const vault = new WalletVault(store, env), row = await vault.row(userId, cardId); demand(row, 'agent_wallet_missing', 'Create this agent wallet first.', 404);
  return store.mutate(userId, 'withdraw-prepare-' + crypto.randomUUID(), cardId, state => {
    demand(!(state.liveOrders || []).some(o => o.cardId === cardId && ['processing', 'checking', 'needs_review', 'fee_due', 'fee_checking'].includes(o.status)), 'withdraw_order_pending', 'Resolve this wallet’s submitted purchase before withdrawing.', 409);
    const pending = (state.agentWithdrawals || []).find(w => w.cardId === cardId && !['completed', 'cancelled', 'failed'].includes(w.status));
    if (pending?.status === 'prepared' && pending.asset === asset && pending.amount === units.toString() && pending.site === origin) return event(state, { withdrawal: pending }, 'agent_withdrawal_status', cardId);
    demand(!pending, 'withdraw_pending', 'Finish or cancel the existing withdrawal.', 409);
    state.agentWithdrawals ??= []; demand(state.agentWithdrawals.length < 100, 'withdraw_capacity', 'This pilot account reached its withdrawal history limit.');
    if (state.agents?.[cardId]) state.agents[cardId].enabled = false;
    stopCardSchedule(state, cardId, 'A return of funds was prepared. Authorize a fresh schedule to restart daily purchases.');
    if (state.agentSetups) delete state.agentSetups[cardId];
    for (const order of state.liveOrders || []) if (order.cardId === cardId && ['quoted', 'ready', 'agent_approval'].includes(order.status)) order.status = 'cancelled';
    const withdrawal = { id: 'withdraw-' + crypto.randomUUID(), cardId, to: row.owner_address, asset, amount: units.toString(), site: origin, nonce: randomNonce(), expiresAt: Date.now() + 300000, status: 'prepared' };
    state.agentWithdrawals.unshift(withdrawal); return event(state, { withdrawal }, 'agent_withdrawal_prepared', cardId);
  });
}
export async function executeWithdrawal(store, env, userId, withdrawalId, signature, origin, provider) {
  let snapshot = await store.get(userId), withdrawal = snapshot.state.agentWithdrawals?.find(w => w.id === withdrawalId);
  demand(withdrawal && withdrawal.site === origin, 'withdraw_missing', 'This withdrawal was not found.', 404);
  if (['completed', 'cancelled', 'failed'].includes(withdrawal.status)) return snapshot;
  let signer; try { signer = await recoverTypedDataAddress({ ...withdrawalTypedData(withdrawal, origin), signature }); } catch {}
  demand(signer?.toLowerCase() === withdrawal.to.toLowerCase(), 'withdraw_owner_signature', 'The linked owner must sign this exact withdrawal.');
  const vault = new WalletVault(store, env);
  return vault.withLock(userId, withdrawal.cardId, async () => {
    withdrawal = (await store.get(userId)).state.agentWithdrawals.find(w => w.id === withdrawalId);
    if (['completed', 'cancelled', 'failed'].includes(withdrawal.status)) return store.get(userId);
    const existing = await vault.savedTransaction(userId, withdrawalId);
    if (!existing) demand(withdrawal.status === 'prepared' && withdrawal.expiresAt > Date.now(), 'withdraw_expired', 'Prepare a fresh withdrawal.');
    const request = withdrawal.asset === 'ETH' ? { to: withdrawal.to, value: '0x' + BigInt(withdrawal.amount).toString(16) } : { to: liveMarket.asset, value: '0x0', data: encodeFunctionData({ abi: [{ type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }], functionName: 'transfer', args: [withdrawal.to, BigInt(withdrawal.amount)] }) };
    const saved = await vault.signTransaction(userId, withdrawal.cardId, withdrawalId, request, provider);
    await store.mutate(userId, 'withdraw-sent-' + withdrawalId, withdrawalId, state => { const current = state.agentWithdrawals.find(w => w.id === withdrawalId); current.status = 'checking'; current.transaction = saved.transaction_hash; return event(state, { withdrawalId }, 'agent_withdrawal_submitted', current.cardId); });
    await vault.broadcast(saved, provider);
    return checkWithdrawal(store, userId, withdrawalId, provider);
  });
}
export async function checkWithdrawal(store, userId, withdrawalId, provider) {
  const snapshot = await store.get(userId), withdrawal = snapshot.state.agentWithdrawals?.find(w => w.id === withdrawalId);
  demand(withdrawal, 'withdraw_missing', 'This withdrawal was not found.', 404);
  if (withdrawal.status === 'completed' || !withdrawal.transaction) return snapshot;
  demand(await provider.rpc('eth_chainId', []) === '0x1237', 'withdraw_chain', 'The withdrawal network could not be verified.', 503);
  const receipt = await provider.rpc('eth_getTransactionReceipt', [withdrawal.transaction]);
  if (!receipt) return snapshot;
  if (receipt.status === '0x0' && receipt.transactionHash?.toLowerCase() === withdrawal.transaction.toLowerCase()) return store.mutate(userId, 'withdraw-failed-' + withdrawalId, withdrawalId, state => { const current = state.agentWithdrawals.find(w => w.id === withdrawalId); current.status = 'failed'; current.message = 'Transaction reverted. No withdrawal delivered; network gas may have been spent. Prepare a new return.'; return event(state, { withdrawalId }, 'agent_withdrawal_failed', current.cardId); });
  if (receipt.status !== '0x1') return snapshot;
  demand(receipt.transactionHash?.toLowerCase() === withdrawal.transaction.toLowerCase() && /^0x[0-9a-f]{64}$/i.test(receipt.blockHash || ''), 'withdraw_receipt', 'The withdrawal receipt does not match.');
  if (withdrawal.asset === 'USDG') {
    const row = await store.db.prepare('SELECT address FROM agent_wallets WHERE user_id = ? AND card_id = ?').bind(userId, withdrawal.cardId).first();
    demand(receipt.logs?.some(l => l.address?.toLowerCase() === liveMarket.asset.toLowerCase() && l.topics?.[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' && l.topics[1]?.slice(-40).toLowerCase() === row.address.slice(2).toLowerCase() && l.topics[2]?.slice(-40).toLowerCase() === withdrawal.to.slice(2).toLowerCase() && BigInt(l.data) === BigInt(withdrawal.amount)), 'withdraw_transfer', 'The USDG withdrawal transfer could not be verified.');
  }
  return store.mutate(userId, 'withdraw-complete-' + withdrawalId, withdrawalId, state => { const current = state.agentWithdrawals.find(w => w.id === withdrawalId); current.status = 'completed'; current.completedAt = Date.now(); return event(state, { withdrawalId }, 'agent_withdrawal_completed', current.cardId); });
}

export async function cancelWithdrawal(store, env, userId, withdrawalId) {
  const snapshot = await store.get(userId), withdrawal = snapshot.state.agentWithdrawals?.find(w => w.id === withdrawalId);
  demand(withdrawal, 'withdraw_missing', 'This withdrawal was not found.', 404);
  const vault = new WalletVault(store, env);
  return vault.withLock(userId, withdrawal.cardId, async () => {
    demand(!await vault.savedTransaction(userId, withdrawalId), 'withdraw_submitted', 'This withdrawal is already signed. Check its saved transaction.', 409);
    return store.mutate(userId, 'withdraw-cancel-' + withdrawalId, withdrawalId, state => { const current = state.agentWithdrawals.find(w => w.id === withdrawalId); demand(['prepared', 'cancelled'].includes(current.status), 'withdraw_submitted', 'Check this submitted withdrawal.', 409); current.status = 'cancelled'; return event(state, { withdrawalId }, 'agent_withdrawal_cancelled', current.cardId); });
  });
}
