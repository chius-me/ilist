CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  mount_id TEXT NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
  verifier_ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_states_mount_id_index ON oauth_states(mount_id);
CREATE INDEX IF NOT EXISTS oauth_states_expires_at_index ON oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS oauth_refresh_leases (
  mount_id TEXT PRIMARY KEY NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
