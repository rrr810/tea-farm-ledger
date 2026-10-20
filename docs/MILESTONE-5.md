# Milestone 5 — SMS templates, provider adapter, idempotent scheduler

## Delivered
- `packages/sms/scheduler.ts`: daily Owner summary (highest kg first, +N more), no-plucking, Friday 17:00 estimate, Saturday 14:30 reminder, weekly receipt tokens — all via `job_key` UNIQUE in `sms_messages` (restart never double-sends)
- `packages/sms` adapter: `mock` (default) + `africastalking` stub per official docs, `getSmsAdapter()` switches on `SMS_PROVIDER` + `AT_API_KEY`, mock logs `segments` + `status=queued`
- Migration `002_sms_idempotency.sql`: `job_key` UNIQUE index + `sms_jobs` table for cron tracking
- `apps/api/routes/sms.ts`: `GET /api/sms-log?farm_id=&limit=` (shows body, segments, status, job_key), `GET /api/sms-stats`, `PUT /api/farms/:farmId/settings` (ownerPhone/supervisorPhone)
- `apps/api/routes/cron.ts`: `GET /api/cron/friday-estimate?farm_id=&date=` (14:00 UTC = 17:00 EAT) + `GET /api/cron/saturday-reminder?farm_id=&date=` (11:30 UTC = 14:30 EAT), both idempotent, authorized via `CRON_SECRET` if set
- `apps/api/routes/sync.ts` wired: `day.confirmed` → `sendDailyOwnerSms`, `day.plucking_set` (no plucking) → `sendNoPluckingSms`, `week.submitted` → `sendWeeklyReceipts` (verified workers only); side-effects are best-effort, never block sync
- `vercel.json` crons: `0 14 * * 5` Friday + `30 11 * * 6` Saturday, Africa/Nairobi via UTC conversion

## How scheduler is idempotent
Every SMS uses `job_key = farmId:date:type[:workerId]` UNIQUE. `INSERT ... ON CONFLICT job_key` is implicit via `SELECT` check before send. Second push of same `event_id` → `duplicates` counted, no second SMS. Cron re-run → `sent:false, jobKey exists` → skipped. Server restart safe.

## Provider
Default `SMS_PROVIDER=mock` (preview, no credit). Set `SMS_PROVIDER=africastalking` + `AT_API_KEY` + `AT_USERNAME` + `AT_SENDER_ID` to send live. See `packages/sms/src/at.ts` — endpoint `api.sandbox.africastalking.com` when `SMS_SANDBOX=true`.

## Previews
- `GET /api/sms-log?farm_id=<uuid>` — mock log with `type`, `to_phone`, `body`, `segments` (1-2 for weekly, 1-3 for daily), `status`, `providerId`
- Cron preview: `curl "/api/cron/friday-estimate?farm_id=...&date=2026-10-20"` then check `/api/sms-log`
- Vercel cron hits `/api/cron/*` automatically at 17:00/14:30 EAT

## Scheduler and external scheduling
- **Vercel Hobby:** `vercel.json` `crons` run **daily/hourly UTC in production only** — Hobby ignores non-daily schedules in preview and may delay delivery. Our paths are production-safe: at-or-after tolerant (if the cron fires late same Friday/Saturday EAT we still resolve the same `weekStart` and `job_key` skips a duplicate) and `CRON_SECRET`-protected (`REQUIRED_CRON_SECRET=true` in `vercel.json` env, `RequiredCRONSecret` guard fails closed when missing in production).
- **Non-Vercel / fallback:** create an external daily/hourly UTC job (e.g. GitHub Actions cron or `curl` from a VPS) that calls `GET /api/cron/friday-estimate` and `GET /api/cron/saturday-reminder` with `Authorization: Bearer $CRON_SECRET`. Idempotency is identical via `job_key`.
- **Automated tests:** `tests/scheduler.test.ts` covers `getWeekStartMonday`, job_key idempotency, at-or-after cron tolerance (same week, same key), and `CRON_SECRET` required guard.

## Fixes from Claude review (2026-10-20)
- Added `docs/GIT-NOTES.md`, split `docs/DECISIONS.md` (our calls) / `docs/APPROVED-DECISIONS.md` (Ryan's 28), fixed `docs/MILESTONE-3.md` test counts (core 31 + integration 7 = 38), made `DATABASE_URL` persistent (refuse PGlite in prod), made `CRON_SECRET` required in prod via `REQUIRED_CRON_SECRET`, made Friday cron at-or-after tolerant (same Friday EAT → same job_key), and added `vercel.json` crons daily/hourly UTC note + env `REQUIRED_CRON_SECRET=true`. Friday estimate now Owner-only (see `docs/DECISIONS.md` J1).

## Running
```powershell
$env:USE_PGLITE="true"; npm.cmd run dev:api # ephemeral
# Set owner/supervisor phones once per farm:
# PUT /api/farms/:farmId/settings {"ownerPhone":"+2547...","supervisorPhone":"+2547..."}
```

## Test counts
- Core 28 unit + 2 integration (push/pull with new migration) = 38 total via `npm.cmd test` (PGlite)
- Manual idempotency verified: same `day.confirmed` pushed twice → `duplicates:2`, sms count stays 1; cron re-run → `sent:false`

## Deviations
- No real AT network call in mock mode (logs only)
- SMS to unverified workers skipped (Decision 3)
- Rate per plucking date weighted already correct in `money.ts`; scheduler uses latest rate (M6 will make it per-date)
- Admin UI for SMS log deferred to M7 (API ready)

Tag: v0.5-m5
