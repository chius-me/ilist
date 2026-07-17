ALTER TABLE upload_sessions
ADD COLUMN terminal_operation TEXT CHECK (terminal_operation IN ('complete', 'abort'));

ALTER TABLE upload_sessions
ADD COLUMN terminal_owner TEXT;

ALTER TABLE upload_sessions
ADD COLUMN terminal_expires_at INTEGER;

ALTER TABLE upload_sessions
ADD COLUMN cleanup_attempted_at INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS upload_sessions_terminal_lease
ON upload_sessions(terminal_operation, terminal_expires_at);

CREATE INDEX IF NOT EXISTS upload_sessions_cleanup_order
ON upload_sessions(status, cleanup_attempted_at, expires_at);
