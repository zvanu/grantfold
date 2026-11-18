import { encodeFunctionData } from 'viem';
import { AppError } from './store.mjs';
import { commission } from '../shared/commission.mjs';
import { liveMarket } from '../shared/payment.mjs';

const transferAbi = [{ type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }], outputs: [] }];
export const randomNonce = () => '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
export function feeAuthorization(from, amountMicros, now = Date.now()) { return { from, to: commission.recipient, value: String(amountMicros), validAfter: '0', validBefore: String(Math.floor(now / 1000) + 86400), nonce: randomNonce() }; }
export function feeCall(order, signature) {
  const a = order.feeAuthorization;
  if (!a || !/^0x[0-9a-f]{130}$/i.test(signature || '')) throw new AppError(422, 'fee_signature_missing', 'Authorize the exact Grantfold service fee first.');
  let v = parseInt(signature.slice(-2), 16); if (v < 27) v += 27;
  return { from: a.from, to: liveMarket.asset, value: '0x0', data: encodeFunctionData({ abi: transferAbi, functionName: 'transferWithAuthorization', args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, v, signature.slice(0, 66), '0x' + signature.slice(66, 130)] }) };
}
export async function feeGasQuote(order, signature, provider) {
  const request = feeCall(order, signature);
  if (await provider.rpc('eth_chainId', []) !== '0x1237') throw new AppError(503, 'fee_chain_mismatch', 'Fee settlement is available only on Robinhood Chain.');
  const gas = BigInt(await provider.rpc('eth_estimateGas', [request])) * 12n / 10n, gasPrice = BigInt(await provider.rpc('eth_gasPrice', [])) * 2n;
  if (gas < 21000n || gas > 2_000_000n || gasPrice <= 0n || gas * gasPrice > BigInt(commission.maxGasWei)) throw new AppError(422, 'fee_gas_cap', 'The network fee exceeds the 0.00001 ETH per-transaction limit. Wait for a lower gas quote.');
  const balance = BigInt(await provider.rpc('eth_getBalance', [request.from, 'pending']));
  if (balance < gas * gasPrice) throw new AppError(422, 'fee_gas_balance', 'Add ETH to the paying wallet for the Grantfold fee’s network gas.');
  return { ...request, gas: '0x' + gas.toString(16), gasPrice: '0x' + gasPrice.toString(16), chainId: '0x1237' };
}
function feeOrder(state, id) {
  const order = state.liveOrders?.find(o => o.id === id);
  if (!order || !order.feeMicros) throw new AppError(404, 'fee_order_missing', 'This fee-bearing order was not found.');
  return order;
}
async function completeFee(store, userId, orderId, proof) {
  const job = await store.paymentJob(userId, orderId);
  if (!job?.capture?.report) throw new AppError(409, 'fee_delivery_missing', 'The provider delivery must be saved before collecting the service fee.');
  return store.mutate(userId, 'live-complete-' + orderId, orderId, state => {
    const order = feeOrder(state, orderId); order.status = 'completed'; order.completedAt = Date.now(); order.report = job.capture.report; order.receipt = order.providerReceipt; order.feeReceipt = proof; order.message = 'Provider purchase and agreed Grantfold fee confirmed on Robinhood Chain.';
    return { state, effect: { orderId }, audit: { kind: 'live_completed', mode: 'live', cardId: order.cardId, providerMicros: order.amountMicros, feeMicros: order.feeMicros, totalMicros: order.totalMicros, feeRecipient: order.feeRecipient } };
  });
}
export async function checkCommission(store, userId, orderId, provider, transactionHash) {
  const snapshot = await store.get(userId), order = feeOrder(snapshot.state, orderId);
  if (order.status === 'completed') return snapshot;
  if (!order.providerReceipt || !['fee_due', 'fee_checking'].includes(order.status)) throw new AppError(409, 'fee_not_due', 'The provider purchase must be confirmed first.');
  const hashes = [order.feeTransaction, transactionHash].filter(h => /^0x[0-9a-f]{64}$/i.test(h || '') && !(order.feeRevertedTransactions || []).includes(h.toLowerCase()));
  if (!hashes.length && order.feeFromBlock) {
    const latest = BigInt(await provider.rpc('eth_blockNumber', [])), start = BigInt(order.feeFromBlock);
    // The initial 24-hour authorization may span many blocks; bounded pages
    // start at the recorded point and are retried with a durable cursor.
    const from = BigInt(order.feeScanBlock || order.feeFromBlock), to = from + 4999n < latest ? from + 4999n : latest;
    if (from <= latest) {
      const logs = await provider.rpc('eth_getLogs', [{ address: liveMarket.asset, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: ['0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5', '0x' + order.feeAuthorization.from.slice(2).toLowerCase().padStart(64, '0'), order.feeAuthorization.nonce] }]);
      for (const log of logs || []) if (/^0x[0-9a-f]{64}$/i.test(log.transactionHash || '')) hashes.push(log.transactionHash);
      if (!hashes.length && to < latest) await store.mutate(userId, 'fee-scan-' + crypto.randomUUID(), orderId, state => { const current = feeOrder(state, orderId); current.feeScanBlock = '0x' + (to + 1n).toString(16); return { state, effect: { orderId }, audit: { kind: 'fee_scan', cardId: current.cardId } }; });
    }
  }
  for (const transaction of [...new Set(hashes)]) {
    try {
      const proof = await provider.verifySettlement({ amountMicros: order.feeMicros, authorization: order.feeAuthorization }, { settlement: { transaction } }, order.feeRecipient);
      return completeFee(store, userId, orderId, proof);
    } catch {}
    // Only a verified failed chain receipt permits another outer transaction.
    // The exact EIP-3009 authorization is reused, so its USDG can transfer once.
    if (transaction === order.feeTransaction && await provider.rpc('eth_chainId', []) === '0x1237') {
      const receipt = await provider.rpc('eth_getTransactionReceipt', [transaction]);
      if (receipt?.status === '0x0' && receipt.transactionHash?.toLowerCase() === transaction.toLowerCase() && /^0x[0-9a-f]{64}$/i.test(receipt.blockHash || '') && receipt.from?.toLowerCase() === order.feeAuthorization.from.toLowerCase()) {
        return store.mutate(userId, 'fee-reverted-' + transaction, orderId, state => {
          const current = feeOrder(state, orderId);
          if (current.status !== 'completed' && current.feeTransaction === transaction) {
            current.feeRevertedTransactions ??= []; current.feeRevertedTransactions.push(transaction.toLowerCase());
            current.feeAttempt = (current.feeAttempt || 0) + 1; current.feeTransaction = null; current.feeBroadcastAt = null; current.status = 'fee_due'; current.message = 'The fee transaction reverted. No fee was delivered; network gas may have been spent. Resume this order to retry its exact fee.';
          }
          return { state, effect: { orderId }, audit: { kind: 'fee_reverted', cardId: current.cardId } };
        });
      }
    }
  }
  return store.get(userId);
}
export async function prepareCommissionTransaction(store, userId, orderId, provider) {
  const checked = await checkCommission(store, userId, orderId, provider);
  const order = feeOrder(checked.state, orderId);
  if (order.status === 'completed') return checked;
  if (order.feeBroadcastAt) return { ...checked, effect: { orderId, waiting: true } };
  const job = await store.paymentJob(userId, orderId);
  const transaction = await feeGasQuote(order, job?.payload?._feeSignature, provider);
  const feeFromBlock = await provider.rpc('eth_blockNumber', []);
  const started = await store.mutate(userId, 'fee-begin-' + crypto.randomUUID(), orderId, state => {
    const current = feeOrder(state, orderId);
    if (current.feeBroadcastAt || current.status === 'completed') return { state, effect: { orderId, waiting: true }, audit: { kind: 'fee_status', cardId: current.cardId } };
    current.feeFromBlock = feeFromBlock; current.feeScanBlock = feeFromBlock; current.feeBroadcastAt = Date.now(); current.status = 'fee_checking'; current.message = 'Waiting for the wallet’s fee transaction. Check this same order after a lost response.';
    return { state, effect: { orderId, transaction }, audit: { kind: 'fee_wallet_requested', cardId: current.cardId } };
  });
  return started;
}
export async function declineCommissionTransaction(store, userId, orderId) {
  return store.mutate(userId, 'fee-decline-' + crypto.randomUUID(), orderId, state => { const order = feeOrder(state, orderId); if (order.status === 'fee_checking' && !order.feeTransaction) { order.feeBroadcastAt = null; order.status = 'fee_due'; } return { state, effect: { orderId }, audit: { kind: 'fee_wallet_declined', cardId: order.cardId } }; });
}
export async function rememberCommissionTransaction(store, userId, orderId, transaction) {
  if (!/^0x[0-9a-f]{64}$/i.test(transaction || '')) throw new AppError(422, 'fee_transaction_invalid', 'Provide the wallet’s transaction hash.');
  return store.mutate(userId, 'fee-hash-' + transaction.toLowerCase(), orderId, state => {
    const order = feeOrder(state, orderId);
    if (order.feeTransaction && order.feeTransaction.toLowerCase() !== transaction.toLowerCase()) throw new AppError(409, 'fee_transaction_changed', 'Check the saved fee transaction before changing it.');
    if (order.status !== 'completed') { order.feeTransaction = transaction; order.status = 'fee_checking'; }
    return { state, effect: { orderId }, audit: { kind: 'fee_transaction_saved', cardId: order.cardId } };
  });
}
