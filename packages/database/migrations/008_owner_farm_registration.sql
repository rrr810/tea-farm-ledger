-- 008_owner_farm_registration: reserve canonical official farm names.
--
-- An Owner-led registration needs an unambiguous farm name for the normal
-- field-phone login. A separate reservation table gives new registrations a
-- transaction-safe, case/whitespace-insensitive name key without failing this
-- migration if a legacy database already contains duplicate old farm names.
-- Legacy ambiguous farms remain reachable through the existing Owner one-time
-- code fallback; no data is renamed, removed, or merged here.
CREATE TABLE IF NOT EXISTS farm_name_reservations (
  canonical_name TEXT PRIMARY KEY,
  farm_id UUID NOT NULL REFERENCES farms(farm_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed every existing canonical name. ON CONFLICT DO NOTHING deliberately
-- keeps the first encountered legacy farm when historical duplicates exist;
-- that name is still reserved from any new registration.
INSERT INTO farm_name_reservations (canonical_name, farm_id)
SELECT LOWER(BTRIM(name)), farm_id
  FROM farms
ON CONFLICT (canonical_name) DO NOTHING;
