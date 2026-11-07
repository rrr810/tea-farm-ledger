-- 006_field_device_link_codes: short-lived, single-use approval codes for
-- attaching an empty field browser to an existing farm. The plaintext code is
-- deliberately never stored; only its SHA-256 digest is persisted.

CREATE TABLE IF NOT EXISTS field_device_link_codes (
  code_id UUID PRIMARY KEY,
  farm_id UUID NOT NULL REFERENCES farms(farm_id),
  created_by_user_id UUID NOT NULL REFERENCES users(user_id),
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_device_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_field_device_link_codes_active
  ON field_device_link_codes(farm_id, expires_at)
  WHERE consumed_at IS NULL;
