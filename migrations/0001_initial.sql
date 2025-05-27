CREATE TABLE IF NOT EXISTS objects (
  key TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  etag TEXT,
  updated_at TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_objects_public_key ON objects (is_public, key);
CREATE INDEX IF NOT EXISTS idx_objects_sort ON objects (sort_order, name);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
