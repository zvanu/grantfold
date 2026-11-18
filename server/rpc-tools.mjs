import { AppError } from './store.mjs';
import { formatEther } from 'viem';
import { liveMarket } from '../shared/payment.mjs';

export async function readChainTool(store, userId, body, provider) {
  if (!body || Object.keys(body).some(key => !['cardId', 'read', 'value'].includes(key)) || typeof body.cardId !== 'string' || (body.value !== undefined && typeof body.value !== 'string')) throw new AppError(422, 'rpc_input', 'Choose a card and a supported chain read.');
  const card = (await store.get(userId)).state.cards.find(c => c.id === body.cardId);
  if (!card) throw new AppError(404, 'card_missing', 'This card was not found in your account.');
  if (!card.categories.includes('Developer tools')) throw new AppError(403, 'rpc_category', 'Allow Developer tools on this card to use chain reads.');
  let method, params;
  if (body.read === 'block' && !body.value) { method = 'eth_blockNumber'; params = []; }
  else if (body.read === 'balance' && /^0x[0-9a-f]{40}$/i.test(body.value || '')) { method = 'eth_getBalance'; params = [body.value, 'latest']; }
  else if (body.read === 'receipt' && /^0x[0-9a-f]{64}$/i.test(body.value || '')) { method = 'eth_getTransactionReceipt'; params = [body.value]; }
  else throw new AppError(422, 'rpc_input', 'Choose latest block, an ETH balance address or a transaction hash.');
  if (await provider.rpc('eth_chainId', []) !== '0x1237') throw new AppError(503, 'rpc_chain', 'Robinhood Chain could not be verified.');
  const value = await provider.rpc(method, params); let result;
  if (body.read === 'receipt') {
    if (value === null) result = { message: 'No confirmed receipt found. This does not prove a transaction failed or was never sent.' };
    else {
      if (value.transactionHash?.toLowerCase() !== body.value.toLowerCase() || !['0x0', '0x1'].includes(value.status) || !/^0x[0-9a-f]+$/i.test(value.blockNumber || '')) throw new AppError(503, 'rpc_result', 'The transaction receipt could not be verified.');
      result = { transaction: value.transactionHash, status: value.status === '0x1' ? 'confirmed' : 'reverted', block: BigInt(value.blockNumber).toString() };
    }
  } else {
    if (!/^0x[0-9a-f]{1,64}$/i.test(value || '')) throw new AppError(503, 'rpc_result', 'The chain result could not be verified.');
    result = body.read === 'balance' ? { address: body.value, balance: formatEther(BigInt(value)) + ' ETH' } : { block: BigInt(value).toString() };
  }
  return { chainId: liveMarket.chainId, read: body.read, checkedAt: Date.now(), source: liveMarket.rpc, chargedMicros: 0, result };
}
