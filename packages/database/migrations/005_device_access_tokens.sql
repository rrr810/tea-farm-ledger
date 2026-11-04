-- 005_device_access_tokens: opaque, revocable credentials for a field device.
-- A farm ID is an identifier, not a credential. Only the SHA-256 digest of the
-- random device token is stored server-side so a database read cannot replay it.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS access_token_hash TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS access_token_issued_at TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS access_token_last_used_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_devices_farm_access_token
  ON devices(farm_id, access_token_hash);
