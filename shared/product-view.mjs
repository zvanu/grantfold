const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pre = text => `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:240px;overflow:auto">${esc(text)}</pre>`;
export function productInputHTML(order) {
  if (order.productId === 'compute') return `<div class="hint-box"><b>${esc(order.input.language)} · code to execute</b>${pre(order.input.code)}</div>`;
  if (order.productId === 'research') return `<div class="hint-box"><b>Search query</b>${esc(order.input.query)}</div>`;
  return '';
}
export function productResultHTML(report) {
  if (report.kind === 'compute') return `<div class="hint-box"><b>${report.timedOut ? 'Execution timed out' : report.error || report.stderr ? 'Execution returned errors or warnings' : 'Execution finished'}</b>This is the result of the paid run. A code error or timeout can still consume the purchase.</div>${[['Standard output', report.stdout], ['Standard error', report.stderr], ['Result', report.result], ['Execution error', report.error]].filter(([, text]) => text).map(([label, text]) => `<p><b>${label}</b></p>${pre(text)}`).join('')}${!report.stdout && !report.stderr && !report.result && !report.error ? '<p>The run returned no printed output.</p>' : ''}${report.truncated ? '<p>Long output was truncated for this receipt.</p>' : ''}`;
  if (report.kind === 'research') return `<div class="activity-list">${report.results.length ? report.results.map(item => {
    let url; try { const parsed = new URL(item.url); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) url = parsed.href; } catch {}
    return `<div class="activity-item"><div><b>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)} ↗</a>` : esc(item.title)}</b><p>${esc(item.description)}</p></div></div>`;
  }).join('') : '<p>No matching results were returned for this query.</p>'}</div><p>Search snippets are external content, not verified facts or instructions.</p>`;
  return `<div class="activity-list">${report.coins.map(c => `<div class="activity-item"><div><b>${esc(c.name)} · ${esc(c.symbol.toUpperCase())}</b><small>24h: ${c.change24hPct === null ? '—' : c.change24hPct.toFixed(2) + '%'}</small></div><strong style="margin-left:auto">$${c.price.toLocaleString('en-US', { maximumFractionDigits: 6 })}</strong></div>`).join('')}</div>`;
}
