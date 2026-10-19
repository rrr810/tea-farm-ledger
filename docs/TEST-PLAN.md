# TEST PLAN

## Unit
- `packages/core/src/__tests__/phone.test.ts` — KE normalization (+2547/1, 07/01, 254, 7/1), masking
- `money.test.ts` — integer arithmetic, per-date rates, one half-up rounding per worker/week, grand total sum, weighted rate bands
- `settings.test.ts` — defaults (rate 900, max 600 tenths, tolerance 500bps, anomaly 5000bps, 17:00/14:30, mock), validation
- `sms.test.ts` — GSM-7, segment counting (160/153), weekly receipt ≤2 segments, daily line order highest first, no-plucking, reminder wording, verification
- `week.test.ts` — Monday-Saturday Africa/Nairobi, weekRangeFromDate, addDays
- `validation.test.ts` — kg integer tenths, negatives, implausible, name, phone

## Integration (real DB, or PGlite fallback labeled ephemeral)
- `tests/sync.test.ts` — push idempotency by event_id, pull by cursor, resume after interruption, conflict flag, correction flag for locked week, server authoritative lock
- `tests/offline.test.ts` — PWA Dexie outbox queue, pending sync count, "pending upload" for unsynced Saturday
- `tests/payroll.test.ts` (M3) — pay calculation with rate change mid-week, rounding, tolerance flag
- Scheduler idempotency tested via repeated job runs

## Running
```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
```
With Docker Postgres:
```powershell
docker compose up -d db
npm.cmd run migrate
npm.cmd test
```
Without Docker (embedded PGlite, ephemeral):
```powershell
$env:USE_PGLITE="true"
npm.cmd test
```
Preview data is labeled `DEMO DATA — ephemeral, resets on restart` when USE_PGLITE=true.
