-- A native verifier must bind the host's one-session grant to the same signed request.
ALTER TABLE rd_sessions ADD COLUMN session_request_id TEXT NOT NULL DEFAULT '';
UPDATE rd_sessions SET session_request_id=COALESCE(
  (SELECT one_session_request_id FROM rd_grants WHERE rd_grants.id=rd_sessions.grant_id),
  (SELECT key FROM rd_idempotency WHERE operation='create' AND json_extract(result_json,'$.id')=rd_sessions.id LIMIT 1),
  id
);
