-- RD identities and authorization are deliberately separate from tunnel credentials.
ALTER TABLE sessions ADD COLUMN rd_verified_at TEXT;
CREATE TABLE rd_server_state (
  id INTEGER PRIMARY KEY CHECK(id=1), server_instance_id TEXT NOT NULL UNIQUE,
  restore_epoch INTEGER NOT NULL DEFAULT 1 CHECK(restore_epoch>0),
  keyset_version INTEGER NOT NULL DEFAULT 1 CHECK(keyset_version>0)
) STRICT;
CREATE TABLE rd_endpoints (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id),
  linked_device_id TEXT REFERENCES devices(id), kind TEXT NOT NULL CHECK(kind IN ('desktop','android','browser')),
  role TEXT NOT NULL CHECK(role IN ('host','controller','both')),
  name TEXT NOT NULL, platform TEXT NOT NULL, public_jwk TEXT NOT NULL CHECK(json_valid(public_jwk)),
  jkt TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  local_enabled INTEGER NOT NULL DEFAULT 0 CHECK(local_enabled IN (0,1)),
  capability_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(capability_json)),
  capability_version INTEGER NOT NULL DEFAULT 0, metadata_version INTEGER NOT NULL DEFAULT 1,
  presence_generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT,
  UNIQUE(owner_user_id,id), CHECK(kind='desktop' OR role='controller'),
  CHECK(role='controller' OR linked_device_id IS NOT NULL)
) STRICT;
CREATE INDEX rd_endpoint_owner ON rd_endpoints(owner_user_id,status,id);
CREATE TABLE rd_tokens (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, endpoint_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('host_online','controller_refresh')),
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  parent_token_version INTEGER NOT NULL, jkt TEXT NOT NULL, nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT,
  FOREIGN KEY(owner_user_id,endpoint_id) REFERENCES rd_endpoints(owner_user_id,id)
) STRICT;
CREATE INDEX rd_tokens_expiry ON rd_tokens(expires_at);
CREATE TABLE rd_challenges (
  id TEXT PRIMARY KEY, endpoint_id TEXT REFERENCES rd_endpoints(id), owner_user_id TEXT REFERENCES users(id),
  purpose TEXT NOT NULL, context_json TEXT NOT NULL CHECK(json_valid(context_json)),
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, consumed_at TEXT
) STRICT;
CREATE INDEX rd_challenge_expiry ON rd_challenges(expires_at);
CREATE TABLE rd_pairings (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, host_endpoint_id TEXT NOT NULL, controller_endpoint_id TEXT NOT NULL,
  session_request_id TEXT NOT NULL, requested_scope_json TEXT NOT NULL CHECK(json_valid(requested_scope_json)),
  transcript_json TEXT NOT NULL CHECK(json_valid(transcript_json)), state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','confirmed','rejected','expired')),
  host_proof TEXT, controller_proof TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(owner_user_id,host_endpoint_id) REFERENCES rd_endpoints(owner_user_id,id),
  FOREIGN KEY(owner_user_id,controller_endpoint_id) REFERENCES rd_endpoints(owner_user_id,id)
) STRICT;
CREATE TABLE rd_grants (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, host_endpoint_id TEXT NOT NULL, controller_endpoint_id TEXT NOT NULL,
  host_jkt TEXT NOT NULL, controller_jkt TEXT NOT NULL, scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  mode TEXT NOT NULL CHECK(mode IN ('one_session','persistent')), one_session_request_id TEXT,
  grant_version INTEGER NOT NULL CHECK(grant_version>0), host_signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','expired')),
  expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT,
  FOREIGN KEY(owner_user_id,host_endpoint_id) REFERENCES rd_endpoints(owner_user_id,id),
  FOREIGN KEY(owner_user_id,controller_endpoint_id) REFERENCES rd_endpoints(owner_user_id,id),
  CHECK(mode='persistent' OR one_session_request_id IS NOT NULL)
) STRICT;
CREATE INDEX rd_grant_participants ON rd_grants(host_endpoint_id,controller_endpoint_id,status);
CREATE TABLE rd_sessions (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, host_endpoint_id TEXT NOT NULL, controller_endpoint_id TEXT NOT NULL,
  controller_parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  user_token_version INTEGER NOT NULL, grant_id TEXT NOT NULL REFERENCES rd_grants(id), grant_version INTEGER NOT NULL,
  permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)), display_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending_approval','authorized','connecting','active','reconnecting','closing','closed','failed','expired')),
  state_version INTEGER NOT NULL DEFAULT 1, connection_epoch INTEGER NOT NULL DEFAULT 1,
  ticket_jti TEXT, ticket_expires_at TEXT, ticket_jws TEXT, lease_seq INTEGER NOT NULL DEFAULT 0,
  lease_issued_at TEXT, lease_expires_at TEXT, lease_jws TEXT, restore_epoch INTEGER NOT NULL,
  approval_expires_at TEXT NOT NULL, close_reason TEXT, host_close_ack TEXT,
  host_ready INTEGER NOT NULL DEFAULT 0, controller_ready INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT,
  FOREIGN KEY(owner_user_id,host_endpoint_id) REFERENCES rd_endpoints(owner_user_id,id),
  FOREIGN KEY(owner_user_id,controller_endpoint_id) REFERENCES rd_endpoints(owner_user_id,id),
  CHECK(host_endpoint_id<>controller_endpoint_id)
) STRICT;
CREATE INDEX rd_sessions_owner_state ON rd_sessions(owner_user_id,state,id);
CREATE INDEX rd_sessions_lease ON rd_sessions(lease_expires_at);
CREATE TABLE rd_session_slots (
  endpoint_id TEXT NOT NULL REFERENCES rd_endpoints(id), session_id TEXT NOT NULL REFERENCES rd_sessions(id),
  role TEXT NOT NULL CHECK(role IN ('host','controller')), hold_until TEXT NOT NULL,
  PRIMARY KEY(endpoint_id,session_id,role), UNIQUE(session_id,role)
) STRICT;
CREATE UNIQUE INDEX rd_one_host_session ON rd_session_slots(endpoint_id) WHERE role='host';
CREATE TABLE rd_idempotency (
  actor_endpoint_id TEXT NOT NULL REFERENCES rd_endpoints(id), operation TEXT NOT NULL, key TEXT NOT NULL,
  request_hash TEXT NOT NULL, result_status INTEGER NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  expires_at TEXT NOT NULL, PRIMARY KEY(actor_endpoint_id,operation,key)
) STRICT;
CREATE TABLE rd_usage_daily (
  owner_user_id TEXT NOT NULL REFERENCES users(id), date_utc TEXT NOT NULL,
  business_in_bytes INTEGER NOT NULL DEFAULT 0, business_out_bytes INTEGER NOT NULL DEFAULT 0,
  reserved_bytes INTEGER NOT NULL DEFAULT 0, connection_attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(owner_user_id,date_utc)
) STRICT;
CREATE TABLE rd_policy (
  scope_type TEXT NOT NULL CHECK(scope_type IN ('global','user')), scope_id TEXT NOT NULL,
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json)), version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL, PRIMARY KEY(scope_type,scope_id)
) STRICT;
CREATE TABLE rd_audit (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL,
  resource_id TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE INDEX rd_audit_owner_time ON rd_audit(owner_user_id,created_at,id);
-- Existing account/security flows invalidate RD in the same committing transaction.
CREATE TRIGGER rd_user_revoked AFTER UPDATE OF token_version,status,mfa_secret ON users
WHEN NEW.token_version<>OLD.token_version OR NEW.status<>'active' OR (OLD.mfa_secret IS NOT NULL AND NEW.mfa_secret IS NULL)
BEGIN
 UPDATE rd_tokens SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE owner_user_id=NEW.id;
 UPDATE rd_sessions SET state='closing',close_reason='RD_AUTH_REVOKED',state_version=state_version+1
 WHERE owner_user_id=NEW.id AND state NOT IN ('closed','expired','failed','closing');
END;
CREATE TRIGGER rd_parent_revoked AFTER UPDATE OF revoked_at ON sessions WHEN NEW.revoked_at IS NOT NULL
BEGIN
 UPDATE rd_tokens SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE parent_session_id=NEW.id;
 UPDATE rd_sessions SET state='closing',close_reason='RD_AUTH_REVOKED',state_version=state_version+1
 WHERE controller_parent_session_id=NEW.id AND state NOT IN ('closed','expired','failed','closing');
END;
CREATE TRIGGER rd_parent_deleted BEFORE DELETE ON sessions BEGIN
 UPDATE rd_tokens SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE parent_session_id=OLD.id;
 UPDATE rd_sessions SET state='closing',close_reason='RD_AUTH_REVOKED',state_version=state_version+1
 WHERE controller_parent_session_id=OLD.id AND state NOT IN ('closed','expired','failed','closing');
END;
CREATE TRIGGER rd_device_revoked AFTER UPDATE OF status,revoked_at ON devices WHEN NEW.status='revoked' OR NEW.revoked_at IS NOT NULL
BEGIN
 UPDATE rd_endpoints SET status='revoked',local_enabled=0,revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE linked_device_id=NEW.id;
END;
CREATE TRIGGER rd_endpoint_revoked AFTER UPDATE OF status ON rd_endpoints WHEN NEW.status='revoked'
BEGIN
 UPDATE rd_tokens SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE endpoint_id=NEW.id;
 UPDATE rd_grants SET status='revoked',grant_version=grant_version+1,revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE (host_endpoint_id=NEW.id OR controller_endpoint_id=NEW.id) AND status='active';
 UPDATE rd_sessions SET state='closing',close_reason='RD_ENDPOINT_REVOKED',state_version=state_version+1 WHERE (host_endpoint_id=NEW.id OR controller_endpoint_id=NEW.id) AND state NOT IN ('closed','expired','failed','closing');
END;
