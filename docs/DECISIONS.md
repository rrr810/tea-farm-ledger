# Our Judgement Calls (not Ryan's approved decisions)

These are our interpretations for unspecified points. Ryan's authoritative decisions live in `APPROVED-DECISIONS.md`. Where we conflict with Ryan, Ryan wins.

## J1 — Friday estimate recipient
- **Choice:** Owner only. No supervisor fallback.
- **Why:** Ryan clarified the Owner SMS is the source of truth for Friday estimates. If the Owner has no phone number configured, we log a warning and skip — we do not fall back to the supervisor.
- **Where:** `packages/sms/src/scheduler.ts#sendFridayEstimate`, `apps/api/src/routes/cron.ts`.
- **Alternatives rejected:** falling back to supervisor (hides missing Owner number).

## J2 — Daily summary line order tie-break
- **Choice:** When two workers have the same kg, order by name ascending.
- **Why:** Deterministic SMS for testing and for the Owner's expectation.
- **Where:** `packages/sms/src/scheduler.ts#sendDailyOwnerSms`.

## J3 — Weekly receipt compaction
- **Choice:** Per-day tokens `Mon:kg Tue:A Wed:NP …` joined, truncated to 2 GSM-7 segments (306 chars) with `… see dashboard` suffix if needed.
- **Why:** Decision 6 requires 2 segments max; we prefer showing all 6 days even at truncation.
- **Where:** `packages/core` SMS helpers, `packages/sms/src/scheduler.ts#sendWeeklyReceipts`.

## J4 — No-plucking vs empty plucking day
- **Choice:** A `day_no_plucking` event suppresses the daily Owner SMS; `day.plucking_set` with zero active workers is still a plucking day (present-with-zero).
- **Why:** Decision 15 vs Decision 5 — presence matters.

## J5 — Scheduler day-boundary
- **Choice:** `getWeekStartMonday` uses `Africa/Nairobi` date math, not UTC.
- **Why:** Week is Monday–Saturday EAT (Decision 4).

## J6 — Idempotency
- **Choice:** `job_key = farmId:date:type(:workerId)` with a partial unique index; duplicate inserts return `skipped` not error.
- **Why:** Decision 28 — restart must never double-send. Sync post-effects also use `job_key`.

## J7 — Cron secrecy in preview
- **Choice:** `CRON_SECRET` env var, `REQUIRED_CRON_SECRET=true` enforces it; without it we fail closed in prod (`NODE_ENV=production` + `VERCEL_ENV` checks).
- **Why:** Prevent open cron abuse in production; keep preview open for testing (configurable).

*Add new judgements here as we make them, one row each, not as prose.*
