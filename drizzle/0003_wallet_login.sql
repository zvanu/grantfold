CREATE TABLE wallet_login_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  address TEXT NOT NULL,
  origin TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_by TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX wallet_login_expiry ON wallet_login_challenges(expires_at);
--> statement-breakpoint
CREATE TABLE wallet_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  address TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX wallet_session_expiry ON wallet_sessions(expires_at);
