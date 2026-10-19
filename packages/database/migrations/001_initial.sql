-- 001_initial: farms, users, devices, events, pay_weeks, etc. (pglite compatible, no pgcrypto)

-- Farms
CREATE TABLE IF NOT EXISTS farms (
  farm_id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Users (admin/supervisor)
CREATE TABLE IF NOT EXISTS users (
  user_id UUID PRIMARY KEY,
  farm_id UUID REFERENCES farms(farm_id),
  role TEXT NOT NULL CHECK (role IN ('admin','supervisor')),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Devices (enrolment)
CREATE TABLE IF NOT EXISTS devices (
  device_id UUID PRIMARY KEY,
  farm_id UUID REFERENCES farms(farm_id),
  supervisor_user_id UUID REFERENCES users(user_id),
  enrolled_at TIMESTAMPTZ DEFAULT NOW(),
  pin_hash TEXT,
  revoked BOOLEAN DEFAULT FALSE,
  last_seen TIMESTAMPTZ
);

-- Workers
CREATE TABLE IF NOT EXISTS workers (
  worker_id UUID PRIMARY KEY,
  farm_id UUID REFERENCES farms(farm_id),
  full_name TEXT NOT NULL,
  phone_e164 TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  verified BOOLEAN DEFAULT FALSE,
  consent_at TIMESTAMPTZ,
  consent_author TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workers_farm_phone ON workers(farm_id, phone_e164);

-- Employment periods (inclusive dates)
CREATE TABLE IF NOT EXISTS employment_periods (
  id UUID PRIMARY KEY,
  worker_id UUID REFERENCES workers(worker_id),
  farm_id UUID REFERENCES farms(farm_id),
  start_date DATE NOT NULL,
  end_date DATE,
  end_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT inclusive_dates CHECK (end_date IS NULL OR end_date >= start_date)
);

-- Plucking days
CREATE TABLE IF NOT EXISTS plucking_days (
  farm_id UUID REFERENCES farms(farm_id),
  date DATE NOT NULL,
  is_plucking_day BOOLEAN NOT NULL DEFAULT TRUE,
  reason TEXT,
  confirmed BOOLEAN DEFAULT FALSE,
  confirmed_at TIMESTAMPTZ,
  PRIMARY KEY (farm_id, date)
);

-- Rates (effective_from inclusive)
CREATE TABLE IF NOT EXISTS rates (
  farm_id UUID REFERENCES farms(farm_id),
  effective_from DATE NOT NULL,
  rate_cents_per_kg INTEGER NOT NULL CHECK (rate_cents_per_kg >= 0),
  PRIMARY KEY (farm_id, effective_from)
);

-- Events (append-only, audit trail)
CREATE TABLE IF NOT EXISTS events (
  event_id UUID PRIMARY KEY,
  farm_id UUID NOT NULL REFERENCES farms(farm_id),
  device_id UUID,
  author TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  business_date DATE NOT NULL,
  client_timestamp TIMESTAMPTZ NOT NULL,
  server_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seq BIGSERIAL UNIQUE,
  correction_flag BOOLEAN DEFAULT FALSE,
  conflict_flag BOOLEAN DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_events_farm_seq ON events(farm_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_business_date ON events(farm_id, business_date);

-- Pay weeks (lock)
CREATE TABLE IF NOT EXISTS pay_weeks (
  farm_id UUID REFERENCES farms(farm_id),
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','locked')),
  locked_at TIMESTAMPTZ,
  PRIMARY KEY (farm_id, week_start)
);

-- Payroll lines
CREATE TABLE IF NOT EXISTS payroll_lines (
  farm_id UUID REFERENCES farms(farm_id),
  week_start DATE NOT NULL,
  worker_id UUID REFERENCES workers(worker_id),
  kg_units INTEGER NOT NULL,
  rate_snapshot JSONB,
  amount_cents INTEGER NOT NULL,
  flags TEXT[] DEFAULT '{}',
  PRIMARY KEY (farm_id, week_start, worker_id)
);

-- Adjustments
CREATE TABLE IF NOT EXISTS adjustments (
  id UUID PRIMARY KEY,
  farm_id UUID REFERENCES farms(farm_id),
  worker_id UUID REFERENCES workers(worker_id),
  week_start DATE NOT NULL,
  kg_units INTEGER NOT NULL,
  rate_cents_per_kg INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Payments (manual)
CREATE TABLE IF NOT EXISTS payments (
  farm_id UUID REFERENCES farms(farm_id),
  worker_id UUID REFERENCES workers(worker_id),
  week_start DATE NOT NULL,
  mpesa_code TEXT,
  paid_at TIMESTAMPTZ,
  reference TEXT UNIQUE,
  PRIMARY KEY (farm_id, worker_id, week_start)
);

-- SMS messages
CREATE TABLE IF NOT EXISTS sms_messages (
  id UUID PRIMARY KEY,
  farm_id UUID REFERENCES farms(farm_id),
  type TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  segments INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','delivered')),
  provider_id TEXT,
  cost_estimate_cents INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Settings
CREATE TABLE IF NOT EXISTS farm_settings (
  farm_id UUID PRIMARY KEY REFERENCES farms(farm_id),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  farm_id UUID REFERENCES farms(farm_id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migrations tracking
CREATE TABLE IF NOT EXISTS _migrations (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);
