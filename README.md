# Tea Farm Plucking Ledger — Phase 1

Kenyan smallholder tea farm ledger: offline-first supervisor PWA, SMS to Owner/workers via Africa's Talking (mock by default), Admin web, weekly payroll with lock/corrections, reports, deployment + pilot-ready. No money movement in Phase 1 (Phase 2 M-Pesa hooks present).

## Quick start — Windows PowerShell (Node 26)

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test          # 64 tests, PGlite ephemeral when USE_PGLITE=true
npm.cmd run dev:api   # Fastify 0.0.0.0:3000 — no Docker/WSL required (USE_PGLITE=true fallback, labeled ephemeral demo data)
# PWA:  npm.cmd run dev:pwa    -> http://localhost:5173 (HTTPS preview via Vercel, service worker)
# Admin:npm.cmd run dev:admin  -> http://localhost:5174/admin
```

With Docker Postgres (persistent):

```powershell
docker compose up -d db
npm.cmd run migrate
npm.cmd run seed      # 15 workers, 8 weeks, rehire, no-plucking, rate change, mid-week firing
npm.cmd run dev:api
```

## Stack

TypeScript monorepo · npm workspaces · React + Dexie/IndexedDB · Fastify · PostgreSQL (or PGlite embedded fallback) · Vitest · Playwright · shared @tea-ledger/core · Africa's Talking SMS (mock default)

## Previews (HTTPS, no localhost in browser)

- **PWA**: `https://tea-farm-ledger.vercel.app/` — installable (service worker), offline, `Done for the day` flow, `pending upload` banner, Saturday FINAL.
- **Admin**: `https://tea-farm-ledger.vercel.app/admin` — login `admin`/ADMIN_DEFAULT_PASSWORD, workers, payroll (flags, CSV, printable), conflicts, SMS log, reports (monthly, hardest-working ranking), CSV import, audit, settings.
- **API**: `GET /api/health`, `GET /api/sms-log?farm_id=...` (segments/status), `GET /api/farms/:farmId/payroll/:weekStart?format=csv|html`.
- All previews show ephemeral warning when `USE_PGLITE=true`; no real SMS in preview (mock/sandbox).

## Pilot

First pilot week Mon 23 Nov 2026, M1–M6 deployable by then. 2-week trial alongside paper book, presented Dec 2026.

See `docs/PILOT-CHECKLIST.md`, `docs/DEPLOYMENT.md`, `docs/BACKUP-RESTORE.md`, `docs/MILESTONE-8.md`.

## Decisions

Ryan's 28 authoritative decisions in `docs/APPROVED-DECISIONS.md`; our judgements (Friday Owner-only, etc.) in `docs/DECISIONS.md`. Git history notes in `docs/GIT-NOTES.md`. On conflict, APPROVED wins.

## Timezone

All business dates Africa/Nairobi (EAT, UTC+3). Week Monday–Saturday. Payroll: rate effective per plucking date, integer tenths×cents, one half-up rounding per worker/week, grand total sum of rounded.

