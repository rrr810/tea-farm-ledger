-- 004_supervisor_identity_access: throttled, least-privilege Supervisor sessions.
-- Password hashes stay in users.password_hash; this table stores only login
-- attempt counters so private-ID writes can be rate-limited without logging IDs.

CREATE TABLE IF NOT EXISTS supervisor_login_throttles (
  farm_id UUID NOT NULL REFERENCES farms(farm_id),
  username TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  PRIMARY KEY (farm_id, username)
);

CREATE INDEX IF NOT EXISTS idx_supervisor_login_throttles_locked
  ON supervisor_login_throttles(locked_until);
