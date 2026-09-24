ALTER TABLE rd_assist_invites ADD COLUMN access_kind TEXT NOT NULL DEFAULT 'temporary_password'
  CHECK(access_kind IN ('temporary_password','fixed_password','approved_request'));
ALTER TABLE rd_assist_invites ADD COLUMN profile_revision INTEGER;

CREATE TABLE rd_access_profiles (
  host_endpoint_id TEXT PRIMARY KEY REFERENCES rd_endpoints(id),
  host_owner_user_id TEXT NOT NULL REFERENCES users(id),
  device_code TEXT NOT NULL UNIQUE CHECK(length(device_code)=9),
  password_hash TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 5),
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(host_owner_user_id,host_endpoint_id) REFERENCES rd_endpoints(owner_user_id,id)
) STRICT;

CREATE TABLE rd_access_requests (
  id TEXT PRIMARY KEY,
  host_endpoint_id TEXT NOT NULL REFERENCES rd_access_profiles(host_endpoint_id),
  host_owner_user_id TEXT NOT NULL REFERENCES users(id),
  controller_endpoint_id TEXT NOT NULL REFERENCES rd_endpoints(id),
  controller_owner_user_id TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','preparing','approved','rejected','expired')),
  invite_id TEXT UNIQUE REFERENCES rd_assist_invites(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY(host_owner_user_id,host_endpoint_id) REFERENCES rd_endpoints(owner_user_id,id),
  FOREIGN KEY(controller_owner_user_id,controller_endpoint_id) REFERENCES rd_endpoints(owner_user_id,id)
) STRICT;
CREATE INDEX rd_access_requests_host ON rd_access_requests(host_endpoint_id,state,expires_at);
CREATE INDEX rd_access_requests_controller ON rd_access_requests(controller_endpoint_id,created_at);

CREATE TRIGGER rd_access_host_revoked AFTER UPDATE OF status ON rd_endpoints WHEN NEW.status='revoked'
BEGIN
 UPDATE rd_access_profiles SET password_hash=NULL,revision=revision+1 WHERE host_endpoint_id=NEW.id;
 UPDATE rd_access_requests SET state='rejected',decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE host_endpoint_id=NEW.id AND state IN ('pending','preparing');
END;
CREATE TRIGGER rd_access_host_disabled AFTER UPDATE OF local_enabled ON rd_endpoints WHEN NEW.local_enabled=0 AND OLD.local_enabled<>0
BEGIN
 UPDATE rd_access_requests SET state='rejected',decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE host_endpoint_id=NEW.id AND state IN ('pending','preparing');
END;
CREATE TRIGGER rd_access_controller_revoked AFTER UPDATE OF status ON rd_endpoints WHEN NEW.status='revoked'
BEGIN
 UPDATE rd_access_requests SET state='rejected',decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE controller_endpoint_id=NEW.id AND state IN ('pending','preparing');
END;
CREATE TRIGGER rd_access_user_revoked AFTER UPDATE OF token_version,status,mfa_secret ON users
WHEN NEW.token_version<>OLD.token_version OR NEW.status<>'active' OR (OLD.mfa_secret IS NOT NULL AND NEW.mfa_secret IS NULL)
BEGIN
 UPDATE rd_access_profiles SET password_hash=NULL,revision=revision+1 WHERE host_owner_user_id=NEW.id;
 UPDATE rd_access_requests SET state='rejected',decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE (host_owner_user_id=NEW.id OR controller_owner_user_id=NEW.id) AND state IN ('pending','preparing');
END;
