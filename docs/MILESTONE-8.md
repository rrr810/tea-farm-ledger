# Milestone 8 — Hardening, deployment, daily backup/restore, pilot checklist, seeded demo

## Delivered
- **Deployment guide** `docs/DEPLOYMENT.md`: VPS Docker + Nginx + Certbot HTTPS + domain, env checklist (persistent `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_DEFAULT_PASSWORD`, `CRON_SECRET` + `REQUIRED_CRON_SECRET=true`, PGlite refused in prod), Vercel Hobby alternative (daily/hourly UTC crons production-only, `vercel.json` builds both PWA + Admin), cost notes (no paid resources without permission, mock SMS default per Decision 25, AT live via secure secrets only).
- **Daily backup/restore** `docs/BACKUP-RESTORE.md` + `scripts/backup.sh` (cron `0 2 * * * /opt/tea-ledger/scripts/backup.sh` → `/var/backups/tea-ledger/YYYY-MM-DD.sql.gz`, 30d retention, `pg_dump | gzip`, S3 optional, restore via `gunzip | psql`, verify migrations + `GET /api/health` + payroll check, notify Owner/Admin).
- **Pilot checklist** `docs/PILOT-CHECKLIST.md`: 2-week farm trial Mon 2026-11-23 → Sat 2026-12-05 alongside paper book, week Mon–Sat Africa/Nairobi, daily flow (offline PWA, confirm, sync, daily SMS), Friday 17:00 estimate, Saturday 14:30 reminder + lock → correct payroll sheet with flags, CSV + printable (Save as PDF), post-lock corrections only via Admin adjustment to next week, paper comparison, reports, owner/supervisor interviews before December demo.
- **Seeded demo** `scripts/seed-demo.ts` (run `USE_PGLITE=true npx tsx scripts/seed-demo.ts` or `npm run seed`): 15 workers over 8 weeks (2026-10-12 → 2026-12-05) including:
  - Rehire: Chebet B fired 2026-11-13, rehired 2026-11-20 (same profile, history preserved, gap with no employment).
  - No-plucking day: 2026-11-04 (heavy rain, `is_plucking_day=false` not counted as absence).
  - Rate change mid-week: 2026-11-16 900→1000 cents/kg (10 KES), weighted rate per band shown, integer half-up rounding once per worker/week, grand total sum of rounded.
  - Mid-week firing: Langat G fired Wed 2026-11-25 inclusive, paid Mon/Tue only.
  - Verified workers, daily `day.confirmed`, weekly `week.submitted` → locked `pay_weeks`, owner/supervisor phones in `farm_settings`, all 8 weeks locked, payroll verifiable via `GET /api/farms/$FARM_ID/payroll/2026-11-23?format=html|csv`.
  - Demo farm `00000000-0000-4000-a000-000000000099` ("Demo Tea Farm — 15 workers, 8 weeks"), demo data labeled `DEMO DATA — ephemeral, resets on restart` when `USE_PGLITE=true` (preview), persistent on `DATABASE_URL`.
- **Package.json** `scripts.seed`: `tsx scripts/seed-demo.ts` with `tsx` devDep.
- **Security hardening**: `SESSION_SECRET` env, SHA256 salted passwords, `CRON_SECRET` required in prod, `DATABASE_URL` persistent default, refused PGlite in prod, farm_id tenancy everywhere, append-only events, idempotent sync, audit log, rate limiting hook, HTTPS, no secrets in Git.
- **Vercel**: dual build verified (`npx vite build apps/supervisor-pwa && npx vite build apps/admin-web && cp .../public && .../public/admin`), previews PWA `/` + Admin `/admin` + mock SMS log segments/status.

## Previews
- PWA: `https://tea-farm-ledger.vercel.app/` (installable HTTPS, service worker)
- Admin: `https://tea-farm-ledger.vercel.app/admin`
- Seeded demo payroll: `GET /api/farms/00000000-0000-4000-a000-000000000099/payroll/2026-11-23?format=html`

## Running
```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test  # 60–64 tests (seed adds payroll cases)
npm.cmd run seed  # seeds demo farm (8 weeks, 15 workers)
npm.cmd run dev:api # + separate vite for PWA/Admin
```

## Test counts
- **60 tests** (core 31 + payroll 4 + sync 4 + offline 8 + scheduler 6 + workers 2 + admin 4 + validation/etc). Seeded demo exercised via payroll tests (mid-week rate, lock, anomaly). `npm test` → 60 passed.

## Deviations
- No real AT network call in mock (sandbox pending owner credentials).
- Graphs in Reports are tables (Chart.js deferred, not blocking pilot).
- Backup S3 upload commented-out (provide when pilot VPS chosen).

Tag: v0.8-m8
