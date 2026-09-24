DROP TRIGGER rd_user_revoked;
DROP TRIGGER rd_parent_revoked;
DROP TRIGGER rd_parent_deleted;
DROP TRIGGER rd_endpoint_revoked;

CREATE TABLE rd_pairings_next (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, controller_owner_user_id TEXT NOT NULL,
  host_endpoint_id TEXT NOT NULL, controller_endpoint_id TEXT NOT NULL,
  assist_invite_id TEXT REFERENCES rd_assist_invites(id),
  session_request_id TEXT NOT NULL, requested_scope_json TEXT NOT NULL CHECK(json_valid(requested_scope_json)),
  transcript_json TEXT NOT NULL CHECK(json_valid(transcript_json)), state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','confirmed','rejected','expired')),
  host_proof TEXT, controller_proof TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(owner_user_id,host_endpoint_id) REFERENCES rd_endpoints(owner_user_id,id),
  FOREIGN KEY(controller_owner_user_id,controller_endpoint_id) REFERENCES rd_endpoints(owner_user_id,id),
  CHECK(controller_owner_user_id=owner_user_id OR assist_invite_id IS NOT NULL)
) STRICT;
INSERT INTO rd_pairings_next(id,owner_user_id,controller_owner_user_id,host_endpoint_id,controller_endpoint_id,session_request_id,requested_scope_json,transcript_json,state,host_proof,controller_proof,expires_at,created_at)
SELECT id,owner_user_id,owner_user_id,host_endpoint_id,controller_endpoint_id,session_request_id,requested_scope_json,transcript_json,state,host_proof,controller_proof,expires_at,created_at FROM rd_pairings;

CREATE TABLE rd_grants_next (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, controller_owner_user_id TEXT NOT NULL,
  host_endpoint_id TEXT NOT NULL, controller_endpoint_id TEXT NOT NULL,
  assist_invite_id TEXT REFERENCES rd_assist_invites(id),
  host_jkt TEXT NOT NULL, controller_jkt TEXT NOT NULL, scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  mode TEXT NOT NULL CHECK(mode IN ('one_session','persistent')), one_session_request_id TEXT,
  grant_version INTEGER NOT NULL CHECK(grant_version>0), host_signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','expired')),
  expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT,
  FOREIGN KEY(owner_user_id,host_endpoint_id) REFERENCES rd_endpoints(owner_user_id,id),
  FOREIGN KEY(controller_owner_user_id,controller_endpoint_id) REFERENCES rd_endpoints(owner_user_id,id),
  CHECK(mode='persistent' OR one_session_request_id IS NOT NULL),
  CHECK(controller_owner_user_id=owner_user_id OR assist_invite_id IS NOT NULL),
  CHECK(assist_invite_id IS NULL OR mode='one_session')
) STRICT;
INSERT INTO rd_grants_next(id,owner_user_id,controller_owner_user_id,host_endpoint_id,controller_endpoint_id,host_jkt,controller_jkt,scope_json,mode,one_session_request_id,grant_version,host_signature,status,expires_at,created_at,updated_at,revoked_at)
SELECT id,owner_user_id,owner_user_id,host_endpoint_id,controller_endpoint_id,host_jkt,controller_jkt,scope_json,mode,one_session_request_id,grant_version,host_signature,status,expires_at,created_at,updated_at,revoked_at FROM rd_grants;

CREATE TABLE rd_sessions_next (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, controller_owner_user_id TEXT NOT NULL,
  host_endpoint_id TEXT NOT NULL, controller_endpoint_id TEXT NOT NULL,
  assist_invite_id TEXT REFERENCES rd_assist_invites(id),
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
  session_request_id TEXT NOT NULL DEFAULT '', network_reconnect_count INTEGER NOT NULL DEFAULT 0
    CHECK(network_reconnect_count BETWEEN 0 AND 3),
  FOREIGN KEY(owner_user_id,host_endpoint_id) REFERENCES rd_endpoints(owner_user_id,id),
  FOREIGN KEY(controller_owner_user_id,controller_endpoint_id) REFERENCES rd_endpoints(owner_user_id,id),
  CHECK(host_endpoint_id<>controller_endpoint_id),
  CHECK(controller_owner_user_id=owner_user_id OR assist_invite_id IS NOT NULL)
) STRICT;
INSERT INTO rd_sessions_next(id,owner_user_id,controller_owner_user_id,host_endpoint_id,controller_endpoint_id,controller_parent_session_id,user_token_version,grant_id,grant_version,permissions_json,display_id,state,state_version,connection_epoch,ticket_jti,ticket_expires_at,ticket_jws,lease_seq,lease_issued_at,lease_expires_at,lease_jws,restore_epoch,approval_expires_at,close_reason,host_close_ack,host_ready,controller_ready,created_at,updated_at,closed_at,session_request_id,network_reconnect_count)
SELECT id,owner_user_id,owner_user_id,host_endpoint_id,controller_endpoint_id,controller_parent_session_id,user_token_version,grant_id,grant_version,permissions_json,display_id,state,state_version,connection_epoch,ticket_jti,ticket_expires_at,ticket_jws,lease_seq,lease_issued_at,lease_expires_at,lease_jws,restore_epoch,approval_expires_at,close_reason,host_close_ack,host_ready,controller_ready,created_at,updated_at,closed_at,session_request_id,network_reconnect_count FROM rd_sessions;

DROP TABLE rd_sessions;
DROP TABLE rd_grants;
DROP TABLE rd_pairings;
ALTER TABLE rd_pairings_next RENAME TO rd_pairings;
ALTER TABLE rd_grants_next RENAME TO rd_grants;
ALTER TABLE rd_sessions_next RENAME TO rd_sessions;
CREATE UNIQUE INDEX rd_assist_one_pairing ON rd_pairings(assist_invite_id) WHERE assist_invite_id IS NOT NULL;
CREATE INDEX rd_grant_participants ON rd_grants(host_endpoint_id,controller_endpoint_id,status);
CREATE INDEX rd_sessions_owner_state ON rd_sessions(owner_user_id,state,id);
CREATE INDEX rd_sessions_controller_owner_state ON rd_sessions(controller_owner_user_id,state,id);
CREATE INDEX rd_sessions_lease ON rd_sessions(lease_expires_at);

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
CREATE TRIGGER rd_endpoint_revoked AFTER UPDATE OF status ON rd_endpoints WHEN NEW.status='revoked'
BEGIN
 UPDATE rd_tokens SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE endpoint_id=NEW.id;
 UPDATE rd_grants SET status='revoked',grant_version=grant_version+1,revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE (host_endpoint_id=NEW.id OR controller_endpoint_id=NEW.id) AND status='active';
 UPDATE rd_sessions SET state='closing',close_reason='RD_ENDPOINT_REVOKED',state_version=state_version+1 WHERE (host_endpoint_id=NEW.id OR controller_endpoint_id=NEW.id) AND state NOT IN ('closed','expired','failed','closing');
END;

CREATE TRIGGER rd_assist_invite_revoked AFTER UPDATE OF state ON rd_assist_invites
WHEN NEW.state='revoked' AND OLD.state<>'revoked'
BEGIN
 UPDATE rd_pairings SET state='rejected',host_proof=NULL,controller_proof=NULL WHERE assist_invite_id=NEW.id AND state='pending';
 UPDATE rd_grants SET status='revoked',grant_version=grant_version+1,revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE assist_invite_id=NEW.id AND status='active';
 UPDATE rd_sessions SET state='closing',close_reason='RD_INVITE_REVOKED',state_version=state_version+1 WHERE assist_invite_id=NEW.id AND state NOT IN ('closed','expired','failed','closing');
END;
CREATE TRIGGER rd_cross_account_user_revoked AFTER UPDATE OF token_version,status,mfa_secret ON users
WHEN NEW.token_version<>OLD.token_version OR NEW.status<>'active' OR (OLD.mfa_secret IS NOT NULL AND NEW.mfa_secret IS NULL)
BEGIN
 UPDATE rd_sessions SET state='closing',close_reason='RD_AUTH_REVOKED',state_version=state_version+1
 WHERE controller_owner_user_id=NEW.id AND state NOT IN ('closed','expired','failed','closing');
END;
