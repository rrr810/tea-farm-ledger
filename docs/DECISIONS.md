# APPROVED DECISIONS AND PLAN CHANGES

Authoritative. Where this conflicts with 01-PROJECT-BRIEF.md, this file wins. Anything not mentioned: accept the AI's earlier proposal from its planning reply (milestone 0.1).

## Decisions
1. OFFLINE VERIFICATION: Offline, the supervisor can register a worker, queue the verification SMS, log kgs, confirm the day and submit the final Saturday entry. Verification completes only after the phone is online and the code is entered. Revised acceptance criterion 1: "With airplane mode ON the supervisor can register a worker, log a full day and confirm it; verification completes after reconnecting."
2. LOCK STATE: Server is authoritative. Late events for a locked week are kept and flagged as correction requests; only Admin applies them, as an adjustment to next week. An offline-submitted Saturday that has not synced must show "pending upload" on the phone. The reminder SMS wording must say: "Saturday entry not received by server, please connect to sync."
3. UNVERIFIED NUMBER: warning only, not a payment block. No receipt SMS until verified.
4. WEEK: Monday to Saturday, Africa/Nairobi, business dates.
5. DAYS WORKED / ATTENDANCE: days worked counts days marked present (including present-with-zero-kg); the attendance-rate denominator counts plucking days during the worker's active employment period, not no-plucking days.
6. WEEKLY RECEIPT: compact tokens: kg number if present (0 if present with zero), "A" for absent on a plucking day, "NP" for a no-plucking day. Must fit in 2 GSM-7 segments for a normal week.
7. MID-WEEK RATE CHANGE: show kg per rate band and a clearly labelled weighted rate; calculation always uses the rate in force per date.
8. ROUNDING: round once per worker per week, half-up to whole KES; grand total is the sum of rounded worker amounts.
9. FACTORY TOLERANCE: flag if abs(factory total - worker sum) / factory total > tolerance. If the factory total is zero or missing, skip the comparison; flag only if the worker sum is above zero.
10. "NEAR END OF A PERIOD" ANOMALY: removed from Phase 1.
11. ANOMALY BASELINE: compare the current worker-week amount with the average of the worker's previous four completed payroll weeks (excluding weeks with no employment or no entries); with fewer than 2 prior weeks, skip the comparison and flag "limited history".
12. ACTIVE/IDLE MONTHS: active = at least one plucking-day entry for the worker in the month; idle = employed for some or all of the month but no attended plucking day.
13. DAILY SMS LINE ORDER: highest kg first, then "+N more, see weekly".
14. FRIDAY ESTIMATE: 17:00 EAT, configurable.
15. NO-PLUCKING DAY: send the Owner a short SMS stating there was no plucking and the reason.
16. SUPERVISOR REMINDER: sent to the configured supervisor number at 14:30 EAT if the server has not received the final Saturday entry (an unsynced offline submission still counts as not received).
17. NUMBER REUSE: allowed for a different worker only after the previous holder is inactive, with verification, full history, and an Admin notification.
18. CONSENT: supervisor-recorded checkbox with timestamp, author and worker profile is enough for the pilot.
19. EMPLOYMENT DATES: inclusive; firing closes the period on the chosen end date; rehiring opens a new period on the same profile.
20. CONFLICTS: never silent last-write-wins. Surface unresolved same-worker/same-day conflicts in the Admin dashboard; resolution is a new event. Phase 1 normally has one supervisor device, so keep the UI minimal.
21. DEVICE ENROLMENT: Admin-issued enrolment while online, PIN unlock offline, Admin can reset the PIN and revoke a device.
22. ADMIN AUTH: password with secure sessions and role checks. MFA is optional and deferred.
23. CSV IMPORT: canonical template, preview before commit, duplicates rejected for explicit resolution.
24. PDF: do not build a PDF generator. Provide a clean print-friendly payroll page (browser "Save as PDF") plus CSV export.
25. AFRICA'S TALKING: follow their official docs. Default to a mock adapter and sandbox; the owner will provide live credentials and Sender ID later.
26. DEVICE: baseline is low-end Android with Chrome. The real supervisor phone is not yet known. Plan an on-device install, offline and sync test at milestone 4.
27. HOSTING: Docker on a small VPS, provider chosen later. Include daily automated PostgreSQL backups with a documented restore procedure, HTTPS and domain setup steps.
28. SCHEDULER: set cron explicitly to Africa/Nairobi, and make jobs idempotent so a server restart never double-sends an SMS.

## Plan changes
- Milestone order: 1 Foundation, 2 Events and sync, 3 Worker lifecycle and rules, 4 Offline supervisor PWA (with on-device test), 5 SMS and scheduled jobs (daily summary, Friday estimate, reminders, verification), 6 Payroll, lock and corrections, 7 Admin dashboard, reports and import, 8 Hardening and pilot package.
- Pull the pure pay calculation (per-date rates, integer math, one half-up rounding per worker per week) and its tests into Milestone 3, so the PWA computes offline estimates with the same code as the server.
- Priority: the first pilot week starts Monday 23 November 2026. Milestones 1 to 6 must be deployable by then. If anything must slip, slip dashboard polish and graphs, not the supervisor flow, sync, SMS or payroll.
- Keep the supervisor PWA simple: fewest screens possible.
