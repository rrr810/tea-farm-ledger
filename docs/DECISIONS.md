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

## J8 — Anomaly baseline computed from events
- **Choice:** The trailing-4-week baseline (APPROVED decision 11) is computed from the append-only events plus that week's `adjustments`, using the shared core path (`rateForDate` + `calculateWorkerWeekPayCents`) — never a duplicated formula. `payroll_lines` is kept as the persisted record for admin monthly reports only.
- **Why:** The previous code read `payroll_lines` first and silently skipped computation when none existed (cold start, first view, seeded demo) — so every worker was permanently flagged "limited history" and the >50% deviation check never ran. Events are the stable source: locked weeks can only gain correction-flagged rows, which are excluded. Weeks with no entries are excluded from the baseline (decision 11).
- **Alternative considered:** Lazily back-fill `payroll_lines` before computing flags — rejected because stored lines cannot distinguish "no entries" weeks from present-with-zero-kg weeks, breaking decision 11's exclusion rule.
- **Where:** `packages/database/src/payroll.ts#getPayrollData` prior-week loop; regression tests `tests/anomaly-baseline.test.ts`.

## J9 — Correction-flagged events are never applied to derived state
- **Choice:** Every state-deriving query over `pluck.logged` (payroll sheet, SMS figures, admin reports/rankings) filters `correction_flag = false`. Ingest-side checks (same-day conflict detection, CSV import duplicate check) still see all events.
- **Why:** APPROVED decision 2 says late events for a locked week are kept and flagged as correction requests and only applied as adjustments to the next week. The queries previously ignored the flag, so a late entry would be silently applied to the locked week's sheet and SMS — and the first view would freeze it into `payroll_lines`.
- **Where:** `packages/database/src/payroll.ts`, `packages/sms/src/scheduler.ts` (6 queries), `apps/api/src/routes/admin.ts` (3 report queries).

## J10 — Production detection on Vercel vs VPS
- **Choice:** `isProduction()` = `VERCEL_ENV === "production"` when `VERCEL_ENV` is set (Vercel), else `NODE_ENV === "production"` (VPS/Docker). Production still refuses PGlite; staging/preview deployments run the documented ephemeral demo.
- **Why:** Vercel sets `NODE_ENV=production` on every deployment — including staging/preview demos — so the old `NODE_ENV || VERCEL_ENV` check refused PGlite everywhere and the README's demo path could never work. `VERCEL_ENV` is Vercel's accurate environment signal.
- **Where:** `packages/database/src/db.ts#isProduction`.

## J11 — Private worker identity records
- **Choice:** The owner explicitly approved collecting a national ID number and an optional ID-card image for a worker profile. The supervisor records separate identity-storage consent; only the signed-in Admin for that same farm can view the unmasked number or image.
- **Why:** The farm now needs a fuller personnel record while preserving the simple supervisor workflow and gradual completion of existing workers.
- **Controls:** Identity values and photo bytes are AES-256-GCM encrypted before database storage; they are absent from the normal worker table response, PWA IndexedDB/outbox, event log, SMS, CSV export and audit detail. Every profile/image view is audit-logged. Photo intake is online-only and capped to a verified 1.25 MB JPEG/PNG/WebP payload.
- **Where:** `packages/database/src/worker-identity.ts`, migration `002_private_worker_identity.sql`, `apps/api/src/routes/workers.ts`, and the Supervisor/Admin worker views.
- **Alternatives rejected:** plaintext columns on `workers` (easy accidental leakage through `SELECT *`), public/static image URLs, and storing an ID image in the offline PWA queue.

## Open question
- **Unresolved same-worker/same-day conflicts are counted twice in derivation.** Per decision 20 conflicts are surfaced and resolved by a new event; until resolution, both entries currently sum into the sheet. Rare in Phase 1 (one supervisor device; the PWA edits rather than duplicates), but worth an explicit rule before the December demo: last-entry-wins for display, or exclude the conflict-flagged one?
