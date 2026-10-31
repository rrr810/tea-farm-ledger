-- 002_private_worker_identity: encrypted, admin-only worker identity records.
-- Sensitive values intentionally live outside workers so public/supervisor worker
-- lists and sync projections can never expose an ID number or identity image.

CREATE TABLE IF NOT EXISTS worker_identity_records (
  identity_id UUID PRIMARY KEY,
  farm_id UUID NOT NULL REFERENCES farms(farm_id),
  worker_id UUID NOT NULL REFERENCES workers(worker_id),
  national_id_lookup TEXT NOT NULL,
  national_id_ciphertext BYTEA NOT NULL,
  national_id_iv BYTEA NOT NULL,
  national_id_auth_tag BYTEA NOT NULL,
  consent_at TIMESTAMPTZ NOT NULL,
  consent_author TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at TIMESTAMPTZ
);

-- One current identity record per worker. Corrections retain the old row and
-- mark it superseded rather than deleting identity history.
CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_identity_current_worker
  ON worker_identity_records(worker_id)
  WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_identity_current_farm_id
  ON worker_identity_records(farm_id, national_id_lookup)
  WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_worker_identity_farm_worker
  ON worker_identity_records(farm_id, worker_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS worker_identity_documents (
  document_id UUID PRIMARY KEY,
  identity_id UUID NOT NULL REFERENCES worker_identity_records(identity_id),
  farm_id UUID NOT NULL REFERENCES farms(farm_id),
  worker_id UUID NOT NULL REFERENCES workers(worker_id),
  document_type TEXT NOT NULL CHECK (document_type IN ('national_id_photo')),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  encrypted_bytes BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 1250000),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  captured_by TEXT NOT NULL,
  superseded_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_identity_current_document
  ON worker_identity_documents(identity_id, document_type)
  WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_worker_identity_document_lookup
  ON worker_identity_documents(farm_id, worker_id, captured_at DESC);
