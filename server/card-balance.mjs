import { encodeFunctionData } from 'viem';
import { AppError } from './store.mjs';
import { liveMarket } from '../shared/payment.mjs';
import { pendingAgentOrders, confirmedAgentSpend } from '../shared/card-balance.mjs';

const authorizationAbi = [{ type: 'function', name: 'authorizationState', stateMutability: 'view', inputs: [{ type: 'address', name: 'authorizer' }, { type: 'bytes32', name: 'nonce' }], outputs: [{ type: 'bool' }] }];
const requireResult = (ok, message) => { if (!ok) throw new AppError(503, 'card_balance_unavailable', message); };

export async function readAgentCardBalance(store, userId, cardId, provider) {
  const { state, revision } = await store.get(userId);
  if (!state.cards.some(card => card.id === cardId)) throw new AppError(404, 'card_missing', 'This card was not found in your account.');
  const row = await store.db.prepare('SELECT address, owner_address FROM agent_wallets WHERE user_id = ? AND card_id = ?').bind(userId, cardId).first();
  const base = { cardId, accountRevision: revision, chainId: liveMarket.chainId };
  if (!row) return { ...base, status: 'not_setup', checkedAt: Date.now() };
  requireResult(await provider.rpc('eth_chainId', []) === '0x1237', 'The agent balance could not be verified on Robinhood Chain.');
  const block = await provider.rpc('eth_blockNumber', []);
  requireResult(/^0x[0-9a-f]{1,16}$/i.test(block || ''), 'The chain balance snapshot could not be verified.');
  const [token, native] = await Promise.all([
    provider.rpc('eth_call', [{ to: liveMarket.asset, data: '0x70a08231' + row.address.slice(2).toLowerCase().padStart(64, '0') }, block]),
    provider.rpc('eth_getBalance', [row.address, block]),
  ]);
  requireResult(/^0x[0-9a-f]{64}$/i.test(token || '') && /^0x[0-9a-f]{1,64}$/i.test(native || ''), 'The wallet balance response could not be verified.');
  async function stillUsable(authorization) {
    if (!authorization) return true;
    const result = await provider.rpc('eth_call', [{ to: liveMarket.asset, data: encodeFunctionData({ abi: authorizationAbi, functionName: 'authorizationState', args: [authorization.from, authorization.nonce] }) }, block]);
    requireResult(/^0x0{63}[01]$/.test(result || ''), 'A pending payment reservation could not be verified.');
    return result.endsWith('0');
  }
  let reserved = 0n;
  for (const order of pendingAgentOrders(state, cardId, row.address)) {
    if (await stillUsable(order.authorization)) reserved += BigInt(order.amountMicros);
    if (order.feeMicros && await stillUsable(order.feeAuthorization)) reserved += BigInt(order.feeMicros);
  }
  for (const withdrawal of state.agentWithdrawals || []) {
    if (withdrawal.cardId !== cardId || withdrawal.asset !== 'USDG' || !['prepared', 'checking'].includes(withdrawal.status) || (withdrawal.status === 'prepared' && withdrawal.expiresAt <= Date.now())) continue;
    if (withdrawal.status === 'checking') {
      const receipt = await provider.rpc('eth_getTransactionReceipt', [withdrawal.transaction]);
      if (receipt) {
        requireResult(receipt.transactionHash?.toLowerCase() === withdrawal.transaction?.toLowerCase() && /^0x[0-9a-f]+$/i.test(receipt.blockNumber || '') && ['0x0', '0x1'].includes(receipt.status), 'A pending return could not be verified.');
        if (BigInt(receipt.blockNumber) <= BigInt(block)) continue;
      }
    }
    reserved += BigInt(withdrawal.amount);
  }
  const balance = BigInt(token);
  return { ...base, status: 'ready', address: row.address, owner: row.owner_address, blockNumber: BigInt(block).toString(), checkedAt: Date.now(), usdgMicros: balance.toString(), ethWei: BigInt(native).toString(), reservedMicros: reserved.toString(), availableMicros: (balance > reserved ? balance - reserved : 0n).toString(), spentTodayMicros: confirmedAgentSpend(state, cardId, row.address) };
}
