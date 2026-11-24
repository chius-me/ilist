CREATE INDEX IF NOT EXISTS idx_mounts_enabled_public_sort
  ON mounts (enabled, is_public, sort_order, name);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_owner_status_expires
  ON upload_sessions (owner_session_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_mount_status
  ON upload_sessions (mount_id, status);

CREATE INDEX IF NOT EXISTS idx_shares_enabled_created
  ON shares (enabled, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_updated
  ON auth_rate_limits (updated_at);
