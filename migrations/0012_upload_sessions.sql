CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  owner_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  mount_id TEXT NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
  parent_item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  content_type TEXT,
  part_size INTEGER NOT NULL CHECK (part_size > 0),
  provider_state_ciphertext TEXT NOT NULL,
  parts_json TEXT NOT NULL DEFAULT '[]',
  completed_item_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'completing', 'completed', 'aborted')),
  active_part_number INTEGER,
  active_part_expires_at INTEGER,
  completion_owner TEXT,
  completion_expires_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS upload_sessions_owner_status
ON upload_sessions(owner_session_id, status, updated_at);

CREATE INDEX IF NOT EXISTS upload_sessions_expiration
ON upload_sessions(status, expires_at);
