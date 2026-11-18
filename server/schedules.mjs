import { recoverTypedDataAddress } from 'viem';
import { AccountStore, AppError } from './store.mjs';
import { quoteForAgent, addAgentQuote, executeAgentOrder } from './agents.mjs';
import { liveHeld } from '../shared/payment.mjs';
import { orderTotal } from '../shared/commission.mjs';
import { scheduleRules, scheduleTypedData, nextScheduleWindow } from '../shared/schedule.mjs';
import { stopCardSchedule } from './schedule-rules.mjs';
import { recordScheduleActivity } from './schedule-activity.mjs';

const requireValue = (ok, code, text, status = 422) => { if (!ok) throw new AppError(status, code, text); };
const configured = env => /^[a-zA-Z0-9_-]{32,200}$/.test(env.CRON_SECRET || '');
export const publicScheduling = env => ({ configured: configured(env), frequency: 'daily', windowMinutes: 60, maxRuns: 7 });
const cardOf = (state, id) => { const card = state.cards.find(c => c.id === id); requireValue(card, 'card_missing', 'This card was not found in your account.', 404); return card; };
function activeGrant(state, cardId, origin) {
  const card = cardOf(state, cardId), grant = state.agents?.[cardId];
  requireValue(grant?.enabled && grant.validUntil > Date.now() && !card.frozen, 'schedule_agent_disabled', 'Enable a current agent consent before authorizing a schedule.', 403);
  requireValue(grant.site === origin && card.categories.includes('Market data'), 'schedule_agent_scope', 'Renew the agent consent on this website and allow Market data before scheduling.', 403);
  return { card, grant };
}
function fields(body, names) { requireValue(body && Object.keys(body).length === names.length && Object.keys(body).every(k => names.includes(k)), 'invalid_request', 'This schedule request contains missing or unsupported fields.'); }
function scheduleEvent(state, cardId, kind, effect = {}) { return { state, effect: { cardId, ...effect }, audit: { kind, cardId, mode: 'agent' } }; }
async function validSignature(plan) {
  if (plan.product !== scheduleRules.product || plan.intervalMs !== scheduleRules.intervalMs || plan.utcHour !== new Date(plan.firstRunAt).getUTCHours() || plan.firstRunAt % scheduleRules.windowMs !== 0 || !Number.isSafeInteger(plan.maxTotalMicros) || plan.maxTotalMicros <= 0 || plan.maxTotalMicros > scheduleRules.maxTotalMicros || !Number.isInteger(plan.maxRuns) || plan.maxRuns < 1 || plan.maxRuns > 7) return false;
  let owner; try { owner = await recoverTypedDataAddress({ ...scheduleTypedData(plan), signature: plan.signature }); } catch {}
  return owner?.toLowerCase() === plan.owner.toLowerCase();
}

export async function prepareSchedule(store, env, user, key, hash, body, origin) {
  fields(body, ['cardId', 'utcHour', 'maxRuns', 'maxTotalMicros']);
  requireValue(configured(env), 'scheduler_unavailable', 'The production scheduler is not configured.', 503);
  requireValue(typeof body.cardId === 'string' && Number.isInteger(body.utcHour) && body.utcHour >= 0 && body.utcHour < 24 && Number.isInteger(body.maxRuns) && body.maxRuns >= 1 && body.maxRuns <= 7 && Number.isSafeInteger(body.maxTotalMicros) && body.maxTotalMicros > 0 && body.maxTotalMicros <= scheduleRules.maxTotalMicros, 'schedule_invalid', 'Use a UTC hour, 1–7 purchases and a positive per-purchase cap of at most 1.05 USDG.');
  const prior = await store.receipt(user.id, key, hash); if (prior) return { ...await store.get(user.id), effect: prior, replayed: true };
  return store.mutate(user.id, key, hash, state => {
    const { card, grant } = activeGrant(state, body.cardId, origin), now = Date.now();
    requireValue(!user.address || user.address.toLowerCase() === grant.owner.toLowerCase(), 'schedule_owner', 'Sign in with the linked owner wallet.', 403);
    const existing = state.schedules?.[body.cardId];
    requireValue(!existing || (['paused', 'completed', 'expired'].includes(existing.status) && !existing.currentRun), 'schedule_existing', 'Pause the previous schedule and resolve its existing order first.', 409);
    requireValue(!(state.liveOrders || []).some(o => o.cardId === body.cardId && liveHeld(o)), 'schedule_order_open', 'Resolve the existing live order before scheduling.', 409);
    requireValue(body.maxTotalMicros <= Math.min(grant.perBuyMicros, card.perBuy * 10000), 'schedule_cap', 'The cap cannot exceed your current card or signed agent limit.');
    const firstRunAt = nextScheduleWindow(now, body.utcHour);
    requireValue(firstRunAt + scheduleRules.windowMs <= grant.validUntil, 'schedule_consent_expiring', 'Renew the agent consent so it covers the first daily window.');
    const plan = { id: 'schedule-' + crypto.randomUUID(), cardId: body.cardId, owner: grant.owner, agent: grant.address, site: origin, product: scheduleRules.product,
      utcHour: body.utcHour, firstRunAt, intervalMs: scheduleRules.intervalMs, validUntil: grant.validUntil,
      maxRuns: body.maxRuns, maxTotalMicros: body.maxTotalMicros, agentGrantNonce: grant.nonce,
      nonce: '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''), setupExpiresAt: now + 300000 };
    state.scheduleSetups ??= {}; state.scheduleSetups[body.cardId] = plan;
    return scheduleEvent(state, body.cardId, 'schedule_prepared', { setup: plan });
  });
}

export async function enableSchedule(store, env, user, key, hash, body, origin) {
  fields(body, ['cardId', 'signature']);
  requireValue(configured(env), 'scheduler_unavailable', 'The production scheduler is not configured.', 503);
  requireValue(typeof body.cardId === 'string' && /^0x[0-9a-f]{130}$/i.test(body.signature || ''), 'schedule_signature', 'Sign the exact schedule with the linked owner wallet.');
  const prior = await store.receipt(user.id, key, hash); if (prior) return { ...await store.get(user.id), effect: prior, replayed: true };
  const { state } = await store.get(user.id); cardOf(state, body.cardId);
  const setup = state.scheduleSetups?.[body.cardId], previous = state.schedules?.[body.cardId];
  if (!setup && previous?.signature === body.signature && previous.site === origin) return { ...await store.get(user.id), effect: { cardId: body.cardId, replayed: true } };
  requireValue(setup && setup.site === origin && setup.setupExpiresAt > Date.now(), 'schedule_setup_expired', 'Review a fresh schedule before signing.');
  requireValue(await validSignature({ ...setup, signature: body.signature }), 'schedule_signature', 'The linked owner must sign this exact schedule.');
  return store.mutate(user.id, key, hash, current => {
    const { grant } = activeGrant(current, body.cardId, origin);
    requireValue(current.scheduleSetups?.[body.cardId]?.nonce === setup.nonce && grant.nonce === setup.agentGrantNonce, 'schedule_changed', 'The plan or agent consent changed. Review it again.', 409);
    requireValue(setup.firstRunAt > Date.now() && setup.validUntil <= grant.validUntil, 'schedule_setup_expired', 'This first window or consent changed. Prepare a fresh schedule.');
    current.schedules ??= {}; current.schedules[body.cardId] = { ...setup, signature: body.signature, status: 'active', startedRuns: 0, completedRuns: 0, skippedRuns: 0, nextRunAt: setup.firstRunAt, currentRun: null, message: 'Daily purchases authorized. No purchase has run yet.' };
    delete current.scheduleSetups[body.cardId];
    recordScheduleActivity(current, body.cardId, 'enabled', setup.id, 'Daily purchases authorized. The first window is in the future.');
    return scheduleEvent(current, body.cardId, 'schedule_enabled');
  });
}

export async function pauseSchedule(store, userId, key, hash, body) {
  fields(body, ['cardId']);
  return store.mutate(userId, key, hash, state => { cardOf(state, body.cardId); stopCardSchedule(state, body.cardId, 'Schedule paused. No new scheduled purchases are allowed.'); return scheduleEvent(state, body.cardId, 'schedule_paused'); });
}

async function stopForIssue(store, userId, cardId, planId, text) {
  return store.mutate(userId, 'schedule-stop-' + crypto.randomUUID(), planId, state => {
    if (state.schedules?.[cardId]?.id === planId) stopCardSchedule(state, cardId, text);
    return scheduleEvent(state, cardId, 'schedule_stopped');
  });
}
async function skipWindow(store, userId, cardId, planId, slotAt, text) {
  return store.mutate(userId, 'schedule-skip-' + planId + '-' + slotAt, String(slotAt), state => {
    const plan = state.schedules?.[cardId];
    if (plan?.id === planId && plan.status === 'active' && plan.nextRunAt === slotAt) {
      recordScheduleActivity(state, cardId, 'skipped', slotAt, text);
      plan.skippedRuns++; plan.message = text; plan.nextRunAt = nextScheduleWindow(Date.now(), plan.utcHour);
      if (plan.nextRunAt >= plan.validUntil) plan.status = 'expired';
    }
    return scheduleEvent(state, cardId, 'schedule_window_skipped');
  });
}
async function finishRun(store, userId, cardId, planId) {
  const { state } = await store.get(userId), plan = state.schedules?.[cardId], order = state.liveOrders?.find(o => o.id === plan?.currentRun?.orderId);
  if (!plan || plan.id !== planId || !order) return 'idle';
  if (order.status === 'agent_approval') {
    await store.mutate(userId, 'schedule-approval-' + order.id, order.id, current => {
      const p = current.schedules?.[cardId]; if (p?.id === planId && p.status !== 'paused') { p.status = 'awaiting_approval'; p.message = 'This price exceeds the card approval threshold. Review the same order in Approvals.'; recordScheduleActivity(current, cardId, 'approval', order.id, p.message, order); }
      return scheduleEvent(current, cardId, 'schedule_awaiting_approval');
    }); return 'approval';
  }
  if (!['completed', 'cancelled', 'failed'].includes(order.status)) {
    if (['needs_review', 'fee_due', 'fee_checking'].includes(order.status)) await store.mutate(userId, 'schedule-checking-' + order.id, order.id, current => {
      const saved = current.liveOrders?.find(o => o.id === order.id);
      if (current.schedules?.[cardId]?.id === planId && ['needs_review', 'fee_due', 'fee_checking'].includes(saved?.status)) recordScheduleActivity(current, cardId, 'checking', order.id, 'Payment or delivery needs checking. Recover this same saved order; do not buy again.', saved);
      return scheduleEvent(current, cardId, 'schedule_needs_checking');
    });
    return 'pending';
  }
  await store.mutate(userId, 'schedule-finish-' + order.id + '-' + order.status, order.id, current => {
    const p = current.schedules?.[cardId], o = current.liveOrders.find(v => v.id === order.id);
    if (p?.id !== planId || p.currentRun?.orderId !== o.id) return scheduleEvent(current, cardId, 'schedule_status');
    p.currentRun = null; p.lastOrderId = o.id; p.message = o.message;
    recordScheduleActivity(current, cardId, o.status, o.id, o.status === 'completed' ? 'Scheduled market overview delivered. Provider payment and fee verified.' : 'Scheduled order closed without completion. Review the saved order.', o);
    if (o.status === 'completed') {
      p.completedRuns++; p.nextRunAt = Math.max(o.scheduleSlotAt + scheduleRules.intervalMs, nextScheduleWindow(Date.now(), p.utcHour));
      if (p.startedRuns >= p.maxRuns) p.status = 'completed';
      else if (p.validUntil <= p.nextRunAt) p.status = 'expired';
      else if (p.status !== 'paused') p.status = 'active';
    } else { p.status = 'paused'; p.message = 'The existing order closed without completion. Review it before authorizing a new schedule.'; }
    return scheduleEvent(current, cardId, 'schedule_run_finished');
  }); return order.status;
}

export async function runSchedule(store, env, userId, cardId, provider, hour) {
  let { state } = await store.get(userId), plan = state.schedules?.[cardId];
  if (!plan) return 'idle';
  if (!(await validSignature(plan))) { await stopForIssue(store, userId, cardId, plan.id, 'The schedule signature could not be verified. Review a fresh schedule.'); return 'stopped'; }
  let order = state.liveOrders?.find(o => o.id === plan.currentRun?.orderId);
  if (order) {
    if (!order.submittedAt && order.expiresAt <= Date.now() && ['quoted', 'ready', 'agent_approval'].includes(order.status)) {
      await stopForIssue(store, userId, cardId, plan.id, 'The unsigned scheduled quote expired. No payment was made. Review a fresh schedule.'); return 'stopped';
    }
    if (order.status === 'agent_approval' || ['completed', 'failed', 'cancelled'].includes(order.status)) return finishRun(store, userId, cardId, plan.id);
    try { await executeAgentOrder(store, env, userId, order.id, provider); }
    catch (error) {
      if (error?.code === 'agent_wallet_busy') return 'pending';
      const latest = (await store.get(userId)).state.liveOrders.find(o => o.id === order.id);
      if (!latest?.submittedAt) await stopForIssue(store, userId, cardId, plan.id, 'The saved scheduled order could not start. Check the agent, funds and limits before authorizing again.');
    }
    return finishRun(store, userId, cardId, plan.id);
  }
  if (plan.status !== 'active' || plan.utcHour !== hour || plan.nextRunAt > Date.now()) return 'idle';
  const slotAt = plan.nextRunAt;
  if (plan.validUntil <= Date.now() || plan.startedRuns >= plan.maxRuns) { await stopForIssue(store, userId, cardId, plan.id, 'The schedule reached its signed expiry or run limit.'); return 'stopped'; }
  if (Date.now() >= slotAt + scheduleRules.windowMs) { await skipWindow(store, userId, cardId, plan.id, slotAt, 'The daily window was missed. No catch-up purchase was made.'); return 'skipped'; }
  if ((state.liveOrders || []).some(o => o.cardId === cardId && liveHeld(o))) { await skipWindow(store, userId, cardId, plan.id, slotAt, 'An existing live order needs attention. No second purchase was created.'); return 'skipped'; }
  const grant = state.agents?.[cardId];
  if (!grant?.enabled || grant.nonce !== plan.agentGrantNonce || grant.validUntil < plan.validUntil || grant.site !== plan.site || grant.owner.toLowerCase() !== plan.owner.toLowerCase()) {
    await stopForIssue(store, userId, cardId, plan.id, 'The agent was paused, renewed or changed. Authorize a fresh schedule.'); return 'stopped';
  }
  let quote;
  try { quote = await quoteForAgent(store, env, userId, cardId, provider); }
  catch (error) {
    if (['agent_disabled', 'agent_frozen', 'agent_category_refused', 'agent_consent_changed'].includes(error?.code)) { await stopForIssue(store, userId, cardId, plan.id, 'The agent rules no longer permit a scheduled purchase.'); return 'stopped'; }
    await skipWindow(store, userId, cardId, plan.id, slotAt, 'The provider price or GFLD eligibility could not be verified. No payment was made.'); return 'skipped';
  }
  if (orderTotal(quote) > plan.maxTotalMicros) { await skipWindow(store, userId, cardId, plan.id, slotAt, 'The provider price plus fee exceeded the signed schedule cap. No payment was made.'); return 'skipped'; }
  const claimed = await store.mutate(userId, 'schedule-run-' + plan.id + '-' + slotAt, String(slotAt), current => {
    const p = current.schedules?.[cardId], g = current.agents?.[cardId];
    requireValue(p?.id === plan.id && p.status === 'active' && p.nextRunAt === slotAt && p.validUntil > Date.now() && p.startedRuns < p.maxRuns && g?.enabled && g.nonce === p.agentGrantNonce, 'schedule_changed', 'This schedule changed before payment.', 409);
    requireValue(Date.now() >= slotAt && Date.now() < slotAt + scheduleRules.windowMs && orderTotal(quote) <= p.maxTotalMicros, 'schedule_window', 'This daily window or price is no longer authorized.', 409);
    const result = addAgentQuote(current, cardId, quote), created = current.liveOrders.find(o => o.id === result.effect.orderId);
    created.scheduleId = p.id; created.scheduleSlotAt = slotAt;
    p.startedRuns++; p.status = 'running'; p.currentRun = { orderId: created.id, slotAt }; p.message = 'One scheduled order is being checked. Its saved reference is reused after interruptions.';
    recordScheduleActivity(current, cardId, 'started', created.id, 'Scheduled purchase started. Payment and delivery are not yet confirmed.', created);
    return scheduleEvent(current, cardId, 'schedule_run_started', { orderId: created.id });
  });
  try { await executeAgentOrder(store, env, userId, claimed.effect.orderId, provider); }
  catch (error) {
    if (error?.code === 'agent_wallet_busy') return 'pending';
    order = (await store.get(userId)).state.liveOrders.find(o => o.id === claimed.effect.orderId);
    if (!order?.submittedAt) await stopForIssue(store, userId, cardId, plan.id, 'This scheduled order could not start. Check funds, ETH gas and current limits before authorizing again.');
  }
  return finishRun(store, userId, cardId, plan.id);
}

export async function runDueSchedules(env, provider, hour) {
  const store = new AccountStore(env.DB);
  const rows = await env.DB.prepare("SELECT user_id FROM accounts WHERE EXISTS (SELECT 1 FROM json_each(accounts.state_json, '$.schedules') AS p WHERE (json_extract(p.value, '$.status') = 'active' AND json_extract(p.value, '$.utcHour') = ? AND json_extract(p.value, '$.nextRunAt') <= ?) OR json_extract(p.value, '$.currentRun.orderId') IS NOT NULL) ORDER BY updated_at ASC LIMIT 100").bind(hour, Date.now()).all();
  const jobs = [];
  for (const row of rows.results) {
    const { state } = await store.get(row.user_id);
    for (const [cardId, p] of Object.entries(state.schedules || {})) if (p.currentRun || (p.status === 'active' && p.utcHour === hour && p.nextRunAt <= Date.now())) jobs.push({ userId: row.user_id, cardId });
  }
  const deadline = Date.now() + 250000, outcomes = [];
  for (let i = 0; i < jobs.length && Date.now() < deadline; i += 4) {
    const batch = await Promise.allSettled(jobs.slice(i, i + 4).map(j => runSchedule(store, env, j.userId, j.cardId, provider, hour)));
    for (const r of batch) outcomes.push(r.status === 'fulfilled' ? r.value : 'pending');
  }
  return { checkedAt: Date.now(), hour, processed: outcomes.length, remaining: jobs.length - outcomes.length, outcomes: outcomes.reduce((out, value) => ({ ...out, [value]: (out[value] || 0) + 1 }), {}) };
}

export async function authorizedCron(request, env) {
  if (!configured(env)) return false;
  const actual = request.headers.get('authorization') || '', expected = 'Bearer ' + env.CRON_SECRET;
  const digest = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(actual), digest(expected)]);
  let difference = 0; const aa = new Uint8Array(a), bb = new Uint8Array(b); for (let i = 0; i < aa.length; i++) difference |= aa[i] ^ bb[i];
  return difference === 0;
}
