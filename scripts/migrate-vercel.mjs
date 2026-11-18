import { readFile, readdir } from 'node:fs/promises';
import { productionDatabase } from '../server/libsql.mjs';
if (!process.env.TURSO_DATABASE_URL) { try { process.loadEnvFile('.env.local'); } catch {} }
const db = productionDatabase(process.env);
await db.prepare('CREATE TABLE IF NOT EXISTS grantfold_migrations (name TEXT PRIMARY KEY NOT NULL)').run();
for (const name of (await readdir('drizzle')).filter(v => v.endsWith('.sql')).sort()) {
  if (await db.prepare('SELECT name FROM grantfold_migrations WHERE name = ?').bind(name).first()) continue;
  const statements = (await readFile('drizzle/' + name, 'utf8')).split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean);
  await db.batch([...statements.map(sql => db.prepare(sql)), db.prepare('INSERT INTO grantfold_migrations (name) VALUES (?)').bind(name)]);
  console.log('Applied ' + name);
}
db.client.close();
