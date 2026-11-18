import { AppError } from './store.mjs';
import { liveMarket } from '../shared/payment.mjs';
import { depositUnits, depositTransaction } from '../shared/deposit.mjs';

const demand = (ok, code, message, status = 422) => { if (!ok) throw new AppError(status, code, message); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const event = (state, deposit, kind, extra = {}) => ({ state, effect: { depositId: deposit.id, ...extra }, audit: { kind, cardId: deposit.cardId, asset: deposit.asset, mode: 'deposit' } });
function ownDeposit(state, user, id) {
  const deposit = state.deposits?.find(item => item.id === id);
  demand(deposit && same(deposit.from, user.address), 'deposit_missing', 'This deposit was not found in your wallet account.', 404);
  return deposit;
}
export async function prepareDeposit(store, user, key, hash, body) {
  demand(/^0x[0-9a-f]{40}$/i.test(user.address || ''), 'deposit_wallet_login', 'Sign in with the wallet that will fund the agent.', 403);
  let amountUnits; try { amountUnits = depositUnits(body.asset, body.amount); } catch (error) { throw new AppError(422, 'deposit_amount', error.message); }
  const prior = await store.receipt(user.id, key, hash); if (prior) return { ...await store.get(user.id), effect: prior, replayed: true };
  const { state } = await store.get(user.id);
  demand(state.cards.some(card => card.id === body.cardId), 'card_missing', 'This card was not found in your account.', 404);
  const wallet = await store.db.prepare('SELECT address, owner_address FROM agent_wallets WHERE user_id = ? AND card_id = ?').bind(user.id, body.cardId).first();
  demand(wallet && same(wallet.owner_address, user.address), 'deposit_wallet_missing', 'Set up this card’s wallet with the signed-in owner first.', 403);
  return store.mutate(user.id, key, hash, current => {
    current.deposits ??= [];
    const existing = current.deposits.find(item => item.cardId === body.cardId && (['requested', 'checking'].includes(item.status) || (item.status === 'prepared' && item.expiresAt > Date.now())));
    if (existing) return event(current, existing, 'deposit_reused', { reused: true });
    demand(current.deposits.length < 100, 'deposit_capacity', 'This account reached its 100-deposit history limit.');
    const deposit = { id: 'deposit-' + crypto.randomUUID(), cardId: body.cardId, chainId: 4663, from: user.address, to: wallet.address, asset: body.asset, amountUnits, status: 'prepared', createdAt: Date.now(), expiresAt: Date.now() + 300000 };
    depositTransaction(deposit); current.deposits.unshift(deposit);
    return event(current, deposit, 'deposit_prepared');
  });
}
export async function startDeposit(store, user, key, hash, id) {
  const prior = await store.receipt(user.id, key, hash);
  if (prior) return { ...await store.get(user.id), effect: { ...prior, maySend: false }, replayed: true };
  const result = await store.mutate(user.id, key, hash, state => {
    const deposit = ownDeposit(state, user, id);
    if (deposit.status !== 'prepared') return event(state, deposit, 'deposit_status', { maySend: false });
    demand(deposit.expiresAt > Date.now(), 'deposit_expired', 'This deposit review expired. Prepare a fresh amount.');
    deposit.status = 'requested'; deposit.requestedAt = Date.now();
    return event(state, deposit, 'deposit_wallet_requested', { maySend: true });
  });
  return result.replayed ? { ...result, effect: { ...result.effect, maySend: false } } : result;
}

export async function verifyDeposit(deposit, transaction, provider) {
  demand(await provider.rpc('eth_chainId', []) === '0x1237', 'deposit_chain', 'Robinhood Chain could not be verified.', 503);
  const tx = await provider.rpc('eth_getTransactionByHash', [transaction]);
  if (!tx) return { status: 'checking' };
  const expected = depositTransaction(deposit);
  demand(same(tx.hash, transaction) && same(tx.from, expected.from) && same(tx.to, expected.to) && /^0x[0-9a-f]+$/i.test(tx.value || '') && BigInt(tx.value) === BigInt(expected.value) && same(tx.input || tx.data || '0x', expected.data), 'deposit_mismatch', 'This transaction does not match the deposit’s sender, receiving agent, asset and exact amount.');
  const receipt = await provider.rpc('eth_getTransactionReceipt', [transaction]);
  if (!receipt) return { status: 'checking' };
  demand(same(receipt.transactionHash, transaction) && /^0x[0-9a-f]{64}$/i.test(receipt.blockHash || '') && same(tx.blockHash, receipt.blockHash) && /^0x[0-9a-f]+$/i.test(receipt.blockNumber || '') && ['0x0', '0x1'].includes(receipt.status), 'deposit_receipt', 'This deposit receipt is not confirmed on Robinhood Chain.', 503);
  const block = await provider.rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
  demand(same(block?.hash, receipt.blockHash), 'deposit_receipt', 'The receipt block is not the current canonical chain.', 503);
  if (receipt.status === '0x0') return { status: 'failed', blockNumber: BigInt(receipt.blockNumber).toString() };
  if (deposit.asset === 'USDG') {
    const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const topicAddress = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) ? '0x' + value.slice(-40) : '';
    demand((receipt.logs || []).some(log => same(log.address, liveMarket.asset) && log.topics?.[0] === transfer && same(topicAddress(log.topics[1]), deposit.from) && same(topicAddress(log.topics[2]), deposit.to) && /^0x[0-9a-f]{64}$/i.test(log.data || '') && BigInt(log.data) === BigInt(deposit.amountUnits)), 'deposit_transfer', 'The receipt does not prove the exact USDG transfer to this agent.');
  }
  return { status: 'confirmed', blockNumber: BigInt(receipt.blockNumber).toString(), blockHash: receipt.blockHash };
}

export async function checkDeposit(store, user, key, hash, body, provider) {
  const prior = await store.receipt(user.id, key, hash); if (prior) return { ...await store.get(user.id), effect: prior, replayed: true };
  demand(/^0x[0-9a-f]{64}$/i.test(body.transaction || ''), 'deposit_hash', 'Enter the transaction hash from your wallet.');
  const snapshot = await store.get(user.id), deposit = ownDeposit(snapshot.state, user, body.depositId);
  if (['confirmed', 'failed'].includes(deposit.status)) { demand(same(deposit.transaction, body.transaction), 'deposit_closed', 'This deposit already has a saved transaction.'); return { ...snapshot, effect: { depositId: deposit.id } }; }
  demand(['requested', 'checking'].includes(deposit.status), 'deposit_not_requested', 'Review and request this deposit before checking its transaction.');
  demand(!snapshot.state.deposits.some(item => item.id !== deposit.id && same(item.transaction, body.transaction)), 'deposit_duplicate', 'This transaction is already tracked by another deposit.', 409);
  const proof = await verifyDeposit(deposit, body.transaction, provider);
  return store.mutate(user.id, key, hash, state => {
    const current = ownDeposit(state, user, deposit.id);
    demand(!['cancelled', 'confirmed', 'failed'].includes(current.status), 'deposit_changed', 'This deposit changed. Reopen its saved status.', 409);
    demand(!state.deposits.some(item => item.id !== deposit.id && same(item.transaction, body.transaction)), 'deposit_duplicate', 'This transaction is already tracked by another deposit.', 409);
    current.transaction = body.transaction; current.status = proof.status; current.checkedAt = Date.now();
    if (proof.blockNumber) current.blockNumber = proof.blockNumber;
    if (proof.blockHash) current.blockHash = proof.blockHash;
    return event(state, current, 'deposit_' + proof.status);
  });
}
export async function cancelDeposit(store, user, key, hash, body) {
  return store.mutate(user.id, key, hash, state => {
    const deposit = ownDeposit(state, user, body.depositId);
    demand(deposit.status === 'prepared' || (deposit.status === 'requested' && !deposit.transaction && body.confirmNoTransfer === true), 'deposit_pending', 'Check the existing transaction; do not prepare a second transfer.', 409);
    deposit.status = 'cancelled'; deposit.cancelledAt = Date.now();
    return event(state, deposit, 'deposit_cancelled');
  });
}
