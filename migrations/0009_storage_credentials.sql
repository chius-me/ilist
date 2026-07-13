CREATE TABLE IF NOT EXISTS storage_credentials (
  mount_id TEXT PRIMARY KEY NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
