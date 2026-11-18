import { liveHeld } from '../shared/payment.mjs';

export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export class AccountStore {
  constructor(database) {
    if (!database) throw new AppError(503, 'storage_unavailable', 'Account storage is temporarily unavailable. Please try again.');
    this.db = database.withSession ? database.withSession('first-primary') : database;
  }

  async get(userId) {
    const row = await this.db.prepare('SELECT state_json, revision FROM accounts WHERE user_id = ?').bind(userId).first();
    if (!row) throw new AppError(404, 'account_missing', 'Set up your account first.');
    return { state: JSON.parse(row.state_json), revision: row.revision };
  }

  async initialize(userId, makeState) {
    const existing = await this.db.prepare('SELECT state_json, revision FROM accounts WHERE user_id = ?').bind(userId).first();
    if (existing) return { state: JSON.parse(existing.state_json), revision: existing.revision, imported: false };
    const { state, imported } = makeState();
    const now = Date.now(), key = 'bootstrap-' + crypto.randomUUID();
    await this.db.batch([
      this.db.prepare('INSERT OR IGNORE INTO accounts (user_id, revision, state_json, last_mutation, created_at, updated_at) VALUES (?, 0, ?, ?, ?, ?)').bind(userId, JSON.stringify(state), key, now, now),
      this.db.prepare('INSERT OR IGNORE INTO audit_events (user_id, request_key, revision, kind, details_json, created_at) SELECT user_id, ?, 0, ?, ?, ? FROM accounts WHERE user_id = ? AND last_mutation = ?').bind(key, imported ? 'legacy_import' : 'account_created', JSON.stringify({ mode: 'sandbox', imported }), now, userId, key),
    ]);
    return { ...await this.get(userId), imported };
  }

  async receipt(userId, key, hash) {
    const row = await this.db.prepare('SELECT request_hash, result_json FROM mutation_receipts WHERE user_id = ? AND request_key = ?').bind(userId, key).first();
    if (!row) return null;
    if (row.request_hash !== hash) throw new AppError(409, 'idempotency_conflict', 'This request key was already used for a different action.');
    return JSON.parse(row.result_json);
  }

  async mutate(userId, key, hash, operation) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const prior = await this.receipt(userId, key, hash);
      if (prior) return { ...await this.get(userId), effect: prior, replayed: true };
      const current = await this.get(userId);
      const { state, effect, audit, privateJob } = operation(structuredClone(current.state));
      const serialized = JSON.stringify(state);
      const reservedDeliveryBytes = (state.liveOrders || []).filter(o => liveHeld(o)).length * 10_000;
      if (new TextEncoder().encode(serialized).length + reservedDeliveryBytes > 1_500_000) throw new AppError(422, 'account_capacity', 'This pilot account has reached its storage limit. No new payment was submitted.');
      const revision = current.revision + 1, now = Date.now();
      // A compare-and-swap and its receipt/audit commit as one D1 transaction.
      // The last_mutation condition prevents records from a losing writer.
      await this.db.batch([
        this.db.prepare('UPDATE accounts SET state_json = ?, revision = ?, last_mutation = ?, updated_at = ? WHERE user_id = ? AND revision = ? AND NOT EXISTS (SELECT 1 FROM mutation_receipts WHERE user_id = ? AND request_key = ?)').bind(serialized, revision, key, now, userId, current.revision, userId, key),
        this.db.prepare('INSERT OR IGNORE INTO mutation_receipts (user_id, request_key, request_hash, result_json, created_at) SELECT user_id, ?, ?, ?, ? FROM accounts WHERE user_id = ? AND revision = ? AND last_mutation = ?').bind(key, hash, JSON.stringify(effect), now, userId, revision, key),
        this.db.prepare('INSERT OR IGNORE INTO audit_events (user_id, request_key, revision, kind, card_id, amount_cents, details_json, created_at) SELECT user_id, ?, ?, ?, ?, ?, ?, ? FROM accounts WHERE user_id = ? AND revision = ? AND last_mutation = ?').bind(key, revision, audit.kind, audit.cardId || null, audit.amount ?? null, JSON.stringify(audit), now, userId, revision, key),
        ...(privateJob ? [this.db.prepare('INSERT OR IGNORE INTO live_payment_jobs (user_id, order_id, payload_json, created_at) SELECT user_id, ?, ?, ? FROM accounts WHERE user_id = ? AND revision = ? AND last_mutation = ?').bind(privateJob.orderId, JSON.stringify(privateJob.payload), now, userId, revision, key)] : []),
      ]);
      const result = await this.receipt(userId, key, hash);
      if (result) return { ...await this.get(userId), effect: result, replayed: false };
    }
    throw new AppError(409, 'account_busy', 'Another request is updating your account. Please try again.');
  }

  async paymentJob(userId, orderId) {
    const row = await this.db.prepare('SELECT payload_json, capture_json FROM live_payment_jobs WHERE user_id = ? AND order_id = ?').bind(userId, orderId).first();
    return row ? { payload: JSON.parse(row.payload_json), capture: row.capture_json ? JSON.parse(row.capture_json) : null } : null;
  }

  async capturePayment(userId, orderId, capture) {
    await this.db.prepare('UPDATE live_payment_jobs SET capture_json = ? WHERE user_id = ? AND order_id = ? AND capture_json IS NULL').bind(JSON.stringify(capture), userId, orderId).run();
  }

  async audit(userId, limit = 100) {
    const rows = await this.db.prepare('SELECT request_key, revision, kind, card_id, amount_cents, details_json, created_at FROM audit_events WHERE user_id = ? ORDER BY created_at DESC, revision DESC LIMIT ?').bind(userId, limit).all();
    return rows.results.map(row => ({ id: row.request_key, revision: row.revision, kind: row.kind, cardId: row.card_id, amount: row.amount_cents, details: JSON.parse(row.details_json), time: row.created_at }));
  }
}
