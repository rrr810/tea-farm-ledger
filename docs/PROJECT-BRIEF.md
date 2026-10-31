# PROJECT BRIEF: TEA FARM PLUCKING LEDGER, PAYROLL SHEET AND SMS SYSTEM (PHASE 1)

> Note: where 02-DECISIONS.md conflicts with this brief, 02-DECISIONS.md wins. Items already patched here: acceptance criterion 1, removal of the "near end of period" anomaly, PDF export replaced by a print-friendly page, receipt format and reminder wording.

Read this ENTIRE brief before writing code. Do not skip, summarise away, or silently change any requirement. If something is ambiguous, record it in docs/DECISIONS.md with the safest choice and continue (see 03-STATUS-AND-WORKING-RULES.md). Where I mark [TO CONFIRM], build it as a configurable setting with the stated default.

## 1. CONTEXT
- Kenyan smallholder tea farm owned by an elderly retired teacher (the "Owner"). He hires local villagers (pluckers) who pick tea leaf Monday to Saturday depending on leaf availability. Saturday is a half day.
- A factory lorry collects the leaf. A supervisor records each plucker's kilograms daily in a paper book.
- Pluckers are paid weekly (Saturday afternoon) at a rate per kg (currently KES 9/kg, must be configurable). Example: 70 kg in the week x 9 = KES 630.
- Current problems:
  a) The Owner withdraws cash at a bank 30 km away each Saturday, but the week's kg total is not final when he goes, so he sometimes withdraws too little and must make a second trip. Fuel is expensive and he has spine/leg problems after surgery.
  b) Paper records get dirty or lost. There is no clean worker history, and workers are often hired, fired and rehired.
  c) Data bundles and wifi are costly and hard for the farm.
  d) Long term: worker payment must move to M-Pesa (Phase 2).
- The Owner does NOT go online. His side must work with SMS only (receiving messages). The supervisor has a phone and goes online sometimes (when he has signal). Phone model and Android version [TO CONFIRM]; assume low-end Android with Chrome.
- Timezone: Africa/Nairobi (EAT, UTC+3). Currency: KES. Weight: kg.
- Target: a working Phase 1 piloted on this real farm for at least 2 pay weeks (alongside the paper book) and presented in December 2026. The system may later serve many farms, so design data with a farm_id from day one.

## 2. SCOPE
### IN SCOPE (Phase 1): records, visibility and SMS. NO money movement.
- Offline-first supervisor app (PWA)
- Worker registry, hire/fire/rehire history, attendance
- Daily kg log with validation
- Sync to a server with an append-only audit trail
- SMS to Owner and workers via Africa's Talking
- Weekly payroll sheet (computed payout list) that the Owner uses to pay manually via his own M-Pesa
- Admin web dashboard with records, reports and graphs
- Import of historical records from CSV

### OUT OF SCOPE (Phase 2): do NOT implement, but leave clean hooks
- Automated M-Pesa payouts (provider TBD: Paystack Transfers or Safaricom Daraja B2C; design a provider adapter interface)
- Owner approving payouts by SMS reply ("YES") with a pre-approval cap (e.g. "pay Saturday up to KES 10,000")
- Payout reconciliation, retries, float-low alerts
- Bonuses, multi-farm billing, USSD
Hooks to include now: payouts table, payout reference format worker_id + week_id (for idempotency), inbound-SMS webhook route stub, provider adapter interface with a "manual" implementation.

## 3. USERS AND ROLES
- SUPERVISOR: uses the PWA. Logs kgs and attendance, registers workers, records hire/fire, confirms the day, submits the final Saturday entry. Works offline.
- OWNER: SMS only. Receives summaries. No login.
- ADMIN (the product developer): web dashboard. Sees everything, manages farms, users, settings, approves post-lock corrections, imports data.
- WORKER: never uses the system. Only receives SMS.
Permissions for hiring/firing [TO CONFIRM]: default = Supervisor can enter hire/termination, Owner is notified by SMS, Admin can override. Per-farm setting.

## 4. FUNCTIONAL REQUIREMENTS

### 4.1 Worker registry
- Fields: worker_id (UUID), farm_id, full_name, mobile number (normalise 07xx/01xx input to +2547xxxxxxxx / +2541xxxxxxxx), status, notes, created_at.
- Do NOT store national ID numbers or other unnecessary personal data.
- Phone verification: on registration send an SMS code to the number; the worker is "unverified" until the supervisor enters the code (needs internet at that moment; registration may happen offline and the verification SMS is queued for when online).
- A mobile number can belong to only ONE active worker. Block duplicates.
- Changing a worker's number requires re-verification and is logged; notify Admin/Owner (fraud risk).
- Record consent that the worker agreed to SMS receipts and storage of their name and number.

### 4.2 Hire / fire / rehire
- Model employment as EMPLOYMENT PERIODS: start_date, end_date (nullable), end_reason. Dates are inclusive.
- Firing closes the current period. Rehiring opens a NEW period on the SAME worker profile (never create a duplicate worker). Full history stays visible.
- Kgs cannot be logged for a worker with no active period on that date.
- A worker terminated mid-week is still paid for kgs already logged.

### 4.3 Daily log
- Per day: date, plucking_day flag. Provide a "No plucking today" switch with a reason (e.g. no ready leaf) so absence on those days is NOT counted against workers.
- Per active worker per plucking day: attendance (present/absent) and kgs. Present with 0 kg is allowed and distinct from absent.
- Entry UX: tap the worker, type kgs on a numeric keypad. Only active workers are listed.
- Store weights as integers in 100-gram units (0.1 kg precision).
- Validation: reject negatives; warn on implausible values using max_kg_per_worker_day [TO CONFIRM, default 60]; warn if a second entry is made for the same worker on the same day (offer to edit, never silently add).
- End-of-day confirmation screen: total kg and number of pickers, "Confirm?". Confirming marks the day confirmed and triggers the daily SMS to the Owner (queued if offline).
- Optional factory cross-check: supervisor can enter the factory's weighed total / slip number for the day. Flag if abs(factory total - worker sum) / factory total exceeds the tolerance [TO CONFIRM, default 5%]. If the factory total is zero or missing, skip the comparison; flag only if the worker sum is above zero.

### 4.4 Append-only event log (CORE DESIGN RULE)
- Every change is an immutable event: event_id (client-generated UUID v7), farm_id, device_id, author, event_type, payload, business_date, client_timestamp, server_received_at.
- NEVER overwrite or delete history. A correction is a new event referencing the one it corrects.
- Current state (tables/views) is derived from events.
- Sync must be idempotent: re-sending the same event_id has no effect.

### 4.5 Rates
- Rate per kg stored with an effective_from date (default KES 9). Pay for a pluck uses the rate in force on that pluck's date. A mid-week rate change must be handled correctly.
- Store money in integer minor units (cents).

### 4.6 Weekly payroll (computed, not paid)
- Pay week = Monday to Saturday. Pay day = Saturday afternoon (workers expect payment by about 3 pm). Rolling Saturday's kgs into next week is NOT acceptable.
- FRIDAY ESTIMATE: running total Monday to Friday and estimated pay, sent to the Owner by SMS at 17:00 EAT (configurable). Say clearly that Saturday will add more.
- The week is LOCKED when the supervisor submits the "Final Saturday entry". Send a reminder SMS to the supervisor if the server has not received it by 14:30 EAT (configurable).
- Pay calculation: per worker, sum (kg x rate in force on that date) with integer math, then round ONCE per worker per week to whole KES using round-half-up (configurable). The grand total is the sum of the rounded worker amounts. Document the rule and test it.
- Payroll sheet per worker: worker_id, name, masked mobile, days worked, total kg, rate (with kg per rate band and a clearly labelled weighted rate if the rate changed mid-week), amount. Totals row. The sum of rows must equal the grand total.
- Anomaly flags (flag only, never block): amount deviates from the worker's trailing 4 completed weeks' average by more than 50% [configurable] (with fewer than 2 prior weeks, skip and flag "limited history"); first week for a new worker; unverified number; present with 0 kg.
- Phase 1 payment is manual: the Owner pays from his own M-Pesa. Provide the sheet on screen, as CSV, and as a clean print-friendly page (the browser's "Save as PDF" is enough; do not build a PDF generator). Provide an optional "mark as paid" action recording the M-Pesa transaction code per worker (store it; Phase 2 reuses the field).
- Post-lock corrections: only Admin, with a reason, creating an ADJUSTMENT line applied to the NEXT week's payroll. Never edit locked history. Notify the Owner by SMS.

### 4.7 SMS (Africa's Talking)
Use Africa's Talking SMS API with a registered Sender ID (configurable) and sandbox mode for development; default to a mock adapter. Store every SMS with status from delivery-report callbacks. Log segments and estimated cost per farm per month.
Cost rules: GSM-7 characters ONLY (no emojis, curly quotes or accents), since Unicode drops segments to 70 characters. Single SMS = 160 chars; concatenated segments = 153 chars each. Cap the daily Owner SMS at 3 segments. The Owner requested every picker be retained in the message, so if real full names would exceed 3 parts, do not silently omit workers or spend a fourth unit: hold the full preview for explicit review.
Templates (English default, Kiswahili variants in a translation file):
1. DAILY to Owner, after the day is confirmed:
   Dear Peter Rugut,

   TEA FARM LEDGER
   Mon 19 Oct DAILY SUMMARY
   Rate: KES 9/kg

   NAME | KG | EST KES
   Jane | 45 | 405
   Peter | 52 | 468
   ...every recorded picker...
   --------------------
   TOTAL | 612 | 5,508

   Thank you.
   The rate applies to every row; the per-worker and total amounts are estimates only until the server receives the complete Saturday record.
2. FRIDAY ESTIMATE to Owner:
   TEA Fri 23Oct week so far 3980kg. Est pay KES 35820 (Mon-Fri). Sat adds more. Keep balance ready.
3. VERIFICATION to worker:
   Code 4821 to confirm your M-Pesa number for pay at [FARM_NAME]. Ignore if not you.
4. WEEKLY RECEIPT to each verified worker after the week is locked. Tokens: kg number if present (0 if present with zero), A for absent on a plucking day, NP for a no-plucking day. Must fit in 2 GSM-7 segments for a normal week:
   Wk43 Jane: Mon12 Tue14 Wed0 ThuA Fri14 SatNP = 40kg x KES9 = KES360. Wrong? Tell supervisor by Sun.
5. REMINDER to supervisor if the final Saturday entry is missing: "Saturday entry not received by server, please connect to sync."
6. NOTIFICATIONS to Owner for hire/termination and number changes.
7. NO-PLUCKING DAY to Owner: short message stating there was no plucking and the reason.
All message text is generated by the server from stored data. No hand-typed figures. Inbound SMS (replies) is Phase 2: only add a stubbed webhook route. No receipt SMS is sent to an unverified number.

### 4.8 Offline-first supervisor PWA
- Installable PWA (manifest, icon, service worker). All supervisor features work fully offline: registering workers, logging, confirming the day, submitting the final Saturday entry. Verification of a number completes only after the phone is online and the code is entered.
- Local storage in IndexedDB. An outbox queue holds unsent events and syncs automatically when connectivity returns (background sync where supported, plus a visible "Sync now" button, "Last synced" time and pending-count indicator). An offline-submitted Saturday that has not synced shows "pending upload".
- Sync protocol: push events (idempotent by event_id), then pull changes since a cursor. Resumable if interrupted. Payloads small (data is expensive): no images, minimal JSON, compressed.
- Auth: Admin-issued device enrolment while online, supervisor PIN to unlock offline, Admin can reset a PIN and revoke a lost device.
- Low-end phone friendly: large tap targets, numeric keypad inputs, high contrast readable in sunlight, minimal text, fewest possible screens. English with Kiswahili labels available.

### 4.9 Admin web dashboard (online)
- Admin login (password, secure sessions, role checks; MFA optional and deferred). Farm settings: rate (with effective dates), thresholds, SMS language, Owner number, supervisor accounts, cutoff times.
- Views: worker list with full employment history; daily and weekly logs; attendance; payroll sheets with flags; SMS log with delivery status and costs; audit log; unresolved conflicts and correction requests.
- REPORTS: monthly and rolling 3-month views with graphs: total kg by month, active versus idle months, payroll totals, per-worker kg and attendance. Active month = at least one plucking-day entry; idle month = employed for some or all of the month with no attended plucking day.
- "Hardest-working" ranking per quarter showing three measures together: total kg, average kg per attended plucking day, attendance rate (counted only on plucking days during active employment). Rankings only; do NOT compute bonuses. Note that kg does not reflect leaf quality.
- CSV exports. Historical CSV import (old paper records) with a canonical template, validation, and a preview before committing; duplicates are rejected for explicit resolution.

## 5. NON-FUNCTIONAL REQUIREMENTS
- Offline-first, tolerant of slow and intermittent networks.
- Security and privacy (Kenya Data Protection Act): collect minimum data, record consent, role-based access, HTTPS, encryption at rest for the database, secrets only via environment variables, audit trail, basic rate limiting, ability to export or anonymise a worker's data on request while preserving financial audit integrity.
- Multi-tenant ready: farm_id on all tables.
- Reliability: no double-counting from retries, no lost entries when the phone dies mid-sync. Scheduled jobs idempotent so a restart never double-sends an SMS.
- Observability: structured logs, error tracking hook.

## 6. SUGGESTED ARCHITECTURE (approved)
- Supervisor PWA: React + TypeScript, IndexedDB via Dexie, Workbox/service worker.
- Admin dashboard: React + TypeScript.
- Backend: Node.js + TypeScript, Fastify REST, PostgreSQL with migrations, idempotent POST /sync, job scheduler (cron set explicitly to Africa/Nairobi) for Friday estimate and Saturday reminder, Africa's Talking adapter isolated from formatting and business logic, Docker deployment to a small VPS.
- Shared pure business core (pay calculation, validation, SMS formatting, GSM-7 checks, phone normalisation) used by both client and server so the offline estimate and the server result cannot disagree.
- Monorepo layout: apps/{supervisor-pwa,admin-web,api}, packages/{core,database,sms,config}, tests/{unit,sync,offline,integration,fixtures}, docs/.

## 7. DATA MODEL (outline; refine it)
farms, users (admin/supervisor), devices, workers, employment_periods, plucking_days (date, is_plucking_day, reason, confirmed, locked), pluck_entries (worker, date, attendance, kg_units), factory_slips, rates (effective_from), events (append-only), pay_weeks (start, end, status, locked_at), payroll_lines (worker, week, kg_units, rate snapshot, amount, flags), adjustments, payments (manual in Phase 1: mpesa_code, paid_at, reference = worker_id + week_id), sms_messages (type, to, body, segments, status, cost, provider_id), settings, audit_log.

## 8. EDGE CASES TO HANDLE AND TEST
- Worker hired, fired and rehired in the same month.
- Worker fired mid-week still gets paid for logged kgs.
- No-plucking days must not count as absences.
- Rate change mid-week.
- Duplicate sync, out-of-order sync, partial sync, supervisor phone replaced.
- Two devices editing the same day: never silent last-write-wins; surface the conflict, and resolution is a new event.
- Entry made offline for a date after the week has locked on the server: stored and flagged as a correction request, never silently applied.
- Saturday final entry never synced: reminders, and the Owner/Admin still sees a clearly labelled "incomplete" week.
- SMS fails or is delayed: retry with backoff, show status, never block data entry.
- A number reused by a different worker only after the previous holder is inactive, with verification and an Admin notification.

## 9. ACCEPTANCE CRITERIA FOR THE DECEMBER DEMO
1. With airplane mode ON the supervisor can register a worker, log a full day and confirm it; verification completes after reconnecting.
2. On reconnect the data syncs with no duplicates and the Owner receives the daily SMS.
3. Friday estimate SMS is sent automatically.
4. Final Saturday submit locks the week and produces a correct payroll sheet with totals that reconcile.
5. Weekly receipt SMS goes to each verified worker.
6. Hire, fire and rehire preserve full history on one profile.
7. Dashboard shows monthly graphs, attendance, and the quarterly hardest-working ranking from imported plus live data.
8. Audit log shows every change with author and time.
9. All tests in section 11 pass.

## 10. PHASE 2 PREVIEW (design hooks only)
Weekly flow later: Friday the Owner pre-approves by SMS ("YES, pay Saturday, up to KES 10,000"); when the supervisor submits the final Saturday entry the system checks the total against the cap, runs the anomaly checks, pays clean lines via M-Pesa within minutes (flagged lines held for review), records each M-Pesa receipt code, retries failures, and sends a summary SMS. Payment references are unique per worker per week so retries can never double-pay.

## 11. TESTING REQUIREMENTS
- Unit tests: pay calculation, rounding, rate-effective-date logic, GSM-7 validation and segment counting, validation rules, phone normalisation.
- Sync tests: idempotency, ordering, resume after interruption, conflict surfacing.
- Offline tests: full supervisor workflow without network.
- Integration tests against a real test PostgreSQL database; SMS tests against the mock adapter and mocked delivery callbacks; scheduler tests.
- A seed dataset of 15 workers over 8 weeks including a rehire, a no-plucking day, a rate change and a mid-week firing, used by the tests and the demo.
- A manual pilot checklist for the 2-week farm trial.

## 12. CONFIGURABLE DEFAULTS
rate (KES 9/kg), max_kg_per_worker_day (60 kg), factory tolerance (5%), anomaly deviation (50%), Friday estimate time (17:00 EAT), Saturday reminder time (14:30 EAT), SMS language per farm (English), hire/fire permissions (supervisor enabled), supervisor phone model/Android version (unknown).
