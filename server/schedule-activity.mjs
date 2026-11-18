export function recordScheduleActivity(state, cardId, kind, reference, text, order) {
  const plan = state.schedules?.[cardId];
  if (!plan) return;
  const id = `${plan.id}:${kind}:${reference}`;
  state.scheduleActivity ??= [];
  if (state.scheduleActivity.some(item => item.id === id)) return;
  const item = { id, cardId, scheduleId: plan.id, kind, text, time: Date.now() };
  if (order) item.orderId = order.id;
  if (kind === 'completed' && order?.status === 'completed') {
    item.amountMicros = order.amountMicros; item.feeMicros = order.feeMicros; item.feeBps = order.feeBps;
    for (const [field, receipt] of [['providerTransaction', order.receipt], ['feeTransaction', order.feeReceipt]]) {
      if (/^0x[0-9a-f]{64}$/i.test(receipt?.transaction || '')) item[field] = receipt.transaction;
    }
  }
  state.scheduleActivity.unshift(item);
  state.scheduleActivity = state.scheduleActivity.slice(0, 100);
}
