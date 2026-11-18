import { AppError } from './store.mjs';
import { liveProducts } from '../shared/products.mjs';

const requireValue = (value, message) => { if (!value) throw new AppError(422, 'product_invalid', message); };
export function productRequest(productId = 'market', input = {}) {
  const product = Object.hasOwn(liveProducts, productId) ? liveProducts[productId] : null;
  requireValue(product && input && typeof input === 'object' && !Array.isArray(input), 'Choose a supported live service and its inputs.');
  const allowed = productId === 'compute' ? ['language', 'code'] : productId === 'research' ? ['query'] : [];
  requireValue(Object.keys(input).every(key => allowed.includes(key)), 'This service request contains unsupported fields.');
  let normalized = {};
  if (productId === 'compute') {
    requireValue(['python', 'javascript'].includes(input.language) && typeof input.code === 'string' && input.code.trim().length > 0 && input.code.length <= 10000 && new TextEncoder().encode(input.code).length <= 24000, 'Use Python or JavaScript and up to 10,000 characters of code (24 KB).');
    normalized = { language: input.language, code: input.code };
  } else if (productId === 'research') {
    requireValue(typeof input.query === 'string' && input.query.trim().length > 0 && input.query.trim().length <= 400, 'Enter a search query of 1–400 characters.');
    normalized = { query: input.query.trim() };
  }
  const url = new URL(product.path, 'https://agent402.tools');
  if (productId === 'research') { url.searchParams.set('q', normalized.query); url.searchParams.set('count', '5'); }
  return { product, input: normalized, url: url.href, ...(productId === 'compute' ? { body: JSON.stringify(normalized) } : {}) };
}

const clipped = (value, bytes) => {
  const encoded = new TextEncoder().encode(String(value));
  return encoded.length <= bytes ? String(value) : new TextDecoder().decode(encoded.slice(0, bytes), { stream: true }) + '…';
};
export function safeSourceUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 700 ? url.href : null; } catch { return null; }
}
export function normalizeToolReport(productId, data) {
  if (productId === 'compute') {
    requireValue(data && ['python', 'javascript'].includes(data.language) && typeof data.stdout === 'string' && typeof data.stderr === 'string', 'The provider did not return the expected execution result.');
    const value = data.result == null ? '' : typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    const error = data.error == null ? '' : typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    const report = { kind: 'compute', language: data.language, stdout: clipped(data.stdout, 3000), stderr: clipped(data.stderr, 1000), result: clipped(value, 1500), error: clipped(error, 500), timedOut: data.timedOut === true, credit: 'Executed by Agent402 in its cloud sandbox.' };
    report.truncated = report.stdout !== data.stdout || report.stderr !== data.stderr || report.result !== value || report.error !== error;
    return report;
  }
  requireValue(productId === 'research' && data && typeof data.query === 'string' && Array.isArray(data.results) && data.results.length <= 20, 'The provider did not return the expected search results.');
  const results = data.results.slice(0, 5).map(item => {
    const url = safeSourceUrl(item?.url); requireValue(url && typeof item.title === 'string' && typeof item.description === 'string', 'The provider returned an invalid search result.');
    return { title: clipped(item.title, 180), url, description: clipped(item.description, 500) };
  });
  return { kind: 'research', query: clipped(data.query, 500), results, untrustedContent: true, credit: 'Live web search supplied by Agent402. Source pages and snippets are external content.' };
}
