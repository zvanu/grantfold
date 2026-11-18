import { connectLiveWallet } from './live.js';

export async function signInWithWallet(request, provider = window.ethereum) {
  const address = await connectLiveWallet(provider);
  const challenge = await request('/api/auth/challenge', { address });
  const bytes = new TextEncoder().encode(challenge.message);
  const hex = '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  const signature = await provider.request({ method: 'personal_sign', params: [hex, address] });
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (accounts?.[0]?.toLowerCase() !== address.toLowerCase() || Number(await provider.request({ method: 'eth_chainId' })) !== 4663) throw Error('Your wallet changed. Connect again to sign in.');
  return request('/api/auth/verify', { id: challenge.id, signature });
}
