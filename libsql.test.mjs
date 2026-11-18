import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { LibsqlDatabase } from './server/libsql.mjs';
import { AccountStore } from './server/store.mjs';
import { initialState } from './shared/core.mjs';
import { applyAction } from './server/domain.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'grantfold-libsql-'));
  const client = createClient({ url: 'file:' + path.join(directory, 'test.sqlite') }), db = new LibsqlDatabase(client);
  t.after(async () => { client.close(); await rm(directory, { recursive: true, force: true }); });
  for (const name of (await readdir('drizzle')).filter(n => n.endsWith('.sql')).sort()) await db.batch((await readFile('drizzle/' + name, 'utf8')).split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  const store = new AccountStore(db); await store.initialize('owner', () => ({ state: initialState(), imported: false }));
  return { client, db, store };
}

test('Turso adapter commits account, receipt and audit atomically and replays once', async t => {
  const f = await fixture(t), key = crypto.randomUUID(), body = { type: 'purchase', cardId: 'card-1', itemId: 'compute' };
  const first = await f.store.mutate('owner', key, 'same', s => applyAction(s, body));
  const replay = await f.store.mutate('owner', key, 'same', s => applyAction(s, body));
  assert.equal(first.effect.orderId, replay.effect.orderId); assert.equal(replay.state.orders.length, 1); assert.equal(replay.replayed, true);
  assert.equal((await f.store.audit('owner')).filter(e => e.kind === 'purchase').length, 1);
});

test('Turso write batches roll back all preceding statements on a constraint failure', async t => {
  const f = await fixture(t), before = await f.store.get('owner');
  await assert.rejects(() => f.db.batch([f.db.prepare('UPDATE accounts SET revision = revision + 1 WHERE user_id = ?').bind('owner'), f.db.prepare('INSERT INTO accounts (user_id) VALUES (?)').bind('invalid')]));
  assert.equal((await f.store.get('owner')).revision, before.revision);
});

test('parallel Turso writers cannot debit the same purchase twice', async t => {
  const f = await fixture(t), key = crypto.randomUUID(), body = { type: 'purchase', cardId: 'card-1', itemId: 'compute' };
  const results = await Promise.all(Array.from({ length: 6 }, () => f.store.mutate('owner', key, 'same', s => applyAction(s, body))));
  assert.equal(new Set(results.map(r => r.effect.orderId)).size, 1); assert.equal((await f.store.get('owner')).state.orders.length, 1);
});
