-- Preserve a trusted public keyset independently of the active private key file.
ALTER TABLE rd_server_state ADD COLUMN keyset_json TEXT CHECK(keyset_json IS NULL OR json_valid(keyset_json));
