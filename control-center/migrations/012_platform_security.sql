ALTER TABLE sessions ADD COLUMN client_type TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN refresh_retry_until_at TEXT;
ALTER TABLE sessions ADD COLUMN refresh_fingerprint TEXT;

ALTER TABLE users ADD COLUMN mfa_secret TEXT;
ALTER TABLE users ADD COLUMN mfa_pending_secret TEXT;
ALTER TABLE users ADD COLUMN mfa_pending_expires_at TEXT;
ALTER TABLE users ADD COLUMN mfa_last_counter INTEGER NOT NULL DEFAULT -1;

CREATE TABLE mfa_recovery_codes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY(user_id,code_hash)
) STRICT;

CREATE TABLE enrollment_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX enrollment_codes_owner ON enrollment_codes(user_id,expires_at);

ALTER TABLE devices ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE devices ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1));
ALTER TABLE devices ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE maintenance_tasks (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('running','healthy','failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  last_success_at TEXT,
  details TEXT NOT NULL DEFAULT '{}'
) STRICT;
