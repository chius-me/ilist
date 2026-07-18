CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  mount_id TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('file', 'folder')),
  name TEXT NOT NULL,
  password_hash TEXT,
  expires_at INTEGER,
  allow_download INTEGER NOT NULL DEFAULT 1 CHECK (allow_download IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (mount_id) REFERENCES mounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS shares_mount_id
ON shares(mount_id);

CREATE INDEX IF NOT EXISTS shares_admin_order
ON shares(created_at DESC, id DESC);
