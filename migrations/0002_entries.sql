PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY NOT NULL,
  parent_id TEXT REFERENCES entries(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  storage_key TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  etag TEXT,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'ready', 'deleting')),
  is_public INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind = 'file' AND storage_key IS NOT NULL) OR
    (kind = 'folder' AND storage_key IS NULL)
  ),
  UNIQUE (parent_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS entries_storage_key_unique
ON entries(storage_key)
WHERE storage_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS entries_parent_order
ON entries(parent_id, sort_order, name);

INSERT OR IGNORE INTO entries (
  id, parent_id, name, kind, storage_key, size, content_type, etag,
  status, is_public, sort_order, description, created_at, updated_at
) VALUES (
  'root', NULL, '', 'folder', NULL, 0, NULL, NULL,
  'ready', 1, 0, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
