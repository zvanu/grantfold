import { liveMarket } from './payment.mjs';

const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
export function depositUnits(asset, amount) {
  if (!['USDG', 'ETH'].includes(asset) || typeof amount !== 'string' || !/^\d{1,4}(?:\.\d{1,18})?$/.test(amount)) throw Error('Enter a positive USDG or ETH amount without commas.');
  const decimals = asset === 'USDG' ? 6 : 18, [whole, fraction = ''] = amount.split('.');
  if (fraction.length > decimals) throw Error('Use at most ' + decimals + ' decimal places.');
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
  if (units <= 0n || units > (asset === 'USDG' ? 1000000000n : 100000000000000000n)) throw Error('Use up to 1,000 USDG or 0.1 ETH per deposit.');
  return units.toString();
}
export function depositTransaction(intent) {
  if (intent.chainId !== 4663 || !address(intent.from) || !address(intent.to) || intent.from.toLowerCase() === intent.to.toLowerCase() || !['USDG', 'ETH'].includes(intent.asset) || !/^\d{1,19}$/.test(intent.amountUnits || '')) throw Error('This deposit does not match a supported agent transfer.');
  const amount = BigInt(intent.amountUnits), limit = intent.asset === 'USDG' ? 1000000000n : 100000000000000000n;
  if (amount <= 0n || amount > limit) throw Error('This deposit amount is outside the supported limits.');
  return intent.asset === 'USDG'
    ? { chainId: '0x1237', from: intent.from, to: liveMarket.asset, value: '0x0', data: '0xa9059cbb' + intent.to.slice(2).toLowerCase().padStart(64, '0') + amount.toString(16).padStart(64, '0') }
    : { chainId: '0x1237', from: intent.from, to: intent.to, value: '0x' + amount.toString(16), data: '0x' };
}

// Called only after an explicit click on the reviewed transfer. No background
// polling or recovery path invokes eth_sendTransaction.
export async function requestDeposit(intent, expectedOwner, expectedAgent, provider, claimDispatch) {
  const transaction = depositTransaction(intent);
  if (intent.from.toLowerCase() !== expectedOwner?.toLowerCase() || intent.to.toLowerCase() !== expectedAgent?.toLowerCase() || intent.status !== 'prepared' || intent.expiresAt <= Date.now()) throw Error('Review a fresh deposit for this exact card and owner wallet.');
  if (!provider?.request) throw Error('Connect your wallet before sending a deposit.');
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (accounts?.[0]?.toLowerCase() !== expectedOwner.toLowerCase() || Number(await provider.request({ method: 'eth_chainId' })) !== 4663) throw Error('Reconnect the signed-in wallet on Robinhood Chain before sending.');
  if (!(await claimDispatch())) return { recoveryRequired: true };
  // Recheck after the server round trip; an account/network switch must not
  // send from a different wallet even when the request was already claimed.
  const current = await provider.request({ method: 'eth_accounts' });
  if (current?.[0]?.toLowerCase() !== expectedOwner.toLowerCase() || Number(await provider.request({ method: 'eth_chainId' })) !== 4663) throw Error('Wallet changed. Check wallet activity before clearing this deposit request.');
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [transaction] });
  if (!/^0x[0-9a-f]{64}$/i.test(hash || '')) throw Error('The wallet response is unconfirmed. Check this deposit using the wallet transaction hash.');
  return { transaction: hash };
}
