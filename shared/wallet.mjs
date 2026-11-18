import { commission, feeFor, orderTotal } from './commission.mjs';
import { liveMarket, paymentTypedData, usdg } from './payment.mjs';

export async function connectLiveWallet(provider = window.ethereum) {
  if (!provider?.request) throw Error('Open Grantfold in a wallet browser or install an Ethereum-compatible wallet extension.');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!/^0x[0-9a-fA-F]{40}$/.test(accounts?.[0] || '')) throw Error('Choose a wallet account to continue.');
  let chain = await provider.request({ method: 'eth_chainId' });
  if (Number(chain) !== liveMarket.chainId) {
    try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1237' }] }); }
    catch (error) {
      if (error.code !== 4902) throw error;
      await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x1237', chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [liveMarket.rpc], blockExplorerUrls: [liveMarket.explorer] }] });
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1237' }] });
    }
    chain = await provider.request({ method: 'eth_chainId' });
  }
  if (Number(chain) !== liveMarket.chainId) throw Error('Switch to Robinhood Chain before signing.');
  return accounts[0];
}

export async function signLiveOrder(order, provider = window.ethereum) {
  const a = order.authorization;
  if (!a || order.status !== 'ready' || order.accepted.network !== liveMarket.network || order.accepted.asset.toLowerCase() !== liveMarket.asset.toLowerCase() || a.to.toLowerCase() !== liveMarket.payTo.toLowerCase() || a.value !== order.accepted.amount || !Number.isSafeInteger(order.amountMicros) || order.amountMicros !== Number(a.value) || order.amountMicros <= 0 || order.amountMicros > liveMarket.maxAmountMicros || !/^0x[0-9a-fA-F]{64}$/.test(a.nonce) || a.validAfter !== '0' || Number(a.validBefore) * 1000 > order.expiresAt || Number(a.validBefore) * 1000 <= Date.now() + 3000) throw Error('This payment does not match the supported USDG quote. Request a fresh quote.');
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (accounts?.[0]?.toLowerCase() !== a.from.toLowerCase()) throw Error('Your wallet account changed. Cancel this quote and start again.');
  if (Number(await provider.request({ method: 'eth_chainId' })) !== liveMarket.chainId) throw Error('Your wallet network changed. Switch back to Robinhood Chain.');
  const data = '0x70a08231' + a.from.slice(2).padStart(64, '0');
  const balance = await provider.request({ method: 'eth_call', params: [{ to: liveMarket.asset, data }, 'latest'] });
  if (BigInt(balance) < BigInt(orderTotal(order))) throw Error('Your wallet needs at least ' + usdg(orderTotal(order)) + ' on Robinhood Chain. Demo funds cannot pay for this report.');
  const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [a.from, JSON.stringify(paymentTypedData(a))] });
  if (Number.isInteger(order.feeBps) && (order.feeBps < 0 || order.feeBps > commission.bps || order.feeMicros !== feeFor(order.amountMicros, order.feeBps) || order.totalMicros !== order.amountMicros + order.feeMicros)) throw Error('The service fee does not match this quote.');
  if (!order.feeMicros) return signature;
  const fee = order.feeAuthorization;
  if (!fee || !Number.isInteger(order.feeBps) || order.feeBps < 0 || order.feeBps > commission.bps || order.feeMicros !== feeFor(order.amountMicros, order.feeBps) || order.totalMicros !== order.amountMicros + order.feeMicros || fee.from.toLowerCase() !== a.from.toLowerCase() || fee.to.toLowerCase() !== commission.recipient || fee.value !== String(order.feeMicros)) throw Error('The service fee does not match this quote.');
  const feeAccounts = await provider.request({ method: 'eth_accounts' });
  if (feeAccounts?.[0]?.toLowerCase() !== a.from.toLowerCase() || Number(await provider.request({ method: 'eth_chainId' })) !== liveMarket.chainId) throw Error('Your wallet account or network changed. Reconnect before signing the fee.');
  const feeSignature = await provider.request({ method: 'eth_signTypedData_v4', params: [a.from, JSON.stringify(paymentTypedData(fee))] });
  return { signature, feeSignature };
}
