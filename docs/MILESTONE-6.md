# Milestone 6 — Payroll, Saturday lock, correction requests, next-week adjustments + printable/CSV

## Delivered
- **Payroll engine** (`packages/core/src/payroll.ts`): pure functions `computePayrollLine`, `computePayrollSheet`, `payrollToCsv`, `payrollToPrintableHtml`. Rules: rate effective per plucking date (integer tenths × cents → one half-up rounding per worker/week, grand total = sum of rounded), weighted rate per band, integer arithmetic, inclusive employment periods (hire/fire/rehire), present-with-zero vs absent vs NP, unverified flag, anomaly flag (>50% vs trailing 4-week avg, limited history if <2 prior weeks), first-week flag, factory tolerance flag.
- **DB payroll** (`packages/database/src/payroll.ts`): `getPayrollData` gathers workers + employment periods, `pluck.logged` events, `plucking_days`, `rates`, `adjustments` (applied to week), `pay_weeks` lock status, prior 4 locked weeks amounts for anomaly, first-week detection. `createAdjustment` inserts adjustment for **next week** (correctionWeekStart +7d) with audit log and Owner SMS notify, `savePayrollLines` persists.
- **API** (`apps/api/src/routes/payroll.ts`):
  - `GET /api/farms/:farmId/payroll/:weekStart?format=json|csv|html&factory_total=` — computes sheet, flags tolerance if given, returns JSON or CSV (`text/csv` attachment) or printable HTML (`?format=html` with @media print + grand totals + Download CSV button).
  - `GET /api/farms/:farmId/payroll` — list `pay_weeks` locked/open/incomplete.
  - `POST /api/farms/:farmId/adjustments` — Admin only (logical), creates adjustment applied to next week; rejects if correction week not locked (server-authoritative lock).
  - `GET /api/farms/:farmId/adjustments?week_start=` — list adjustments.
  - `GET /api/farms/:farmId/correction-requests` — events with `correction_flag=true` (late events for locked week).
  - `POST /api/farms/:farmId/rates` & `GET .../rates` — set/list rate per effective_from date.
- **Saturday lock**: `week.submitted` event (from PWA Saturday FINAL) inserts `pay_weeks` locked; `pushEvents` flags late events as `correction_flag=true`; payroll `status` is `locked`/`open`/`incomplete` (incomplete = Sat passed but not locked).
- **Next-week adjustment flow**: late kg for locked week → Admin `POST /adjustments {worker_id, correction_week_start, kg_units, rate_cents_per_kg, reason}` → row in `adjustments` with `week_start = correctionWeekStart+7d` → next week's payroll includes it as extra amount with `adjustments` array and `adjustmentAmountKes` shown in sheet.
- **Printable page**: `payrollToPrintableHtml` is print-friendly (browser Save as PDF, no PDF generator per Decision 24), shows farm name, week Mon–Sat, locked badge, per-worker days/kg/rate (with band breakdown if changed mid-week), amount, flags, totals row, adjustments, generation time. Served at `GET .../payroll/:weekStart?format=html`.
- **CSV export**: `payrollToCsv` header `worker_id,name,phone_masked,days_worked,attendance_rate,total_kg,rate_kes_per_kg,amount_kes,flags,adjustments_kes,verified` + totals row; served at `?format=csv`.

## Running
```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test   # 56 tests: core 31 + payroll 4 + integration sync 4 + offline 8 + scheduler 6 + workers 2
```
Payroll example (after farm + workers + plucks + week.submitted):
```powershell
# List weeks
curl http://localhost:3000/api/farms/<farmId>/payroll
# Sheet JSON
curl http://localhost:3000/api/farms/<farmId>/payroll/2026-11-23
# Printable
curl http://localhost:3000/api/farms/<farmId>/payroll/2026-11-23?format=html > payroll.html
# CSV
curl http://localhost:3000/api/farms/<farmId>/payroll/2026-11-23?format=csv -o payroll.csv
# Correction
curl -X POST http://localhost:3000/api/farms/<farmId>/adjustments -H "Content-Type: application/json" -d '{"worker_id":"...","correction_week_start":"2026-11-23","kg_units":50,"reason":"missed 5kg"}'
```

## Test counts
- **56 tests** on PGlite: core 31 (phone 8, money 6, settings 4, sms 4, week 2, validation 2, employment 5) + payroll 4 (simple week, mid-week rate weighted, Saturday lock + correction→adjustment→next-week, anomaly/limited-history) + integration 7 (sync 4, workers 2, offline 8? actually 8 now) + scheduler 6 → total 56. Run `npm test` → 56 passed.

## Deviations
- No Admin UI for payroll yet (M7); API is ready and manual CSV/HTML works via curl/browser.
- Anomaly baseline uses `payroll_lines` persisted amounts; if no prior locked weeks, flags `limited history` (per Decision 11).
- Adjustment notification SMS uses mock adapter in preview; live AT in prod (mock default).
- Payments table `mark as paid` not yet wired to payroll (M7 Admin will add).

Tag: v0.6-m6
