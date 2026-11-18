import http from 'node:http';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { LocalD1 } from './sqlite-d1.mjs';
import { collectAssets } from './build.mjs';
import { createNodeHandler } from '../api/handler.mjs';

mkdirSync('.local', { recursive: true });
const fixture = process.env.GRANTFOLD_QA_FIXTURE === '1';
const port = Number(process.env.GRANTFOLD_DEV_PORT || 8898), origin = 'http://127.0.0.1:' + port;
let secret;
if (fixture) secret = randomBytes(32).toString('hex');
else {
  const file = '.local/development-wallet-key';
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  secret = readFileSync(file, 'utf8');
}
const db = new LocalD1(fixture ? ':memory:' : '.local/grantfold-vercel.sqlite'); db.migrate();
const env = { GRANTFOLD_SITE_ORIGIN: origin, GRANTFOLD_WALLET_KEY_V1: secret, ...(fixture ? { CRON_SECRET: 'isolated-fixture-scheduler-secret-2026' } : {}) };
const services = fixture ? { marketProvider: new (await import('../test/fixtures/chain.mjs')).MockChainProvider() } : {};
const handler = createNodeHandler({ db, env, services });
let fixtureCookie;
if (fixture) {
  const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');
  const { loginChallenge, verifyLogin } = await import('../server/auth.mjs');
  const { AccountStore } = await import('../server/store.mjs');
  const { initialState } = await import('../shared/core.mjs');
  const { prepareAgent, enableAgent } = await import('../server/agents.mjs');
  const { consentTypedData } = await import('../shared/commission.mjs');
  const owner = privateKeyToAccount(generatePrivateKey()), authEnv = { ...env, DB: db };
  const challenge = await loginChallenge(new Request(origin + '/api/auth/challenge'), authEnv, { address: owner.address });
  const login = await verifyLogin(new Request(origin + '/api/auth/verify', { headers: { cookie: challenge.cookies[0].split(';')[0] } }), authEnv, { id: challenge.data.id, signature: await owner.signMessage({ message: challenge.data.message }) });
  fixtureCookie = login.cookies[0];
  const store = new AccountStore(db), userId = login.data.user.id;
  await store.initialize(userId, () => ({ state: initialState(), imported: false }));
  const prepared = await prepareAgent(store, authEnv, userId, 'card-1', owner.address, origin);
  await enableAgent(store, userId, 'card-1', await owner.signTypedData(consentTypedData(prepared.effect.setup, origin)), origin);
  services.marketProvider.fund(prepared.effect.setup.address);
}
const server = http.createServer(async (req, res) => {
  if (req.headers.host !== '127.0.0.1:' + port) { res.writeHead(403); res.end(); return; }
  const url = new URL(req.url, origin);
  if (fixture && url.pathname === '/__fixture/login') { res.writeHead(303, { location: '/#/app', 'set-cookie': fixtureCookie }); res.end(); return; }
  if (fixture && url.pathname === '/__fixture/stats') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ fixture: true, providerTransfers: services.marketProvider.providerTransfers, feeTransfers: services.marketProvider.feeTransfers, broadcasts: services.marketProvider.broadcasts })); return; }
  if (url.pathname.startsWith('/api/')) return handler(req, res);
  const assets = collectAssets(), assetPath = url.pathname === '/' ? '/index.html' : /^\/(terms|privacy|support)\/?$/.test(url.pathname) ? url.pathname.replace(/\/$/, '') + '.html' : url.pathname, asset = assets[assetPath];
  if (!asset) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' }); res.end(Buffer.from(asset.base64, 'base64'));
});
server.listen(port, '127.0.0.1', () => console.log('Grantfold Vercel preview: ' + origin + (fixture ? '\nISOLATED FIXTURE: simulated funds only. Open /__fixture/login for browser QA.' : '\nWallet sign-in; real quotes and local-only database.')));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
