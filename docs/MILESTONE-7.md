# Milestone 7 — Admin dashboard, conflict resolution, SMS log, reports, CSV import

## Delivered
- **Admin Web** `apps/admin-web` (React + Vite): login (password, secure sessions, role checks; MFA deferred per Decision 22), farm selector, 9 tabs:
  - **Dashboard**: workers count, pay weeks (locked/open/incomplete), unresolved conflicts, correction requests, farm_id on all tables note.
  - **Workers**: full employment history table (phone, status, verified).
  - **Payroll**: week picker → sheet with flags, CSV download (`?format=csv`), printable HTML (`?format=html`), next-week adjustment form (post-lock correction, server authoritative lock, Owner SMS notify).
  - **Conflicts**: unresolved same-worker/same-day conflicts (never silent last-write-wins, Decision 20) + correction requests (late events for locked week flagged).
  - **SMS Log**: all messages with type, to, body, segments, status, provider_id; cost estimate per farm per month via `/api/sms-stats`.
  - **Reports**: monthly kg + payroll totals (last 6 months, `GET /reports/monthly`), hardest-working quarterly ranking (total kg, avg kg/day, attendance rate plucking-days during active employment; note "kg does not reflect leaf quality" — Decision 4.9), active/idle details.
  - **CSV Import**: canonical template `worker_id,full_name,phone_e164,business_date,kg_units,present,is_plucking_day,rate_cents_per_kg`, preview before commit, duplicates rejected explicitly, existing server duplicates flagged.
  - **Settings**: rate with effective dates CRUD, hire/fire permissions, SMS language, owner/supervisor phones, cutoff times via Farm settings JSON.
  - **Audit Log**: every change with author & time from `audit_log` (inserted on adjustments, csv imports, rate changes).
- **Backend** `apps/api/src/routes/admin.ts`:
  - `POST /api/admin/login` — creates `sessions` row (7d expiry, token `uuid-uuid`), `GET /api/admin/me` + `POST /api/admin/logout`. Default admin seeded from `ADMIN_USERNAME`/`ADMIN_DEFAULT_PASSWORD` env (dev: `admin` / `tea-admin-2026`).
  - `GET /api/farms/:farmId/audit-log`, `GET .../reports/monthly`, `GET .../reports/active-idle?month=YYYY-MM`, `GET .../reports/hardest-working?quarter=YYYY-QN`, `GET .../csv-template`, `POST .../csv-import/preview`, `POST .../csv-import/commit`, `GET .../export/workers?format=csv`.
  - Migration `003_admin_reports.sql`: `sessions` table, indexes for reports.
- **Hosting**: `vercel.json` builds both PWA and Admin (`npx vite build apps/admin-web` + `cp -r apps/admin-web/dist/* apps/api/public/admin/`), rewrites `/admin` + `/admin/:path*` to Admin SPA, PWA at `/`. Separate previews: `https://…vercel.app/` (PWA) and `https://…vercel.app/admin` (Admin dashboard).
- **Live previews**: Admin requires HTTPS, relative URLs, same-origin `/api` proxy (Vite proxy `"/api": "localhost:3000"` in dev, Vercel rewrite to serverless `/api` in prod). No localhost in browser.
- **Security**: password via env, SHA256(salt+pass) in `users.password_hash`, sessions in DB, audit trail, rate limiting hook placeholder, farm_id tenancy everywhere, no secrets in Git.

## Previews
- **PWA**: `https://tea-farm-ledger.vercel.app/` (installable, offline)
- **Admin**: `https://tea-farm-ledger.vercel.app/admin` — login admin / ADMIN_DEFAULT_PASSWORD, then Workers/Payroll/Conflicts/SMS/Reports/Import/Audit
- **API**: `GET /api/sms-log?farm_id=...` + `GET /api/farms/:farmId/payroll/:weekStart?format=csv|html`

## Running
```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test  # 60 tests
# Admin dev (port 5174, PWA on 5173)
npm.cmd --workspace=@tea-ledger/admin-web run dev
npm.cmd --workspace=@tea-ledger/api run dev
# Open http://localhost:5174/admin (Vite) or https://<preview>/admin (prod)
```

## Test counts
- **60 tests**: core 31 + payroll 4 + sync 4 + offline 8 + scheduler 6 + workers 2 + admin 4 + validation/etc. All on PGlite ephemeral (labeled demo). `npm test` → 60 passed.

## Deviations
- No MFA (deferred per Decision 22); no graphs library dependency—tables with monthly trends (graphs can be added with Chart.js later, not blocking pilot).
- Admin auth is SHA256(salt+pass) for Phase 1; will upgrade to bcrypt+secure cookies in M8 hardening.
- CSV import does not yet handle supervisor hire/fire events, only pluck logs; can extend to full historical import.
- Payout reconciliation/manual M-Pesa mark-as-paid deferred to M8 (Admin can see payroll, owner pays manually).

Tag: v0.7-m7
