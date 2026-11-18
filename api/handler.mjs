import { productionDatabase } from '../server/libsql.mjs';
import { handleApi } from '../server/api.mjs';

export function createNodeHandler(options = {}) {
  let database = options.db;
  return async function handler(req, res) {
    try {
      const configuration = options.env || process.env;
      const origins = [configuration.GRANTFOLD_SITE_ORIGIN, configuration.GRANTFOLD_VERCEL_ORIGIN, configuration.VERCEL_PROJECT_PRODUCTION_URL && 'https://' + configuration.VERCEL_PROJECT_PRODUCTION_URL, configuration.VERCEL_URL && 'https://' + configuration.VERCEL_URL].filter(Boolean).map(v => new URL(v).origin);
      const host = req.headers.host;
      const origin = origins.find(v => new URL(v).host === host);
      if (!origin) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'host_refused', message: 'Use the configured Grantfold site address.' } })); return; }
      const url = new URL(req.url, origin);
      if (url.origin !== origin || !url.pathname.startsWith('/api/')) { res.writeHead(404); res.end(); return; }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (!key.toLowerCase().startsWith('oai-authenticated-') && value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const chunks = []; let size = 0;
      if (!['GET', 'HEAD'].includes(req.method)) for await (const chunk of req) { size += chunk.length; if (size > 1000000) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
      const request = new Request(url, { method: req.method, headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
      database ||= productionDatabase(configuration);
      const response = await handleApi(request, { ...configuration, AUTH_MODE: 'wallet', DB: database }, options.services || {});
      for (const [key, value] of response.headers) if (key !== 'set-cookie') res.setHeader(key, value);
      const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('set-cookie', cookies);
      res.statusCode = response.status; res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { code: 'service_unavailable', message: 'Grantfold is temporarily unavailable. Reload to check your saved order before retrying.' } }));
    }
  };
}
export default createNodeHandler();
