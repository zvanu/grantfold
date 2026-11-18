import { mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { collectAssets } from './build.mjs';

const output = '.vercel/output';
rmSync(output, { recursive: true, force: true });
for (const [name, asset] of Object.entries(collectAssets())) {
  const file = path.join(output, 'static', name);
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(asset.base64, 'base64'));
}
const directory = path.join(output, 'functions/api/index.func');
mkdirSync(directory, { recursive: true });
buildSync({ entryPoints: ['api/handler.mjs'], outfile: path.join(directory, 'index.mjs'), bundle: true, platform: 'node', target: 'node24', format: 'esm', minify: true, banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
writeFileSync(path.join(directory, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs24.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 60 }));
const cronDirectory = path.join(output, 'functions/cron/index.func');
mkdirSync(cronDirectory, { recursive: true });
copyFileSync(path.join(directory, 'index.mjs'), path.join(cronDirectory, 'index.mjs'));
writeFileSync(path.join(cronDirectory, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs24.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 300 }));
const crons = Array.from({ length: 24 }, (_, hour) => ({ path: '/api/cron/schedules/' + String(hour).padStart(2, '0'), schedule: '0 ' + hour + ' * * *' }));
const redirects = [];
if (process.env.GRANTFOLD_SITE_ORIGIN) {
  const canonical = new URL(process.env.GRANTFOLD_SITE_ORIGIN);
  if (canonical.protocol !== 'https:' || canonical.hostname.startsWith('www.')) throw Error('Use the HTTPS apex domain as the canonical production origin.');
  redirects.push({ src: '/(.*)', has: [{ type: 'host', value: 'www.' + canonical.hostname }], status: 308, headers: { Location: canonical.origin + '/$1' } });
}
writeFileSync(path.join(output, 'config.json'), JSON.stringify({ version: 3, crons, routes: [...redirects, { src: '/api/cron/schedules/([01]\\d|2[0-3])', dest: '/cron/index' }, { src: '/api/(.*)', dest: '/api/index' }, { src: '/(terms|privacy|support)/?', dest: '/$1.html' }, { handle: 'filesystem' }, { src: '/(.*)', status: 404 }] }, null, 2));
console.log('Built Vercel static site and wallet-authenticated Node function.');
