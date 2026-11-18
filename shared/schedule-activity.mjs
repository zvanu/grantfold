import { usdg, liveMarket } from './payment.mjs';

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function newScheduleNotifications(before, after) {
  const seen = new Set((before || []).map(item => item.id));
  return (after || []).filter(item => !seen.has(item.id));
}

export function scheduleActivityHTML(state, cardId, compact = false) {
  const items = (state.scheduleActivity || []).filter(item => item.cardId === cardId).slice(0, compact ? 4 : 100);
  if (!items.length) return '';
  return `<section class="panel"><div class="panel-title"><h2>Schedule activity</h2><span>Saved in your account</span></div><div class="activity-list">${items.map(item => {
    const order = (state.liveOrders || []).find(order => order.id === item.orderId && order.cardId === cardId);
    const amounts = item.kind === 'completed' ? `<small>Provider ${usdg(item.amountMicros)} · fee ${usdg(item.feeMicros)} (${item.feeBps / 100}%) · total ${usdg(item.amountMicros + item.feeMicros)}</small>` : '';
    const transactions = compact ? '' : [['providerTransaction', 'Provider transaction'], ['feeTransaction', 'Fee transaction']].filter(([field]) => /^0x[0-9a-f]{64}$/i.test(item[field] || '')).map(([field, label]) => `<a class="mini-link" href="${liveMarket.explorer}/tx/${item[field]}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`).join('');
    const actions = order ? `<button class="mini-link" data-live-open="${esc(order.id)}">${order.status === 'completed' ? 'View report & receipt' : 'Review same order'}</button>` : '';
    return `<div class="activity-item"><span class="activity-dot">${['completed', 'enabled'].includes(item.kind) ? '✓' : ['approval', 'checking', 'started'].includes(item.kind) ? '◷' : '−'}</span><div>${esc(item.text)}<small>${esc(new Date(item.time).toLocaleString('en-GB'))} · scheduled</small>${amounts}${actions || transactions ? `<div class="order-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${actions}${transactions}</div>` : ''}</div></div>`;
  }).join('')}</div></section>`;
}
