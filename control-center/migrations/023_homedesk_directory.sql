-- Remote IDs are metadata. Session/media traffic never enters Control Center.
CREATE TABLE homedesk_bindings (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL CHECK(length(remote_id) BETWEEN 1 AND 64),
  server TEXT NOT NULL,
  key_sha256 TEXT NOT NULL CHECK(length(key_sha256)=64),
  platform TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE(server,key_sha256,remote_id)
) STRICT;
CREATE TRIGGER homedesk_device_revoked AFTER UPDATE OF status,revoked_at ON devices
WHEN NEW.status<>'active' OR NEW.revoked_at IS NOT NULL
BEGIN
  DELETE FROM homedesk_bindings WHERE device_id=NEW.id;
END;
