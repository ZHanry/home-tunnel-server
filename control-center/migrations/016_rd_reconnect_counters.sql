-- User-directed display switches must not consume the network recovery budget.
ALTER TABLE rd_sessions ADD COLUMN network_reconnect_count INTEGER NOT NULL DEFAULT 0
  CHECK(network_reconnect_count BETWEEN 0 AND 3);

-- Earlier sessions counted every rebuild through the connection epoch. Preserve
-- their consumed budget; no existing rebuild is silently granted a second time.
UPDATE rd_sessions SET network_reconnect_count = min(max(connection_epoch - 1, 0), 3);
