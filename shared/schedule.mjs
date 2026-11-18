export const scheduleRules = Object.freeze({ intervalMs: 86_400_000, windowMs: 3_600_000, maxRuns: 7, maxTotalMicros: 1_050_000, product: 'agent402-market-overview' });
export function nextScheduleWindow(now, utcHour) {
  const date = new Date(now); date.setUTCHours(utcHour, 0, 0, 0);
  return date.getTime() > now ? date.getTime() : date.getTime() + scheduleRules.intervalMs;
}
export function scheduleTypedData(plan) {
  return {
    domain: { name: 'Grantfold Purchase Schedule', version: '1', chainId: 4663 }, primaryType: 'PurchaseSchedule',
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }],
      PurchaseSchedule: [
        { name: 'site', type: 'string' }, { name: 'scheduleId', type: 'string' }, { name: 'cardId', type: 'string' },
        { name: 'owner', type: 'address' }, { name: 'agent', type: 'address' }, { name: 'product', type: 'string' },
        { name: 'maxTotalMicros', type: 'uint256' }, { name: 'maxRuns', type: 'uint256' },
        { name: 'firstRunAt', type: 'uint256' }, { name: 'intervalSeconds', type: 'uint256' },
        { name: 'validUntil', type: 'uint256' }, { name: 'agentGrantNonce', type: 'bytes32' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    message: { site: plan.site, scheduleId: plan.id, cardId: plan.cardId, owner: plan.owner, agent: plan.agent, product: plan.product,
      maxTotalMicros: String(plan.maxTotalMicros), maxRuns: String(plan.maxRuns), firstRunAt: String(Math.floor(plan.firstRunAt / 1000)),
      intervalSeconds: '86400', validUntil: String(Math.floor(plan.validUntil / 1000)), agentGrantNonce: plan.agentGrantNonce, nonce: plan.nonce },
  };
}
