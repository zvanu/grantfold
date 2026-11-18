import { readChainTool } from './rpc-tools.mjs';
import { productRequest } from './products.mjs';
import { AccountStore, AppError } from './store.mjs';
import { importLegacyState, applyAction } from './domain.mjs';
import { MarketProvider, liveFields, addLiveQuote, prepareLiveOrder, cancelLiveOrder, submitLivePayment } from './market.mjs';
import { prepareAgent, enableAgent, revokeAgent, agentStatus, quoteForAgent, addAgentQuote, approveAgentOrder, executeAgentOrder, prepareWithdrawal, executeWithdrawal, checkWithdrawal, cancelWithdrawal } from './agents.mjs';
import { checkCommission, prepareCommissionTransaction, declineCommissionTransaction, rememberCommissionTransaction } from './commission.mjs';
import { commissionQuote, publicFeePolicy, liveReadiness } from './discounts.mjs';
import { commission } from '../shared/commission.mjs';
import { isLiveMarketRequest, prepareAssistantPurchase, assistantControlIntent, assistantControl } from './assistant.mjs';
import { walletSessionUser, loginChallenge, verifyLogin, logout } from './auth.mjs';
import { publicScheduling, authorizedCron, runDueSchedules, prepareSchedule, enableSchedule, pauseSchedule } from './schedules.mjs';

const accountCapabilities = Object.freeze({ mode: 'pilot', sandboxBalances: true, chainId: 4663, paymentAsset: 'USDG', paymentsEnabled: true, providerEnabled: true, liveMarket: { enabled: true, settlement: 'customer_wallet', automaticAgentPayments: true } });

export function apiJson(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'vary': 'Cookie, OAI-Authenticated-User-Id', ...extra } });
}

export function requestUser(request) {
  // Sites dispatch validates sign-in and injects these headers. The Worker is
  // deployed behind that boundary; the local server strips client copies.
  const id = request.headers.get('oai-authenticated-user-id');
  const email = request.headers.get('oai-authenticated-user-email');
  if (!id || !email || id.length > 200 || email.length > 320) return null;
  let displayName = email;
  if (request.headers.get('oai-authenticated-user-full-name-encoding') === 'percent-encoded-utf-8') {
    try { displayName = decodeURIComponent(request.headers.get('oai-authenticated-user-full-name') || '') || email; } catch {}
  }
  return { id, email, displayName: displayName.slice(0, 200) };
}

export async function requestBody(request, maximum = 32_768) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new AppError(415, 'json_required', 'Send this request as JSON.');
  if (Number(request.headers.get('content-length') || 0) > maximum) throw new AppError(413, 'request_too_large', 'This request is too large.');
  if (!request.body) throw new AppError(400, 'invalid_json', 'Provide a JSON request body.');
  const reader = request.body.getReader(), chunks = []; let size = 0;
  for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > maximum) { await reader.cancel(); throw new AppError(413, 'request_too_large', 'This request is too large.'); } chunks.push(value); }
  const buffer = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { const value = JSON.parse(new TextDecoder().decode(buffer)); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); return value; } catch { throw new AppError(400, 'invalid_json', 'Provide a valid JSON object.'); }
}

function validateWriteOrigin(request) {
  const origin = request.headers.get('origin'), ownOrigin = new URL(request.url).origin;
  if ((origin && origin !== ownOrigin) || request.headers.get('sec-fetch-site') === 'cross-site' || request.headers.get('x-grantfold-client') !== 'browser') throw new AppError(403, 'origin_refused', 'This action must come from your Grantfold account.');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

async function requestDigest(body) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(body)));
  return Array.from(new Uint8Array(bytes), v => v.toString(16).padStart(2, '0')).join('');
}

export async function handleApi(request, env, services = {}) {
  const path = new URL(request.url).pathname;
  try {
    const cron = /^\/api\/cron\/schedules\/([01]\d|2[0-3])$/.exec(path);
    if (cron) {
      if (request.method !== 'GET') return apiJson({ error: { code: 'method_refused', message: 'Use GET.' } }, 405);
      if (!(await authorizedCron(request, env))) return apiJson({ error: { code: 'cron_unauthorized', message: 'Unauthorized scheduler request.' } }, 401);
      return apiJson(await runDueSchedules(env, services.marketProvider || new MarketProvider(), Number(cron[1])));
    }
    const user = env.AUTH_MODE === 'wallet' ? await walletSessionUser(request, env) : requestUser(request);
    if (path === '/api/session' && request.method === 'GET') return apiJson({ authenticated: !!user, user, authentication: env.AUTH_MODE === 'wallet' ? 'wallet' : 'platform', ...accountCapabilities, commission, agentWalletsConfigured: /^[a-f0-9]{64}$/i.test(env.GRANTFOLD_WALLET_KEY_V1 || ''), fees: publicFeePolicy(env.GRANTFOLD_FEE_POLICY), scheduling: publicScheduling(env) });
    if (env.AUTH_MODE === 'wallet' && ['/api/auth/challenge', '/api/auth/verify', '/api/auth/logout'].includes(path) && request.method === 'POST') {
      validateWriteOrigin(request);
      const body = await requestBody(request);
      const result = path.endsWith('/challenge') ? await loginChallenge(request, env, body) : path.endsWith('/verify') ? await verifyLogin(request, env, body) : await logout(request, env);
      const response = apiJson(result.data); for (const value of result.cookies) response.headers.append('set-cookie', value); return response;
    }
    if (path === '/api/fees' && request.method === 'GET') return apiJson(publicFeePolicy(env.GRANTFOLD_FEE_POLICY));
    if (!user) throw new AppError(401, 'sign_in_required', env.AUTH_MODE === 'wallet' ? 'Connect your wallet to open your Grantfold account.' : 'Sign in with ChatGPT to open your Grantfold account.');
    if (!['GET', 'POST'].includes(request.method)) return apiJson({ error: { code: 'method_refused', message: 'Use GET or POST for this endpoint.' } }, 405, { Allow: 'GET, POST' });
    if (request.method === 'POST') validateWriteOrigin(request);
    const store = new AccountStore(env.DB);
    if (path === '/api/tools/rpc' && request.method === 'POST') return apiJson(await readChainTool(store, user.id, await requestBody(request), services.marketProvider || new MarketProvider()));
    if (['/api/schedule/prepare', '/api/schedule/enable', '/api/schedule/pause'].includes(path) && request.method === 'POST') {
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) throw new AppError(400, 'request_key_required', 'Provide a unique request key for this action.');
      const body = await requestBody(request), hash = await requestDigest({ path, body }), origin = new URL(request.url).origin;
      const result = path.endsWith('/prepare') ? await prepareSchedule(store, env, user, key, hash, body, origin)
        : path.endsWith('/enable') ? await enableSchedule(store, env, user, key, hash, body, origin)
        : await pauseSchedule(store, user.id, key, hash, body);
      return apiJson({ ...result, user, ...accountCapabilities });
    }
    if (path === '/api/live/status' && request.method === 'GET') return apiJson(await liveReadiness(services.marketProvider || new MarketProvider(), env));
    if (path === '/api/services/quote' && request.method === 'POST') {
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) throw new AppError(400, 'request_key_required', 'Provide a unique request key.');
      const body = await requestBody(request);
      if (Object.keys(body).some(k => !['cardId', 'productId', 'input', 'agent'].includes(k)) || typeof body.cardId !== 'string' || !['compute', 'research'].includes(body.productId) || typeof body.agent !== 'boolean') throw new AppError(422, 'product_invalid', 'Choose a supported service, inputs and paying wallet.');
      productRequest(body.productId, body.input);
      const hash = await requestDigest({ path, body }), prior = await store.receipt(user.id, key, hash);
      if (prior) return apiJson({ ...await store.get(user.id), effect: prior, replayed: true, user, ...accountCapabilities });
      const state = (await store.get(user.id)).state, card = state.cards.find(c => c.id === body.cardId);
      if (!card) throw new AppError(404, 'card_missing', 'This card was not found in your account.');
      const provider = services.marketProvider || new MarketProvider();
      const quote = body.agent ? await quoteForAgent(store, env, user.id, body.cardId, provider, body.productId, body.input) : await provider.quote(body.productId, body.input);
      const result = await store.mutate(user.id, key, hash, current => body.agent ? addAgentQuote(current, body.cardId, quote) : addLiveQuote(current, body.cardId, quote));
      return apiJson({ ...result, user, ...accountCapabilities });
    }
    if (path.startsWith('/api/agent/') && request.method === 'POST') {
      const body = await requestBody(request), provider = services.marketProvider || new MarketProvider(), origin = new URL(request.url).origin;
      let result;
      if (path === '/api/agent/prepare') { liveFields(body, ['cardId', 'owner']); if (user.address && body.owner.toLowerCase() !== user.address.toLowerCase()) throw new AppError(403, 'agent_owner_mismatch', 'Sign in with the wallet that will own this agent.'); result = await prepareAgent(store, env, user.id, body.cardId, body.owner, origin); }
      else if (path === '/api/agent/enable') { liveFields(body, ['cardId', 'signature']); result = await enableAgent(store, user.id, body.cardId, body.signature, origin); }
      else if (path === '/api/agent/revoke') { liveFields(body, ['cardId']); result = await revokeAgent(store, user.id, body.cardId); }
      else if (path === '/api/agent/status') { liveFields(body, ['cardId']); result = await agentStatus(store, env, user.id, body.cardId, provider); }
      else if (path === '/api/agent/check') { liveFields(body, ['orderId']); result = await executeAgentOrder(store, env, user.id, body.orderId, provider); }
      else if (path === '/api/agent/approve') { liveFields(body, ['orderId']); result = await approveAgentOrder(store, env, user.id, body.orderId, provider); }
      else if (path === '/api/agent/withdraw_prepare') { liveFields(body, ['cardId', 'asset', 'amount']); result = await prepareWithdrawal(store, env, user.id, body.cardId, body.asset, body.amount, origin); }
      else if (path === '/api/agent/withdraw') { liveFields(body, ['withdrawalId', 'signature']); result = await executeWithdrawal(store, env, user.id, body.withdrawalId, body.signature, origin, provider); }
      else if (path === '/api/agent/withdraw_cancel') { liveFields(body, ['withdrawalId']); result = await cancelWithdrawal(store, env, user.id, body.withdrawalId); }
      else if (path === '/api/agent/withdraw_check') { liveFields(body, ['withdrawalId']); result = await checkWithdrawal(store, user.id, body.withdrawalId, provider); }
      else throw new AppError(404, 'endpoint_missing', 'Agent endpoint not found.');
      return apiJson({ ...result, user, ...accountCapabilities });
    }
    if (path.startsWith('/api/live/fee_') && request.method === 'POST') {
      const body = await requestBody(request), provider = services.marketProvider || new MarketProvider(); let result;
      if ((await store.get(user.id)).state.liveOrders?.find(o => o.id === body.orderId)?.agent) throw new AppError(409, 'agent_order_route', 'Resume this order through the agent endpoint.');
      if (path === '/api/live/fee_transaction') { liveFields(body, ['orderId']); result = await prepareCommissionTransaction(store, user.id, body.orderId, provider); }
      else if (path === '/api/live/fee_declined') { liveFields(body, ['orderId']); result = await declineCommissionTransaction(store, user.id, body.orderId); }
      else if (path === '/api/live/fee_check') { liveFields(body, ['orderId'], ['transaction']); if (body.transaction) await rememberCommissionTransaction(store, user.id, body.orderId, body.transaction); result = await checkCommission(store, user.id, body.orderId, provider, body.transaction); }
      else throw new AppError(404, 'endpoint_missing', 'Fee endpoint not found.');
      return apiJson({ ...result, user, ...accountCapabilities });
    }
    if (path === '/api/account/bootstrap' && request.method === 'POST') {
      const body = await requestBody(request, 1_000_000);
      if (Object.keys(body).some(k => k !== 'legacy')) throw new AppError(422, 'invalid_request', 'This setup request contains unsupported fields.');
      const account = await store.initialize(user.id, () => importLegacyState(body.legacy));
      return apiJson({ ...account, user, ...accountCapabilities });
    }
    if (path === '/api/account' && request.method === 'GET') return apiJson({ ...await store.get(user.id), user, ...accountCapabilities });
    if (path === '/api/audit' && request.method === 'GET') return apiJson({ events: await store.audit(user.id), ...accountCapabilities });
    if (['/api/live/quote', '/api/live/prepare', '/api/live/cancel', '/api/live/pay', '/api/live/check'].includes(path) && request.method === 'POST') {
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) throw new AppError(400, 'request_key_required', 'Provide a unique request key for this action.');
      const body = await requestBody(request), provider = services.marketProvider || new MarketProvider();
      if (!['/api/live/quote', '/api/live/cancel'].includes(path) && (await store.get(user.id)).state.liveOrders?.find(o => o.id === body.orderId)?.agent) throw new AppError(409, 'agent_order_route', 'Resume this order through the agent endpoint.');
      let result;
      if (path === '/api/live/pay') {
        liveFields(body, ['orderId', 'signature'], ['feeSignature']); result = await submitLivePayment(store, user.id, body.orderId, body.signature, provider, { feeSignature: body.feeSignature });
      } else if (path === '/api/live/check') {
        liveFields(body, ['orderId']); const job = await store.paymentJob(user.id, body.orderId);
        if (!job) throw new AppError(409, 'live_payment_not_submitted', 'This order has no saved payment.');
        result = await submitLivePayment(store, user.id, body.orderId, job.payload.payload.signature, provider);
      } else {
        const hash = await requestDigest({ path, body }), prior = await store.receipt(user.id, key, hash);
        if (prior) result = { ...await store.get(user.id), effect: prior, replayed: true };
        else if (path === '/api/live/quote') {
          liveFields(body, ['cardId']); await store.get(user.id); const quote = await provider.quote();
          result = await store.mutate(user.id, key, hash, state => addLiveQuote(state, body.cardId, quote));
        } else if (path === '/api/live/prepare') {
          liveFields(body, ['orderId', 'wallet']);
          const snapshot = await store.get(user.id), order = snapshot.state.liveOrders?.find(o => o.id === body.orderId);
          const pricing = order && !order.authorization && Number.isInteger(order.feeBps) ? await commissionQuote(order.amountMicros, body.wallet, provider, env.GRANTFOLD_FEE_POLICY) : undefined;
          result = await store.mutate(user.id, key, hash, state => prepareLiveOrder(state, body.orderId, body.wallet, Date.now(), pricing));
        } else {
          liveFields(body, ['orderId']); result = await store.mutate(user.id, key, hash, state => cancelLiveOrder(state, body.orderId));
        }
      }
      return apiJson({ ...result, user, ...accountCapabilities });
    }
    if (path === '/api/actions' && request.method === 'POST') {
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) throw new AppError(400, 'request_key_required', 'Provide a unique request key for this action.');
      const body = await requestBody(request);
      const hash = await requestDigest(body);
      const result = body.type === 'assistant' && assistantControlIntent(body.text)
        ? await assistantControl(store, env, user, key, hash, body, services.marketProvider || new MarketProvider())
        : body.type === 'assistant' && isLiveMarketRequest(body.text)
          ? await prepareAssistantPurchase(store, env, user.id, key, hash, body, services.marketProvider || new MarketProvider())
          : await store.mutate(user.id, key, hash, state => applyAction(state, body));
      return apiJson({ ...result, user, ...accountCapabilities });
    }
    throw new AppError(404, 'endpoint_missing', 'This account endpoint was not found.');
  } catch (error) {
    if (error instanceof AppError) return apiJson({ error: { code: error.code, message: error.message } }, error.status);
    console.error('Grantfold API failure', error?.name || 'Error');
    return apiJson({ error: { code: 'server_error', message: 'The account could not be updated. Retry the same request or reload to check its status.' } }, 500);
  }
}
