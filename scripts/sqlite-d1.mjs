import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Development/test adapter. Production uses the native D1 DB binding.
export class LocalD1 {
  constructor(filename = ':memory:') { this.connection = new DatabaseSync(filename); this.connection.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;'); }
  prepare(sql) {
    const database = this;
    return {
      sql, values: [],
      bind(...values) { return { ...this, values }; },
      async first() { return database.connection.prepare(this.sql).get(...this.values) || null; },
      async all() { return { results: database.connection.prepare(this.sql).all(...this.values), success: true }; },
      async run() { const result = database.connection.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
  }
  async batch(statements) {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (let i = 0; i < statements.length; i++) {
        if (this.failStatement === i) { this.failStatement = undefined; throw new Error('Injected transaction failure'); }
        const statement = statements[i], result = this.connection.prepare(statement.sql).run(...statement.values);
        results.push({ success: true, meta: { changes: Number(result.changes) } });
      }
      this.connection.exec('COMMIT'); return results;
    } catch (error) { this.connection.exec('ROLLBACK'); throw error; }
  }
  migrate(directory = fileURLToPath(new URL('../drizzle/', import.meta.url))) {
    this.connection.exec('CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY NOT NULL)');
    if (!existsSync(directory)) throw new Error('Generate SQL migrations first.');
    for (const name of readdirSync(directory).filter(n => n.endsWith('.sql')).sort()) {
      if (this.connection.prepare('SELECT 1 FROM _local_migrations WHERE name = ?').get(name)) continue;
      this.connection.exec('BEGIN IMMEDIATE');
      try { this.connection.exec(readFileSync(path.join(directory, name), 'utf8')); this.connection.prepare('INSERT INTO _local_migrations (name) VALUES (?)').run(name); this.connection.exec('COMMIT'); }
      catch (error) { this.connection.exec('ROLLBACK'); throw error; }
    }
  }
  close() { this.connection.close(); }
}
