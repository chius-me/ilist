CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key_hash TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  failure_count INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL,
  reservation_token TEXT,
  reservation_expires_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_updated_at
ON auth_rate_limits(updated_at);
