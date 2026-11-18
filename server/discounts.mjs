import { AppError } from './store.mjs';
import { commission, feeFor } from '../shared/commission.mjs';
import { liveMarket } from '../shared/payment.mjs';

const address = /^0x[0-9a-f]{40}$/i;
const requirePolicy = (ok, message) => { if (!ok) throw new AppError(503, 'fee_policy_invalid', message); };
export function discountPolicy(raw) {
  if (!raw) return { enabled: false, version: 'base-v1', chainId: 4663, token: null, decimals: null, tiers: [] };
  let policy; try { policy = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {}
  requirePolicy(policy && !Array.isArray(policy) && typeof policy === 'object', 'The fee policy must be a JSON object.');
  requirePolicy(Object.keys(policy).every(k => ['enabled', 'version', 'chainId', 'token', 'decimals', 'tiers'].includes(k)), 'Unsupported fee policy setting.');
  requirePolicy(typeof policy.enabled === 'boolean' && /^[a-zA-Z0-9._-]{1,64}$/.test(policy.version || '') && policy.chainId === 4663 && Array.isArray(policy.tiers) && policy.tiers.length <= 8, 'Review the fee policy version, chain and tiers.');
  if (!policy.enabled) return { enabled: false, version: policy.version, chainId: 4663, token: null, decimals: null, tiers: [] };
  requirePolicy(address.test(policy.token || '') && !/^0x0{40}$/i.test(policy.token) && Number.isInteger(policy.decimals) && policy.decimals >= 0 && policy.decimals <= 18 && policy.tiers.length > 0, 'An enabled policy needs an ERC-20 token, decimals and tiers on Robinhood Chain.');
  const tiers = policy.tiers.map(t => {
    requirePolicy(t && Object.keys(t).every(k => ['minBalance', 'feeBps'].includes(k)) && typeof t.minBalance === 'string' && /^[1-9][0-9]{0,77}$/.test(t.minBalance) && BigInt(t.minBalance) < 2n ** 256n && Number.isInteger(t.feeBps) && t.feeBps >= 0 && t.feeBps < commission.bps, 'Each tier needs an exact token-unit balance and a fee below 5%.');
    return { minBalance: t.minBalance, feeBps: t.feeBps };
  }).sort((a, b) => BigInt(a.minBalance) < BigInt(b.minBalance) ? -1 : 1);
  for (let i = 1; i < tiers.length; i++) requirePolicy(BigInt(tiers[i].minBalance) > BigInt(tiers[i - 1].minBalance) && tiers[i].feeBps <= tiers[i - 1].feeBps, 'Higher token balances must not increase the fee; thresholds must be unique.');
  return { enabled: true, version: policy.version, chainId: 4663, token: policy.token.toLowerCase(), decimals: policy.decimals, tiers };
}
export function publicFeePolicy(raw) {
  try { return { available: true, baseBps: commission.bps, ...discountPolicy(raw), snapshot: 'quote', holder: 'paying wallet or linked agent owner' }; }
  catch { return { available: false, baseBps: commission.bps, enabled: false, error: 'fee_policy_invalid' }; }
}
export async function commissionQuote(amountMicros, holder, provider, rawPolicy) {
  const policy = discountPolicy(rawPolicy);
  let feeBps = commission.bps;
  const snapshot = { version: policy.version, enabled: policy.enabled, holder: holder?.toLowerCase() || null, token: policy.token, decimals: policy.decimals, checkedAt: Date.now(), status: policy.enabled ? 'wallet_required' : 'inactive' };
  if (policy.enabled && holder) {
    requirePolicy(address.test(holder), 'The discount holder wallet is invalid.');
    try {
      requirePolicy(await provider.rpc('eth_chainId', []) === '0x1237', 'Token discounts are supported only on Robinhood Chain.');
      const block = await provider.rpc('eth_blockNumber', []);
      requirePolicy(/^0x[0-9a-f]+$/i.test(block), 'The token snapshot block could not be verified.');
      const code = await provider.rpc('eth_getCode', [policy.token, block]);
      requirePolicy(/^0x[0-9a-f]+$/i.test(code || '') && !/^0x0*$/i.test(code), 'The discount token is not a deployed contract.');
      const decimals = await provider.rpc('eth_call', [{ to: policy.token, data: '0x313ce567' }, block]);
      const balance = await provider.rpc('eth_call', [{ to: policy.token, data: '0x70a08231' + holder.slice(2).padStart(64, '0') }, block]);
      requirePolicy(/^0x[0-9a-f]{64}$/i.test(decimals || '') && Number(BigInt(decimals)) === policy.decimals && /^0x[0-9a-f]{64}$/i.test(balance || ''), 'The token balance or decimals could not be verified.');
      for (const tier of policy.tiers) if (BigInt(balance) >= BigInt(tier.minBalance)) feeBps = tier.feeBps;
      Object.assign(snapshot, { status: 'verified', block, balance: BigInt(balance).toString() });
    } catch (error) {
      if (error instanceof AppError && error.code === 'fee_policy_invalid') throw error;
      throw new AppError(503, 'fee_discount_unavailable', 'Token eligibility could not be checked. No payment was submitted; try the same quote again.');
    }
  }
  const feeMicros = feeFor(amountMicros, feeBps);
  return { feeBps, feeMicros, totalMicros: amountMicros + feeMicros, feeRecipient: commission.recipient, feePolicy: snapshot };
}

export async function liveReadiness(provider, env) {
  const quote = await provider.quote();
  if (await provider.rpc('eth_chainId', []) !== '0x1237') throw new AppError(503, 'live_chain_invalid', 'Robinhood Chain could not be verified.');
  const decimals = await provider.rpc('eth_call', [{ to: liveMarket.asset, data: '0x313ce567' }, 'latest']);
  if (!/^0x[0-9a-f]{64}$/i.test(decimals || '') || BigInt(decimals) !== 6n) throw new AppError(503, 'live_asset_invalid', 'USDG token decimals could not be verified.');
  return { checkedAt: Date.now(), chainId: 4663, asset: liveMarket.asset, provider: liveMarket.provider, quote, fees: publicFeePolicy(env.GRANTFOLD_FEE_POLICY), agentWalletsConfigured: /^[a-f0-9]{64}$/i.test(env.GRANTFOLD_WALLET_KEY_V1 || ''), paidPurchaseVerified: false, note: 'Unpaid provider and RPC checks only. A real paid order needs the wallet owner’s approval.' };
}
