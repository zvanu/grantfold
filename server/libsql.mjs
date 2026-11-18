import { createClient } from '@libsql/client/web';

export class LibsqlDatabase {
  constructor(client) { this.client = client; }
  prepare(sql) {
    const database = this;
    return {
      sql, values: [],
      bind(...values) { return { ...this, values }; },
      async first() { const r = await database.client.execute({ sql: this.sql, args: this.values }); return r.rows[0] || null; },
      async all() { const r = await database.client.execute({ sql: this.sql, args: this.values }); return { results: r.rows, success: true }; },
      async run() { const r = await database.client.execute({ sql: this.sql, args: this.values }); return { success: true, meta: { changes: r.rowsAffected } }; },
    };
  }
  async batch(statements) {
    const results = await this.client.batch(statements.map(s => ({ sql: s.sql, args: s.values })), 'write');
    return results.map(r => ({ success: true, meta: { changes: r.rowsAffected } }));
  }
}
export function productionDatabase(env) {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) throw Error('Database is not configured.');
  return new LibsqlDatabase(createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN, intMode: 'number' }));
}
