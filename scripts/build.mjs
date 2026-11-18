import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { informationPages, informationDocument } from '../web/information.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.png': 'image/png' };
export function collectAssets() {
  const assets = {};
  function walk(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name), name = prefix + '/' + entry.name;
      if (entry.isDirectory()) walk(location, name);
      else if (entry.isFile()) assets[name] = { type: mime[path.extname(entry.name)] || 'application/octet-stream', base64: readFileSync(location).toString('base64') };
      else throw new Error('Assets must be regular files.');
    }
  }
  walk(path.join(root, 'web'));
  for (const name of Object.keys(informationPages)) assets['/' + name + '.html'] = { type: mime['.html'], base64: Buffer.from(informationDocument(name)).toString('base64') };
  assets['/core.mjs'] = { type: mime['.mjs'], base64: readFileSync(path.join(root, 'shared/core.mjs')).toString('base64') };
  assets['/live.js'] = { type: mime['.mjs'], base64: readFileSync(path.join(root, 'shared/wallet.mjs')).toString('base64') };
  assets['/wallet-auth.js'] = { type: mime['.mjs'], base64: readFileSync(path.join(root, 'shared/wallet-auth.mjs')).toString('base64') };
  assets['/commission.mjs'] = { type: mime['.mjs'], base64: readFileSync(path.join(root, 'shared/commission.mjs')).toString('base64') };
  assets['/payment.mjs'] = { type: mime['.mjs'], base64: readFileSync(path.join(root, 'shared/payment.mjs')).toString('base64') };
  assets['/schedule.mjs'] = { type: mime['.mjs'], base64: readFileSync(path.join(root, 'shared/schedule.mjs')).toString('base64') };
  assets['/schedule-activity.mjs'] = { type: mime['.mjs'], base64: readFileSync(path.join(root, 'shared/schedule-activity.mjs')).toString('base64') };
  for (const file of ['products.mjs', 'product-view.mjs', 'card-balance.mjs', 'deposit.mjs']) assets['/' + file] = { type: mime['.mjs'], base64: readFileSync(path.join(root, 'shared', file)).toString('base64') };
  return assets;
}

export function build() {
  const config = JSON.parse(readFileSync(path.join(root, '.openai/hosting.json'), 'utf8'));
  if (config.project_id !== 'appgprj_6afc402eb590819197ebd412e7b42c2c' || config.static || config.d1 !== 'DB') throw new Error('Preserve this Site identity and its DB Worker binding.');
  rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  mkdirSync(path.join(root, 'dist/server'), { recursive: true });
  mkdirSync(path.join(root, 'dist/.openai'), { recursive: true });
  buildSync({ stdin: { contents: `import { createWorker } from './server/worker.mjs'; export default createWorker(${JSON.stringify(collectAssets())});`, resolveDir: root, sourcefile: 'grantfold-entry.mjs' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, outfile: path.join(root, 'dist/server/index.js') });
  writeFileSync(path.join(root, 'dist/.openai/hosting.json'), JSON.stringify(config, null, 2) + '\n');
  console.log('Built Grantfold Worker with embedded static assets and DB binding.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) build();
