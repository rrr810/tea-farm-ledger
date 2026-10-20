-- 003_admin_reports: sessions, ensure audit_log, ensure payroll_lines already exists, add index for reports

-- Sessions for Admin login (simple token, no pgcrypto needed)
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(user_id),
  farm_id UUID REFERENCES farms(farm_id),
  role TEXT NOT NULL CHECK (role IN ('admin','supervisor')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Ensure admin default user exists via API seed, not here (migrations should not require env)

-- Audit log already in 001, ensure index
CREATE INDEX IF NOT EXISTS idx_audit_farm ON audit_log(farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_farm_type ON events(farm_id, event_type, business_date);

-- Ensure payroll_lines flags index for reports
CREATE INDEX IF NOT EXISTS idx_payroll_lines_farm_week ON payroll_lines(farm_id, week_start);
CREATE INDEX IF NOT EXISTS idx_adjustments_farm_week ON adjustments(farm_id, week_start);
