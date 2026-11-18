import { orderTotal } from './commission.mjs';
export const liveMarket = Object.freeze({
  provider: 'Agent402', name: 'Crypto market overview', category: 'Market data',
  url: 'https://agent402.tools/api/crypto-market',
  network: 'eip155:4663', chainId: 4663,
  asset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  payTo: '0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0',
  rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com',
  maxAmountMicros: 1_000_000, decimals: 6,
});
export const usdg = amount => (amount / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 }) + ' USDG';
export function paymentTypedData(authorization) {
  return {
    domain: { name: 'Global Dollar', version: '1', chainId: liveMarket.chainId, verifyingContract: liveMarket.asset },
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }],
    },
    primaryType: 'TransferWithAuthorization', message: authorization,
  };
}
export function liveHeld(order, now = Date.now()) {
  return ['processing', 'checking', 'needs_review', 'fee_due', 'fee_checking'].includes(order.status) || (['quoted', 'ready', 'agent_approval'].includes(order.status) && order.expiresAt > now);
}
export function liveTotals(state, cardId, now = Date.now()) {
  const date = new Date(now).toISOString().slice(0, 10), orders = (state.liveOrders || []).filter(o => o.cardId === cardId);
  return {
    held: orders.filter(o => liveHeld(o, now)).reduce((sum, o) => sum + orderTotal(o), 0),
    spent: orders.filter(o => o.status === 'completed' && new Date(o.completedAt).toISOString().slice(0, 10) === date).reduce((sum, o) => sum + orderTotal(o), 0),
  };
}
