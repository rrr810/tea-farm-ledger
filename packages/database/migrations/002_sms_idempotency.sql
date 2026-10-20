-- 002_sms_idempotency: add job_key for idempotent scheduler + indexes

ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS job_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_messages_job_key ON sms_messages(job_key) WHERE job_key IS NOT NULL;

-- Ensure farm_settings has default structure for supervisor/owner phones
-- No schema change needed, JSONB settings will hold: { ownerPhone, supervisorPhone, fridayEstimateTime }

-- Add id for cron tracking (optional)
CREATE TABLE IF NOT EXISTS sms_jobs (
  job_key TEXT PRIMARY KEY,
  farm_id UUID REFERENCES farms(farm_id),
  type TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  executed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','skipped','failed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sms_jobs_scheduled ON sms_jobs(scheduled_for);
