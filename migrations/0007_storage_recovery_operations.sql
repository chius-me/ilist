ALTER TABLE entries ADD COLUMN lifecycle_owner TEXT;

CREATE TABLE IF NOT EXISTS storage_recovery_operations (
  id TEXT PRIMARY KEY NOT NULL,
  entry_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('upload_cleanup', 'delete_tree')),
  storage_key TEXT,
  attempt_owner TEXT NOT NULL,
  phase TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL CHECK (state IN ('held', 'pending', 'running', 'retry', 'completed')),
  claim_owner TEXT,
  claim_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS storage_recovery_operations_reconcile
ON storage_recovery_operations(state, updated_at);

CREATE INDEX IF NOT EXISTS storage_recovery_operations_entry
ON storage_recovery_operations(entry_id, operation_kind, state);

CREATE UNIQUE INDEX IF NOT EXISTS storage_recovery_operations_active_entry_kind
ON storage_recovery_operations(entry_id, operation_kind)
WHERE state <> 'completed';
