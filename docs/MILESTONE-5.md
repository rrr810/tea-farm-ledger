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
