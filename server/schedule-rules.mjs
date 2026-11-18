import { AppError } from './store.mjs';
import { orderTotal } from '../shared/commission.mjs';
import { scheduleRules } from '../shared/schedule.mjs';

export function scheduledOrderAllowed(state, order, now = Date.now()) {
  if (!order.scheduleId) return true;
  const plan = state.schedules?.[order.cardId];
  return !!(plan && plan.id === order.scheduleId && ['running', 'awaiting_approval'].includes(plan.status)
    && plan.currentRun?.orderId === order.id && plan.currentRun.slotAt === order.scheduleSlotAt
    && order.scheduleSlotAt >= plan.firstRunAt && (order.scheduleSlotAt - plan.firstRunAt) % scheduleRules.intervalMs === 0
    && plan.agentGrantNonce === order.agentGrantNonce && plan.validUntil > now
    && now >= order.scheduleSlotAt && now < order.scheduleSlotAt + scheduleRules.windowMs
    && orderTotal(order) <= plan.maxTotalMicros && plan.startedRuns <= plan.maxRuns);
}
export function assertScheduledOrder(state, order, now = Date.now()) {
  if (!scheduledOrderAllowed(state, order, now)) throw new AppError(403, 'schedule_stopped', 'This schedule no longer permits a new payment. Submitted payments must be recovered using the same saved order.');
}
export function stopCardSchedule(state, cardId, reason = 'Agent paused.') {
  const plan = state.schedules?.[cardId];
  delete state.scheduleSetups?.[cardId];
  if (!plan || ['completed', 'expired'].includes(plan.status)) return;
  plan.status = 'paused'; plan.message = reason;
  const order = (state.liveOrders || []).find(o => o.id === plan.currentRun?.orderId);
  if (order && !order.submittedAt && ['quoted', 'ready', 'agent_approval'].includes(order.status)) {
    order.status = 'cancelled'; order.message = 'Schedule paused before payment submission. No purchase was made.';
    plan.currentRun = null;
  }
}
