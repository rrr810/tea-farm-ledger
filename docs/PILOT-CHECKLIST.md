# Pilot Checklist — 2-Week Farm Trial (Mon 2026-11-23 → Sat 2026-12-05, alongside paper book)

Owner: elderly retired teacher, SMS only. Supervisor: low-end Android Chrome, offline. Admin: developer. Week Mon–Sat, pay Sat ~15:00 EAT. Paper book stays source of truth for first 2 pay weeks; system presented December 2026.

## Before Week 1 (by 2026-11-20)
- [ ] VPS provisioned per DEPLOYMENT.md, HTTPS + domain, env set (`DATABASE_URL`, `SESSION_SECRET`, `ADMIN_DEFAULT_PASSWORD`, `CRON_SECRET`, `REQUIRED_CRON_SECRET=true`, `SMS_PROVIDER=mock` for pilot; AT sandbox if owner provides).
- [ ] Daily backup cron installed and verified (`scripts/backup.sh` → `/var/backups/tea-ledger/YYYY-MM-DD.sql.gz`, retention 30d). Restore drill done on staging.
- [ ] Farm created: `POST /api/farms {name}` → note `farm_id`. Rates seeded default 900 (9 KES/kg). Owner/supervisor phones set via `PUT /api/farms/:farmId/settings {ownerPhone, supervisorPhone}` (E.164 +2547…).
- [ ] Sedeed demo dataset verified (15 workers, 8 weeks, rehire, no-plucking, rate change 2026-11-16, mid-week fire) via `npx tsx scripts/seed-demo.ts` on staging; payroll walkthrough printed and hand-checked vs app.
- [ ] Workers registered with consent (phone normalization 07→+254, verification SMS queued when online, unverified warning only not payment block).
- [ ] Supervisor phone: Chrome installed, PWA at `https://tea.example.com/` → `Install app` to home screen, `○ Offline` / `● Online` banner, `Pending upload` / `✓ Up to date` tested with airplane mode.
- [ ] Admin at `https://tea.example.com/admin` → login, check Dashboard, Workers, Payroll weeks, SMS log, Reports, Import, Audit.
- [ ] Owner SMS: daily summary addressed to Peter Rugut with every recorded picker in an alphabetical `NAME | KG | EST KES` table (≤3 GSM-7 parts; preview instead of sending if it would exceed the cap), Friday 17:00 estimate, no-plucking, Saturday reminder 14:30, weekly receipt tokens (≤2 segments, GSM-7) — all mocked in pilot, verify `GET /api/sms-log?farm_id=…` segments/status.

## Weekly Flow (repeat both weeks)

### Daily (Mon–Sat)
- [ ] Supervisor logs kg per active worker (tap → numeric keypad, 0.1kg precision, present-with-0kg allowed, absent checkbox, "No plucking today" switch with reason not counted as absence).
- [ ] End-of-day → `Confirm` → day confirmed `day.confirmed` event, plucking_days updated, daily SMS to Owner queued (auto-sync when near internet; no half-day sends near internet).
- [ ] Check `Last synced` time + pending count in PWA header.
- [ ] Admin (evening): check `/api/farms/:farmId/payroll/:weekStart` open status, daily logs, audit log.

### Friday
- [ ] 17:00 EAT Friday estimate auto-sent (or via `GET /api/cron/friday-estimate?farm_id=…`), Owner confirms cash balance (bank 30km away, spine/leg issues — avoid second trip).

### Saturday
- [ ] Supervisor submits `Submit Saturday FINAL` (only Sat EAT) → `week.submitted`, week LOCKED (`pay_weeks` locked). Reminder SMS at 14:30 if not received (wording: "Saturday entry not received by server, please connect to sync.").
- [ ] Payroll sheet generated: per worker kg, rate (kg per band + weighted if mid-week change), amount rounded once per worker/week half-up, grand total sum of rounded, flags (anomaly vs 4-week avg >50%, limited history if <2 prior, first week, unverified, present-with-zero), factory tolerance flag if factory slip entered.
- [ ] Owner pays manually via own M-Pesa, uses printable sheet (browser Print → Save as PDF) + CSV. `mark as paid` optional records mpesa_code per worker (stored, Phase 2 hook).

### Post-lock (next week)
- [ ] Late events for locked week stored flagged as correction request (server authoritative lock, only Admin applies as adjustment to next week, never edit locked history, notify Owner SMS).
- [ ] Conflicts (same worker/same day) surfaced in Admin, resolution is new event, never silent last-write-wins.

## Paper Comparison (both weeks)
- [ ] Compare paper kg total vs app total per day; flag if `abs(factory - worker sum)/factory >5%` (tolerance, skip if factory zero/missing).
- [ ] Compare payroll totals vs paper manual calc per worker (hand-check rate change week).
- [ ] Note discrepancies in Admin audit log + correction requests.

## After 2 Weeks
- [ ] Admin Reports: monthly kg, payroll totals, active/idle months, hardest-working quarterly ranking (total kg, avg kg/day, attendance rate on plucking days) — rankings only, kg not leaf quality.
- [ ] Export CSVs, verify totals reconcile.
- [ ] Owner interview: was Friday estimate accurate enough to avoid second bank trip? Was SMS wording clear?
- [ ] Supervisor interview: was PWA usable offline on low-end phone in sunlight? Was enrollment/PIN flow clear?
- [ ] File pilot findings under `docs/MILESTONE-8.md` open questions before December demo.

## Emergency
- Backup/restore per BACKUP-RESTORE.md. Contact Admin if SMS not received (check `/api/sms-log`, segments, cost_estimate_cents).
