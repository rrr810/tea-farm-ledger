# Milestone 2 — Database, Events, Sync

## Delivered
- `packages/database` with PostgreSQL (or PGlite fallback) + migrations `001_initial.sql`
- Tables: farms, users, devices (enrolment, PIN, revocation), workers, employment_periods inclusive, plucking_days, rates effective_from, events append-only, pay_weeks (lock), payroll_lines, adjustments, payments (manual, reference worker_id+week_id), sms_messages, farm_settings, audit_log
- Events: client-generated UUID v7 `event_id`, farm_id, device_id, author, event_type, payload JSONB, business_date, client_timestamp, server_received_at, seq BIGSERIAL cursor, correction_flag, conflict_flag
- Sync protocol: `POST /api/sync/push` idempotent by event_id (duplicates counted, re-send has no effect), `GET /api/sync/pull?farm_id=&since=&limit=` ordered by seq, resumable if interrupted
- Server authoritative lock: late events for locked week (`pay_weeks.status=locked`) flagged as correction requests, never silently applied — Admin applies as next-week adjustment
- Same-worker/same-day conflicts surfaced (`conflict_flag`), never silent last-write-wins — endpoint `/api/farms/:farmId/conflicts` and corrections list
- Device enrolment tables with PIN hash and revocation ready for M4 offline unlock
- `docker-compose.yml` for local Postgres, plus `USE_PGLITE=true` ephemeral fallback for environments without Docker/WSL — banner labels demo data
- API Fastify with CORS, `/health`, `/api/health` (shows db type and demo flag), farm CRUD, sync routes
- Tests: `tests/sync.test.ts` (idempotency, cursor, resume, conflict, correction flag for locked week, server authoritative lock), `tests/offline.test.ts` placeholder for Dexie queue

## How sync works
1. PWA stores events in IndexedDB Dexie outbox.
2. On connectivity, pushes to `/api/sync/push` — server checks `event_id` uniqueness, checks pay_weeks lock, flags accordingly, increments seq.
3. Pull via `since` cursor (`seq`). If interrupted, client re-pushes same ids — idempotent.

## Running (choose one)
With Docker:
```powershell
docker compose up -d db
$env:DATABASE_URL="postgresql://tea_ledger:tea_ledger_dev@localhost:5432/tea_ledger"
npm.cmd run migrate
npm.cmd run dev:api
npm.cmd test
```
Without Docker (preview/CI, ephemeral, labeled):
```powershell
$env:USE_PGLITE="true"
npm.cmd run dev:api
npm.cmd test
```

## Typecheck
`npm.cmd run typecheck` — all workspaces.

## Test counts
- Core: ~30 unit tests (phone, money, settings, sms, week, validation)
- Database: 5 integration tests (push idempotency, pull cursor, conflict, correction flag, lock)

Run `npm.cmd test` — tests use real PG when DATABASE_URL set, otherwise PGlite in-memory (labeled in output).

## Deviations and things I did not do
- No UI in this milestone (per spec)
- Scheduler jobs deferred to M5 (cron Africa/Nairobi, idempotent)
- Payroll sheets deferred to M6 (week lock already enforced)
- No real Africa's Talking call — mock adapter, AT adapter stub follows official docs but not invoked unless SMS_PROVIDER=africastalking + AT_API_KEY set

## Open questions
- Supervisor PIN hashing algorithm (bcrypt vs argon2) — will finalize in M4 with device enrolment UI.

Tag: `v0.2-m2`
