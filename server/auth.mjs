import { recoverMessageAddress, getAddress } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { AppError } from './store.mjs';

const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
const tokenPattern = /^[0-9a-f]{64}$/;
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const cookieNames = request => new URL(request.url).protocol === 'https:' ? { session: '__Host-grantfold_session', challenge: '__Host-grantfold_login' } : { session: 'grantfold_session', challenge: 'grantfold_login' };
function readCookie(request, name) { return (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1); }
function cookie(request, name, value, maxAge) { return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`; }
const walletUser = address => ({ id: 'wallet:4663:' + address.toLowerCase(), address: getAddress(address), email: null, displayName: address.slice(0, 6) + '…' + address.slice(-4), authentication: 'wallet' });
function requireDatabase(env) { if (!env.DB) throw new AppError(503, 'storage_unavailable', 'The account database is temporarily unavailable.'); return env.DB; }
function fields(body, names) { if (Object.keys(body).some(k => !names.includes(k)) || names.some(k => typeof body[k] !== 'string' || !body[k] || body[k].length > 500)) throw new AppError(422, 'invalid_request', 'This login request contains missing or unsupported fields.'); }

export async function walletSessionUser(request, env, now = Date.now()) {
  const token = readCookie(request, cookieNames(request).session);
  if (!tokenPattern.test(token || '')) return null;
  const row = await requireDatabase(env).prepare('SELECT user_id, address FROM wallet_sessions WHERE token_hash = ? AND origin = ? AND expires_at > ?').bind(await hash(token), new URL(request.url).origin, now).first();
  return row && row.user_id === walletUser(row.address).id ? walletUser(row.address) : null;
}

export async function loginChallenge(request, env, body, now = Date.now()) {
  fields(body, ['address']);
  if (!/^0x[0-9a-f]{40}$/i.test(body.address) || /^0x0{40}$/i.test(body.address)) throw new AppError(422, 'wallet_invalid', 'Connect an Ethereum-compatible wallet.');
  const db = requireDatabase(env), url = new URL(request.url), id = crypto.randomUUID(), address = getAddress(body.address.toLowerCase());
  const browser = random(), expiresAt = now + 300000;
  const message = createSiweMessage({ address, chainId: 4663, domain: url.host, scheme: url.protocol.slice(0, -1), uri: url.origin, version: '1', nonce: random(), issuedAt: new Date(now), expirationTime: new Date(expiresAt), statement: 'Sign in to your Grantfold account. This login signature does not authorize transfers or purchases.' });
  await db.batch([
    db.prepare('DELETE FROM wallet_login_challenges WHERE expires_at < ?').bind(now - 86400000),
    db.prepare('DELETE FROM wallet_sessions WHERE expires_at < ?').bind(now - 86400000),
    db.prepare('INSERT INTO wallet_login_challenges (id, address, origin, browser_hash, message, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, address.toLowerCase(), url.origin, await hash(browser), message, expiresAt, now),
  ]);
  return { data: { id, address, message, expiresAt, chainId: 4663 }, cookies: [cookie(request, cookieNames(request).challenge, browser, 300)] };
}

export async function verifyLogin(request, env, body, now = Date.now()) {
  fields(body, ['id', 'signature']);
  const browser = readCookie(request, cookieNames(request).challenge), db = requireDatabase(env), origin = new URL(request.url).origin;
  if (!tokenPattern.test(browser || '') || !/^0x[0-9a-f]{130}$/i.test(body.signature)) throw new AppError(401, 'login_invalid', 'Request a fresh wallet login and sign its message.');
  const row = await db.prepare('SELECT * FROM wallet_login_challenges WHERE id = ? AND origin = ? AND browser_hash = ? AND expires_at > ? AND consumed_by IS NULL').bind(body.id, origin, await hash(browser), now).first();
  if (!row) throw new AppError(401, 'login_expired', 'This wallet login expired or was already used. Connect again.');
  let signer;
  try { signer = await recoverMessageAddress({ message: row.message, signature: body.signature }); } catch {}
  if (signer?.toLowerCase() !== row.address) throw new AppError(401, 'login_signature', 'The selected wallet must sign this exact login message.');
  const token = random(), tokenHash = await hash(token), user = walletUser(row.address), expiresAt = now + 7 * 86400000;
  await db.batch([
    db.prepare('UPDATE wallet_login_challenges SET consumed_by = ? WHERE id = ? AND consumed_by IS NULL AND expires_at > ?').bind(tokenHash, row.id, now),
    db.prepare('INSERT INTO wallet_sessions (token_hash, user_id, address, origin, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ? FROM wallet_login_challenges WHERE id = ? AND consumed_by = ?').bind(tokenHash, user.id, row.address, origin, now, expiresAt, row.id, tokenHash),
  ]);
  if (!await db.prepare('SELECT token_hash FROM wallet_sessions WHERE token_hash = ?').bind(tokenHash).first()) throw new AppError(401, 'login_used', 'This login was already used. Connect again.');
  return { data: { authenticated: true, user }, cookies: [cookie(request, cookieNames(request).session, token, 7 * 86400), cookie(request, cookieNames(request).challenge, '', 0)] };
}

export async function logout(request, env) {
  const names = cookieNames(request), token = readCookie(request, names.session);
  if (tokenPattern.test(token || '')) await requireDatabase(env).prepare('DELETE FROM wallet_sessions WHERE token_hash = ?').bind(await hash(token)).run();
  return { data: { authenticated: false }, cookies: [cookie(request, names.session, '', 0), cookie(request, names.challenge, '', 0)] };
}
