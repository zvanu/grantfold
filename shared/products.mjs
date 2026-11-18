export const liveProducts = Object.freeze({
  market: Object.freeze({ id: 'market', name: 'Crypto market overview', category: 'Market data', path: '/api/crypto-market', method: 'GET', description: 'Current prices, market caps and 24-hour changes for the top 10 coins.' }),
  compute: Object.freeze({ id: 'compute', name: 'Cloud code execution', category: 'AI & compute', path: '/api/code-run', method: 'POST', description: 'One Python or JavaScript execution in Agent402’s cloud sandbox. Up to 30 seconds; errors and timed-out runs can still be charged. This is not prepaid compute credit.' }),
  research: Object.freeze({ id: 'research', name: 'Live web search', category: 'Market data', path: '/api/search', method: 'GET', description: 'One live web search with up to five source links and snippets. This is not an AI-written research report.' }),
});
export const productOf = order => Object.hasOwn(liveProducts, order?.productId || 'market') ? liveProducts[order?.productId || 'market'] : null;
