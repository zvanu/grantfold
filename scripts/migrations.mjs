import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const sql = readFileSync(path.join(root, 'db/schema.sql'), 'utf8');
const destination = path.join(root, 'drizzle/0000_grantfold.sql');
mkdirSync(path.join(root, 'drizzle/meta'), { recursive: true });
if (existsSync(destination) && readFileSync(destination, 'utf8') !== sql) {
  throw new Error('Existing migrations are immutable. Add a new SQL migration and journal entry for later schema changes.');
}
writeFileSync(destination, sql);
const journal = path.join(root, 'drizzle/meta/_journal.json');
if (!existsSync(journal)) writeFileSync(journal, JSON.stringify({ version: '7', dialect: 'sqlite', entries: [{ idx: 0, version: '6', when: 1794916800000, tag: '0000_grantfold', breakpoints: true }] }, null, 2) + '\n');
console.log('Grantfold schema migration ready. No data was seeded.');
