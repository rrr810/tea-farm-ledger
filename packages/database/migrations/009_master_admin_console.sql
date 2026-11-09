-- 009_master_admin_console: one central, email-based Master Admin account.
--
-- Farm Owner and Supervisor accounts remain farm-bound in `users`. The Master
-- account is deliberately separate so it can manage every farm without making
-- a farm-specific Owner account a cross-farm privilege.

CREATE TABLE IF NOT EXISTS platform_admins (
  platform_admin_id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  email_canonical TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  activated_by_user_id UUID NOT NULL REFERENCES users(user_id),
  -- The fixed value is protected by a unique index below, giving the database
  -- (not merely the activation handler) a one-Master invariant under races.
  singleton_key SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_signed_in_at TIMESTAMPTZ
);

-- Safely adds the invariant if a pre-release database already has the table.
ALTER TABLE platform_admins
  ADD COLUMN IF NOT EXISTS singleton_key SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE platform_admins
  DROP CONSTRAINT IF EXISTS platform_admins_singleton_key_check;
ALTER TABLE platform_admins
  ADD CONSTRAINT platform_admins_singleton_key_check CHECK (singleton_key = 1);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_admins_singleton_key
  ON platform_admins(singleton_key);

-- A replacement Supervisor remains historically traceable, but cannot log in
-- or retain a private-ID session after the Master revokes their access.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS disabled_by_platform_admin_id UUID
    REFERENCES platform_admins(platform_admin_id);
CREATE INDEX IF NOT EXISTS idx_users_active_supervisors
  ON users(farm_id, role, created_at)
  WHERE disabled_at IS NULL;

-- Only a digest of the browser-held Master session token is stored.
CREATE TABLE IF NOT EXISTS platform_sessions (
  token TEXT PRIMARY KEY,
  platform_admin_id UUID NOT NULL REFERENCES platform_admins(platform_admin_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_sessions_admin
  ON platform_sessions(platform_admin_id);
CREATE INDEX IF NOT EXISTS idx_platform_sessions_expires
  ON platform_sessions(expires_at);

-- Defend the sole high-privilege sign-in independently of the farm Supervisor
-- login throttle. The email itself is only a canonical lookup key here.
CREATE TABLE IF NOT EXISTS platform_login_throttles (
  email_canonical TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ
);

-- A Master Admin can create an empty-field-device pairing code, but is not a
-- farm user. Preserve provenance without forging a farm Owner user ID.
ALTER TABLE field_device_link_codes
  ALTER COLUMN created_by_user_id DROP NOT NULL;
ALTER TABLE field_device_link_codes
  ADD COLUMN IF NOT EXISTS created_by_platform_admin_id UUID
    REFERENCES platform_admins(platform_admin_id);

ALTER TABLE field_device_link_codes
  DROP CONSTRAINT IF EXISTS field_device_link_codes_exactly_one_creator;
ALTER TABLE field_device_link_codes
  ADD CONSTRAINT field_device_link_codes_exactly_one_creator
  CHECK (
    (created_by_user_id IS NOT NULL AND created_by_platform_admin_id IS NULL)
    OR
    (created_by_user_id IS NULL AND created_by_platform_admin_id IS NOT NULL)
  );
