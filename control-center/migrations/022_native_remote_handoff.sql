-- A native remote window is a device-scoped child, never an account session.
ALTER TABLE sessions ADD COLUMN native_parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
CREATE INDEX sessions_native_parent ON sessions(native_parent_session_id);
CREATE TABLE native_remote_handoffs (
  code_hash TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;
CREATE INDEX native_remote_handoffs_expiry ON native_remote_handoffs(expires_at);
-- Propagate native window close/logout through the existing RD parent triggers,
-- so active sessions close immediately as well as failing subsequent requests.
CREATE TRIGGER native_parent_revoked AFTER UPDATE OF revoked_at ON sessions
WHEN NEW.revoked_at IS NOT NULL
BEGIN
 UPDATE sessions SET revoked_at=COALESCE(revoked_at,NEW.revoked_at)
 WHERE native_parent_session_id=NEW.id AND revoked_at IS NULL;
END;
