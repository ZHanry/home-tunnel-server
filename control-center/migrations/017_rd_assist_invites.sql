CREATE TABLE rd_assist_invites (
  id TEXT PRIMARY KEY,
  device_code TEXT NOT NULL CHECK(length(device_code)=9),
  host_owner_user_id TEXT NOT NULL REFERENCES users(id),
  host_endpoint_id TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','redeemed','revoked','expired')),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 5),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  redeemed_at TEXT,
  redeemed_by_user_id TEXT REFERENCES users(id),
  redeemed_by_endpoint_id TEXT REFERENCES rd_endpoints(id),
  revoked_at TEXT,
  FOREIGN KEY(host_owner_user_id,host_endpoint_id) REFERENCES rd_endpoints(owner_user_id,id)
) STRICT;
CREATE UNIQUE INDEX rd_assist_active_host ON rd_assist_invites(host_endpoint_id) WHERE state='active';
CREATE UNIQUE INDEX rd_assist_active_code ON rd_assist_invites(device_code) WHERE state='active';
CREATE INDEX rd_assist_expiry ON rd_assist_invites(expires_at,state);
CREATE TRIGGER rd_assist_host_revoked AFTER UPDATE OF status ON rd_endpoints WHEN NEW.status='revoked'
BEGIN
 UPDATE rd_assist_invites SET state='revoked',revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE host_endpoint_id=NEW.id AND state IN ('active','redeemed');
END;
CREATE TRIGGER rd_assist_host_disabled AFTER UPDATE OF local_enabled ON rd_endpoints WHEN NEW.local_enabled=0 AND OLD.local_enabled<>0
BEGIN
 UPDATE rd_assist_invites SET state='revoked',revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE host_endpoint_id=NEW.id AND state IN ('active','redeemed');
END;
CREATE TRIGGER rd_assist_controller_revoked AFTER UPDATE OF status ON rd_endpoints WHEN NEW.status='revoked'
BEGIN
 UPDATE rd_assist_invites SET state='revoked',revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE redeemed_by_endpoint_id=NEW.id AND state='redeemed';
END;
CREATE TRIGGER rd_assist_user_revoked AFTER UPDATE OF token_version,status,mfa_secret ON users
WHEN NEW.token_version<>OLD.token_version OR NEW.status<>'active' OR (OLD.mfa_secret IS NOT NULL AND NEW.mfa_secret IS NULL)
BEGIN
 UPDATE rd_assist_invites SET state='revoked',revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE (host_owner_user_id=NEW.id OR redeemed_by_user_id=NEW.id) AND state IN ('active','redeemed');
END;
