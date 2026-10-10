-- A physical device has separate remote and tunnel credential subjects.
-- Keep existing credentials, services, leases and authorization scopes intact.
CREATE TABLE device_capability_links (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remote_device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  tunnel_device_id TEXT NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(remote_device_id<>tunnel_device_id)
) STRICT;
CREATE INDEX device_capability_links_owner ON device_capability_links(user_id);

CREATE TRIGGER device_capability_link_valid BEFORE INSERT ON device_capability_links
WHEN NOT EXISTS(
  SELECT 1 FROM devices remote JOIN devices tunnel
    ON tunnel.id=NEW.tunnel_device_id
  WHERE remote.id=NEW.remote_device_id
    AND remote.user_id=NEW.user_id AND tunnel.user_id=NEW.user_id
    AND remote.credential_purpose='gui' AND tunnel.credential_purpose='background'
    AND remote.status='active' AND tunnel.status='active'
    AND remote.revoked_at IS NULL AND tunnel.revoked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT,'invalid physical device subjects');
END;
