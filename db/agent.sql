CREATE TABLE agent_wallets (
  user_id TEXT NOT NULL REFERENCES accounts(user_id),
  card_id TEXT NOT NULL,
  address TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, card_id)
);
--> statement-breakpoint
CREATE TABLE agent_transactions (
  user_id TEXT NOT NULL REFERENCES accounts(user_id),
  job_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  raw_transaction TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, job_id),
  UNIQUE (wallet_address, nonce),
  UNIQUE (transaction_hash)
);
