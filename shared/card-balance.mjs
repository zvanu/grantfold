import { liveHeld } from './payment.mjs';

export function formatMicros(value) {
  const amount = BigInt(value), whole = (amount / 1000000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (amount % 1000000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return whole + '.' + fraction;
}
export function formatEth(value) {
  const amount = BigInt(value), fraction = (amount % 1000000000000000000n).toString().padStart(18, '0').replace(/0+$/, '');
  return (amount / 1000000000000000000n).toString() + (fraction ? '.' + fraction : '');
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export const cardAgentOrders = (state, cardId, address) => (state.liveOrders || []).filter(order => order.cardId === cardId && order.agent === true && (!order.authorization || same(order.authorization.from, address)));
const proof = receipt => /^0x[0-9a-f]{64}$/i.test(receipt?.transaction || '');

export function confirmedAgentSpend(state, cardId, address, now = Date.now()) {
  const day = time => Number.isSafeInteger(time) && new Date(time).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10);
  let total = 0n;
  for (const order of cardAgentOrders(state, cardId, address)) {
    if (proof(order.providerReceipt || order.receipt) && day(order.providerCompletedAt || order.completedAt)) total += BigInt(order.amountMicros);
    if (proof(order.feeReceipt) && day(order.completedAt)) total += BigInt(order.feeMicros || 0);
  }
  return total.toString();
}

export function pendingAgentOrders(state, cardId, address, now = Date.now()) {
  return cardAgentOrders(state, cardId, address).filter(order => liveHeld(order, now));
}
