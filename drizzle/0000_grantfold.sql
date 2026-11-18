CREATE TABLE accounts (
  user_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  last_mutation TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE mutation_receipts (
  user_id TEXT NOT NULL REFERENCES accounts(user_id),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, request_key)
);
--> statement-breakpoint
CREATE TABLE audit_events (
  user_id TEXT NOT NULL REFERENCES accounts(user_id),
  request_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  card_id TEXT,
  amount_cents INTEGER,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, request_key)
);
--> statement-breakpoint
CREATE INDEX audit_events_by_account_time ON audit_events(user_id, created_at DESC);
