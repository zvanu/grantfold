import { AccountStore, AppError } from './store.mjs';
import { requestUser, requestBody, apiJson } from './api.mjs';
import { MarketProvider } from './market.mjs';
import { agentStatus, buyAsAgent, executeAgentOrder } from './agents.mjs';
import { liveTotals } from '../shared/payment.mjs';

const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const card = { type: 'string', description: 'Card ID returned by grantfold_list_cards.' };
const tools = [
  { name: 'grantfold_list_cards', description: 'List your Grantfold cards, live spending limits and enabled agent wallets. Does not spend money.', inputSchema: schema({}, []), annotations: { readOnlyHint: true } },
  { name: 'grantfold_agent_status', description: 'Read a card’s client-funded agent wallet balances and consent limits. No private keys are returned.', inputSchema: schema({ card_id: card }, ['card_id']), annotations: { readOnlyHint: true } },
  { name: 'grantfold_buy_market', description: 'Buy a Crypto market overview using an enabled client-funded agent wallet on Robinhood Chain. Charges provider price plus up to 5% Grantfold fee, reduced only by a server-verified token tier; network gas is paid from that wallet’s ETH under its consented cap. Reuse request_id on retries. Above-threshold orders wait for owner approval. Never use a fresh request_id to retry an unresolved payment.', inputSchema: schema({ card_id: card, request_id: { type: 'string', minLength: 16, maxLength: 100 }, max_total_micros: { type: 'integer', minimum: 1, maximum: 1050000, description: 'Maximum provider price plus fee, in 1e-6 USDG. For 0.01575 USDG use 15750.' } }, ['card_id', 'request_id', 'max_total_micros']), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  { name: 'grantfold_check_order', description: 'Recover an existing agent purchase and its fee using the saved signatures/transaction. Returns a report only after both transfers are verified. Does not create a new purchase.', inputSchema: schema({ order_id: { type: 'string' } }, ['order_id']), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
];
function fields(args, allowed) { if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).some(k => !allowed.includes(k))) throw new AppError(422, 'tool_arguments', 'Unsupported tool arguments.'); }
function orderResult(snapshot, id) { const order = snapshot.state.liveOrders?.find(o => o.id === id); return { order, revision: snapshot.revision, instruction: order?.status === 'completed' ? 'Purchase and service fee verified. Use the report.' : order?.status === 'agent_approval' ? 'Ask the owner to approve this exact order in Grantfold. No payment has been submitted.' : 'Check this same order. Do not create another purchase to retry it.' }; }
export async function handleMcp(request, env, services = {}) {
  if (request.method !== 'POST') return apiJson({ error: 'Use JSON-RPC POST.' }, 405, { Allow: 'POST' });
  let call;
  try { call = await requestBody(request); } catch { return apiJson({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC request.' } }, 400); }
  const id = typeof call.id === 'string' || typeof call.id === 'number' ? call.id : null;
  const reply = result => apiJson({ jsonrpc: '2.0', id, result });
  const error = (code, message) => apiJson({ jsonrpc: '2.0', id, error: { code, message } });
  if (call.jsonrpc !== '2.0' || typeof call.method !== 'string') return error(-32600, 'Invalid JSON-RPC request.');
  if (call.method === 'server/discover') return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} } });
  if (call.method === 'initialize') return reply({ protocolVersion: call.params?.protocolVersion === '2025-11-25' ? '2025-11-25' : '2026-07-28', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'Grantfold', version: '6.0.0' } });
  if (call.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (call.method === 'ping') return reply({});
  if (call.method === 'tools/list') return reply({ tools });
  if (call.method !== 'tools/call') return error(-32601, 'Method not found.');
  if (id === null) return error(-32600, 'Tool calls require a request ID.');
  try {
    const user = requestUser(request); if (!user) throw new AppError(401, 'sign_in_required', 'Connect Grantfold with your authenticated Site account.');
    const store = new AccountStore(env.DB), provider = services.marketProvider || new MarketProvider(), args = call.params?.arguments || {};
    let result;
    if (call.params?.name === 'grantfold_list_cards') {
      fields(args, []); const snapshot = await store.get(user.id);
      result = { cards: snapshot.state.cards.map(c => ({ id: c.id, name: c.name, frozen: c.frozen, perBuyMicros: c.perBuy * 10000, perDayMicros: c.perDay * 10000, approvalAboveMicros: c.askAbove * 10000, agentEnabled: snapshot.state.agents?.[c.id]?.enabled === true, consentValidUntil: snapshot.state.agents?.[c.id]?.validUntil, liveTotals: liveTotals(snapshot.state, c.id) })) };
    } else if (call.params?.name === 'grantfold_agent_status') {
      fields(args, ['card_id']); const status = await agentStatus(store, env, user.id, args.card_id, provider); result = { wallet: status.wallet };
    } else if (call.params?.name === 'grantfold_buy_market') {
      fields(args, ['card_id', 'request_id', 'max_total_micros']); const snapshot = await buyAsAgent(store, env, user.id, args.card_id, args.request_id, args.max_total_micros, provider);
      const prior = await store.receipt(user.id, 'agent-buy-' + args.request_id, JSON.stringify([args.card_id, args.max_total_micros])); result = orderResult(snapshot, prior.orderId);
    } else if (call.params?.name === 'grantfold_check_order') {
      fields(args, ['order_id']); result = orderResult(await executeAgentOrder(store, env, user.id, args.order_id, provider), args.order_id);
    } else return error(-32602, 'Unknown tool.');
    return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
  } catch (failure) { return reply({ content: [{ type: 'text', text: JSON.stringify({ code: failure instanceof AppError ? failure.code : 'tool_failed', message: failure instanceof AppError ? failure.message : 'This action could not be completed. Check the existing order before retrying.' }) }], isError: true }); }
}
