ALTER TABLE homedesk_bindings ADD COLUMN remote_public_key TEXT NOT NULL DEFAULT '';
CREATE TABLE native_remote_permits (
 id TEXT PRIMARY KEY,
 controller_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 host_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 controller_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 host_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 claims_json TEXT NOT NULL CHECK(json_valid(claims_json)),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','active','closed','revoked')),
 peer_connection_id TEXT,
 controller_seen_at TEXT NOT NULL,
 host_seen_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX native_remote_permits_controller ON native_remote_permits(controller_session_id,state);
CREATE INDEX native_remote_permits_host ON native_remote_permits(host_session_id,state);
CREATE INDEX native_remote_permits_expiry ON native_remote_permits(expires_at);
CREATE TRIGGER native_permit_session_revoked AFTER UPDATE OF revoked_at ON sessions
WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL
BEGIN
 UPDATE native_remote_permits SET state='revoked'
 WHERE (controller_session_id=NEW.id OR host_session_id=NEW.id) AND state IN ('pending','active');
END;
