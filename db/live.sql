CREATE TABLE live_payment_jobs (
  user_id TEXT NOT NULL REFERENCES accounts(user_id),
  order_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  capture_json TEXT CHECK (capture_json IS NULL OR json_valid(capture_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, order_id)
);
