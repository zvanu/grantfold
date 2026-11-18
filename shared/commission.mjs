export const commission = Object.freeze({ bps: 500, recipient: '0x1425a0947d12c883e347c1dfe5e43b7f92fa0cd4', maxGasWei: '10000000000000', dailyGasWei: '100000000000000' });
export function feeFor(amountMicros, bps = commission.bps) {
  if (!Number.isSafeInteger(amountMicros) || amountMicros < 0 || !Number.isInteger(bps) || bps < 0 || bps > commission.bps) throw Error('Invalid fee amount or rate.');
  return Number((BigInt(amountMicros) * BigInt(bps) + 9999n) / 10000n);
}
export const orderTotal = order => order.totalMicros ?? order.amountMicros;
export function consentTypedData(setup, origin) {
  return {
    domain: { name: 'Grantfold Agent Consent', version: '1', chainId: 4663 },
    primaryType: 'AgentConsent',
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }], AgentConsent: [{ name: 'site', type: 'string' }, { name: 'cardId', type: 'string' }, { name: 'owner', type: 'address' }, { name: 'agent', type: 'address' }, { name: 'perBuyMicros', type: 'uint256' }, { name: 'perDayMicros', type: 'uint256' }, { name: 'feeBps', type: 'uint256' }, { name: 'feeRecipient', type: 'address' }, { name: 'maxGasWei', type: 'uint256' }, { name: 'dailyGasWei', type: 'uint256' }, { name: 'validUntil', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
    message: { site: origin, cardId: setup.cardId, owner: setup.owner, agent: setup.address, perBuyMicros: String(setup.perBuyMicros), perDayMicros: String(setup.perDayMicros), feeBps: String(commission.bps), feeRecipient: commission.recipient, maxGasWei: commission.maxGasWei, dailyGasWei: commission.dailyGasWei, validUntil: String(Math.floor(setup.validUntil / 1000)), nonce: setup.nonce },
  };
}

export function withdrawalTypedData(withdrawal, origin) {
  return { domain: { name: 'Grantfold Withdrawal', version: '1', chainId: 4663 }, primaryType: 'Withdrawal', types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }], Withdrawal: [{ name: 'site', type: 'string' }, { name: 'cardId', type: 'string' }, { name: 'to', type: 'address' }, { name: 'asset', type: 'string' }, { name: 'amount', type: 'uint256' }, { name: 'maxGasWei', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }, { name: 'validUntil', type: 'uint256' }] }, message: { site: origin, cardId: withdrawal.cardId, to: withdrawal.to, asset: withdrawal.asset, amount: withdrawal.amount, maxGasWei: commission.maxGasWei, nonce: withdrawal.nonce, validUntil: String(Math.floor(withdrawal.expiresAt / 1000)) } };
}
