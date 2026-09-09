-- Preserve account and traffic history while removing deleted accounts from use.
ALTER TABLE users ADD COLUMN deleted_at TEXT;
DROP INDEX users_username_lower_uq;
CREATE UNIQUE INDEX users_username_lower_uq ON users(lower(username)) WHERE deleted_at IS NULL;

-- Retain the earliest active administrator when upgrading older deployments.
-- Other accounts keep their resources and can sign in again as ordinary users.
CREATE TEMP TABLE legacy_administrators AS
SELECT id FROM users WHERE role='admin' AND id <> COALESCE(
  (SELECT id FROM users WHERE role='admin' ORDER BY (status='active') DESC,created_at,id LIMIT 1), '');
INSERT INTO audit_events(actor_type,action,target_type,target_id,before_value,after_value,request_id)
SELECT 'system','AdministratorConsolidated','User',id,'{"role":"admin"}','{"role":"user"}',lower(hex(randomblob(16)))
FROM legacy_administrators;
UPDATE sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id IN (SELECT id FROM legacy_administrators);
UPDATE devices SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),config_version=config_version+1
WHERE user_id IN (SELECT id FROM legacy_administrators);
UPDATE users SET role='user',token_version=token_version+1,version=version+1,
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (SELECT id FROM legacy_administrators);
DROP TABLE legacy_administrators;
CREATE UNIQUE INDEX users_single_administrator ON users(role) WHERE role='admin' AND deleted_at IS NULL;
