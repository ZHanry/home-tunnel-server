ALTER TABLE connections ADD COLUMN application_protocol TEXT
  CHECK (application_protocol IS NULL OR application_protocol IN ('rtsp','ssh','rdp'));
INSERT OR IGNORE INTO deployment_settings(key,value) VALUES('client_raw_tunnels_enabled','false');
