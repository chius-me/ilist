PRAGMA defer_foreign_keys = ON;

CREATE TABLE storage_credentials_0016_backup AS SELECT * FROM storage_credentials;
CREATE TABLE oauth_states_0016_backup AS SELECT * FROM oauth_states;
CREATE TABLE oauth_refresh_leases_0016_backup AS SELECT * FROM oauth_refresh_leases;
CREATE TABLE upload_sessions_0016_backup AS SELECT * FROM upload_sessions;
CREATE TABLE shares_0016_backup AS SELECT * FROM shares;

DROP TABLE shares;
DROP TABLE upload_sessions;
DROP TABLE oauth_refresh_leases;
DROP TABLE oauth_states;
DROP TABLE storage_credentials;

CREATE TABLE mounts_0016_new (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  mount_path TEXT NOT NULL,
  driver_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  root_item_id TEXT,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO mounts_0016_new (
  id, name, mount_path, driver_type, provider, enabled, is_public,
  sort_order, root_item_id, config_json, created_at, updated_at
)
SELECT
  id, name, mount_path, driver_type, provider, enabled, is_public,
  sort_order, root_item_id, config_json, created_at, updated_at
FROM mounts;

DROP TABLE mounts;
ALTER TABLE mounts_0016_new RENAME TO mounts;

CREATE UNIQUE INDEX mounts_mount_path_unique ON mounts(mount_path);
CREATE UNIQUE INDEX mounts_name_normalized_unique ON mounts(LOWER(TRIM(name)));

CREATE TABLE storage_credentials (
  mount_id TEXT PRIMARY KEY NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  mount_id TEXT NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
  verifier_ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX oauth_states_mount_id_index ON oauth_states(mount_id);
CREATE INDEX oauth_states_expires_at_index ON oauth_states(expires_at);

CREATE TABLE oauth_refresh_leases (
  mount_id TEXT PRIMARY KEY NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE upload_sessions (
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
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_operation TEXT CHECK (terminal_operation IN ('complete', 'abort')),
  terminal_owner TEXT,
  terminal_expires_at INTEGER,
  cleanup_attempted_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX upload_sessions_owner_status ON upload_sessions(owner_session_id, status, updated_at);
CREATE INDEX upload_sessions_expiration ON upload_sessions(status, expires_at);
CREATE INDEX upload_sessions_terminal_lease ON upload_sessions(terminal_operation, terminal_expires_at);
CREATE INDEX upload_sessions_cleanup_order ON upload_sessions(status, cleanup_attempted_at, expires_at);

CREATE TABLE shares (
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
CREATE INDEX shares_mount_id ON shares(mount_id);
CREATE INDEX shares_admin_order ON shares(created_at DESC, id DESC);

INSERT INTO storage_credentials SELECT * FROM storage_credentials_0016_backup;
INSERT INTO oauth_states SELECT * FROM oauth_states_0016_backup;
INSERT INTO oauth_refresh_leases SELECT * FROM oauth_refresh_leases_0016_backup;
INSERT INTO upload_sessions SELECT * FROM upload_sessions_0016_backup;
INSERT INTO shares SELECT * FROM shares_0016_backup;

DROP TABLE shares_0016_backup;
DROP TABLE upload_sessions_0016_backup;
DROP TABLE oauth_refresh_leases_0016_backup;
DROP TABLE oauth_states_0016_backup;
DROP TABLE storage_credentials_0016_backup;

PRAGMA defer_foreign_keys = OFF;
