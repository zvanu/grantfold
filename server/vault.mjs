import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { AppError } from './store.mjs';
import { commission } from '../shared/commission.mjs';

const encode = new TextEncoder(), decode = new TextDecoder();
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const bytes = value => Uint8Array.from(value.match(/.{2}/g) || [], v => parseInt(v, 16));
export class WalletVault {
  constructor(store, env) { this.db = store.db; this.secret = env.GRANTFOLD_WALLET_KEY_V1; }
  async key() {
    if (!/^[a-f0-9]{64}$/i.test(this.secret || '')) throw new AppError(503, 'agent_wallet_unavailable', 'Agent wallet protection is not configured. No wallet can sign.');
    return crypto.subtle.importKey('raw', bytes(this.secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async row(userId, cardId) { return this.db.prepare('SELECT * FROM agent_wallets WHERE user_id = ? AND card_id = ?').bind(userId, cardId).first(); }
  context(userId, cardId, address, owner) { return encode.encode(JSON.stringify([userId, cardId, address.toLowerCase(), owner.toLowerCase(), 1])); }
  async create(userId, cardId, owner) {
    const existing = await this.row(userId, cardId);
    if (existing) {
      if (existing.owner_address.toLowerCase() !== owner.toLowerCase()) throw new AppError(409, 'agent_owner_changed', 'This agent wallet returns funds to its original linked owner.');
      return existing;
    }
    const key = await this.key(), privateKey = generatePrivateKey(), address = privateKeyToAccount(privateKey).address;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.context(userId, cardId, address, owner) }, key, encode.encode(privateKey));
    await this.db.prepare('INSERT OR IGNORE INTO agent_wallets (user_id, card_id, address, owner_address, encrypted_key, iv, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(userId, cardId, address, owner, hex(new Uint8Array(ciphertext)), hex(iv), Date.now()).run();
    const result = await this.row(userId, cardId);
    if (result.owner_address.toLowerCase() !== owner.toLowerCase()) throw new AppError(409, 'agent_owner_changed', 'This wallet belongs to another linked owner.');
    return result;
  }
  async signer(userId, cardId) {
    const row = await this.row(userId, cardId);
    if (!row || row.key_version !== 1) throw new AppError(404, 'agent_wallet_missing', 'Set up this card’s agent wallet first.');
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(row.iv), additionalData: this.context(userId, cardId, row.address, row.owner_address) }, await this.key(), bytes(row.encrypted_key));
      const account = privateKeyToAccount(decode.decode(plaintext));
      if (account.address.toLowerCase() !== row.address.toLowerCase()) throw Error();
      return account;
    } catch { throw new AppError(503, 'agent_wallet_locked', 'The agent wallet could not be unlocked. Its signing key was not changed.'); }
  }
  async withLock(userId, cardId, operation) {
    const token = crypto.randomUUID(), now = Date.now();
    const result = await this.db.prepare('UPDATE agent_wallets SET lease_token = ?, lease_until = ? WHERE user_id = ? AND card_id = ? AND lease_until < ?').bind(token, now + 120_000, userId, cardId, now).run();
    if (result.meta.changes !== 1) throw new AppError(409, 'agent_wallet_busy', 'This wallet is finishing another action. Check its existing order before retrying.');
    try { return await operation(); }
    finally { await this.db.prepare('UPDATE agent_wallets SET lease_until = 0, lease_token = NULL WHERE user_id = ? AND card_id = ? AND lease_token = ?').bind(userId, cardId, token).run(); }
  }
  async savedTransaction(userId, jobId) { return this.db.prepare('SELECT raw_transaction, transaction_hash FROM agent_transactions WHERE user_id = ? AND job_id = ?').bind(userId, jobId).first(); }
  async signTransaction(userId, cardId, jobId, request, provider) {
    const existing = await this.savedTransaction(userId, jobId);
    if (existing) {
      const row = await this.row(userId, cardId), tx = parseTransaction(existing.raw_transaction), signer = await recoverTransactionAddress({ serializedTransaction: existing.raw_transaction });
      if (!row || tx.chainId !== 4663 || signer.toLowerCase() !== row.address.toLowerCase() || tx.to?.toLowerCase() !== request.to.toLowerCase() || (tx.data || '0x').toLowerCase() !== (request.data || '0x').toLowerCase() || (tx.value || 0n) !== BigInt(request.value || '0x0') || keccak256(existing.raw_transaction) !== existing.transaction_hash || tx.gas * tx.gasPrice > BigInt(commission.maxGasWei)) throw new AppError(409, 'agent_transaction_mismatch', 'The saved transaction does not match this wallet action.');
      return existing;
    }
    const account = await this.signer(userId, cardId);
    if (await provider.rpc('eth_chainId', []) !== '0x1237') throw new AppError(503, 'agent_chain_mismatch', 'This wallet signs only for Robinhood Chain.');
    const gas = BigInt(await provider.rpc('eth_estimateGas', [{ from: account.address, ...request }])) * 12n / 10n;
    const gasPrice = BigInt(await provider.rpc('eth_gasPrice', [])) * 2n;
    if (gas < 21000n || gas > 2_000_000n || gasPrice <= 0n || gas * gasPrice > BigInt(commission.maxGasWei)) throw new AppError(422, 'agent_gas_cap', 'The network gas quote exceeds the consented per-transaction cap.');
    const nativeBalance = BigInt(await provider.rpc('eth_getBalance', [account.address, 'pending']));
    if (nativeBalance < BigInt(request.value || '0x0') + gas * gasPrice) throw new AppError(422, 'agent_gas_balance', 'The client must add ETH to this agent wallet for network gas.');
    const chainNonce = Number(BigInt(await provider.rpc('eth_getTransactionCount', [account.address, 'pending'])));
    const local = await this.db.prepare('SELECT MAX(nonce) AS nonce FROM agent_transactions WHERE wallet_address = ?').bind(account.address.toLowerCase()).first();
    const nonce = Math.max(chainNonce, local?.nonce == null ? 0 : local.nonce + 1);
    if (!Number.isSafeInteger(nonce) || nonce > 1_000_000_000) throw new AppError(503, 'agent_nonce_invalid', 'The wallet transaction nonce could not be verified.');
    const raw = await account.signTransaction({ chainId: 4663, type: 'legacy', to: request.to, data: request.data || '0x', value: BigInt(request.value || '0x0'), nonce, gas, gasPrice });
    const transactionHash = keccak256(raw);
    await this.db.prepare('INSERT INTO agent_transactions (user_id, job_id, wallet_address, nonce, raw_transaction, transaction_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(userId, jobId, account.address.toLowerCase(), nonce, raw, transactionHash, Date.now()).run();
    return { raw_transaction: raw, transaction_hash: transactionHash };
  }
  async broadcast(saved, provider) {
    try { await provider.rpc('eth_sendRawTransaction', [saved.raw_transaction]); } catch {}
    return saved.transaction_hash;
  }
}
