import { handleApi } from './api.mjs';
import { handleMcp } from './mcp.mjs';

export function createWorker(assets, services = {}) {
  const decoded = new Map();
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return handleApi(request, env, services);
      if (url.pathname === '/mcp') return handleMcp(request, env, services);
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const asset = Object.hasOwn(assets, path) ? assets[path] : null;
      if (!asset) return new Response('Not found', { status: 404 });
      const headers = { 'content-type': asset.type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' };
      if (request.method === 'HEAD') return new Response(null, { headers });
      if (!decoded.has(path)) decoded.set(path, Uint8Array.from(atob(asset.base64), c => c.charCodeAt(0)));
      return new Response(decoded.get(path), { headers });
    },
  };
}
