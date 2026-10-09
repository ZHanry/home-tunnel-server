-- 12.0 authentication upgrade. Executed atomically by the migration runner.
-- Only management sessions expire; independent device credentials and leases retain their identities.
PRAGMA secure_delete=ON;
UPDATE sessions SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE device_id IS NULL OR client_type='native_remote';
DROP TRIGGER IF EXISTS rd_user_revoked;
DROP TRIGGER IF EXISTS rd_assist_user_revoked;
DROP TRIGGER IF EXISTS rd_cross_account_user_revoked;
DROP TRIGGER IF EXISTS rd_access_user_revoked;
DROP TABLE mfa_recovery_codes;
DROP TABLE enrollment_codes;
ALTER TABLE users DROP COLUMN mfa_secret;
ALTER TABLE users DROP COLUMN mfa_pending_secret;
ALTER TABLE users DROP COLUMN mfa_pending_expires_at;
ALTER TABLE users DROP COLUMN mfa_last_counter;
ALTER TABLE devices ADD COLUMN credential_purpose TEXT NOT NULL DEFAULT 'background' CHECK(credential_purpose IN ('gui','background'));
DROP INDEX devices_identity_uq;
CREATE UNIQUE INDEX devices_identity_uq ON devices(user_id,credential_purpose,fingerprint_hash) WHERE revoked_at IS NULL;
ALTER TABLE sessions ADD COLUMN management_parent_session_id TEXT REFERENCES sessions(id);
CREATE INDEX sessions_management_parent ON sessions(management_parent_session_id);
CREATE TRIGGER account_session_revoked AFTER UPDATE OF revoked_at ON sessions
WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL
BEGIN
 UPDATE sessions SET revoked_at=COALESCE(revoked_at,NEW.revoked_at)
 WHERE management_parent_session_id=NEW.id OR native_parent_session_id=NEW.id
 OR native_parent_session_id IN (SELECT id FROM sessions WHERE management_parent_session_id=NEW.id);
 INSERT INTO outbox_events(event_type,resource_type,resource_id,resource_version,recipient_user_id,recipient_device_id,payload)
 VALUES('account.session.revoked','Session',NEW.id,1,NEW.user_id,NEW.device_id,json_object('session_id',NEW.id));
END;
CREATE TRIGGER rd_user_revoked AFTER UPDATE OF token_version,status ON users
WHEN NEW.token_version<>OLD.token_version OR NEW.status<>'active'
BEGIN
 UPDATE rd_tokens SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE owner_user_id=NEW.id;
 UPDATE rd_sessions SET state='closing',close_reason='RD_AUTH_REVOKED',state_version=state_version+1
 WHERE owner_user_id=NEW.id AND state NOT IN ('closed','expired','failed','closing');
END;
CREATE TRIGGER rd_assist_user_revoked AFTER UPDATE OF token_version,status ON users
WHEN NEW.token_version<>OLD.token_version OR NEW.status<>'active'
BEGIN
 UPDATE rd_assist_invites SET state='revoked',revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE (host_owner_user_id=NEW.id OR redeemed_by_user_id=NEW.id) AND state IN ('active','redeemed');
END;
CREATE TRIGGER rd_cross_account_user_revoked AFTER UPDATE OF token_version,status ON users
WHEN NEW.token_version<>OLD.token_version OR NEW.status<>'active'
BEGIN
 UPDATE rd_sessions SET state='closing',close_reason='RD_AUTH_REVOKED',state_version=state_version+1
 WHERE controller_owner_user_id=NEW.id AND state NOT IN ('closed','expired','failed','closing');
END;
CREATE TRIGGER rd_access_user_revoked AFTER UPDATE OF token_version,status ON users
WHEN NEW.token_version<>OLD.token_version OR NEW.status<>'active'
BEGIN
 UPDATE rd_access_profiles SET password_hash=NULL,revision=revision+1 WHERE host_owner_user_id=NEW.id;
 UPDATE rd_access_requests SET state='rejected',decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE (host_owner_user_id=NEW.id OR controller_owner_user_id=NEW.id) AND state IN ('pending','preparing');
END;
