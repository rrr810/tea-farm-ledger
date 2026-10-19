# Milestone 3 — Worker lifecycle and rules

## Delivered
- `packages/core/employment.ts`: inclusive periods, hire/fire/rehire logic, phone reuse check (Decision 17,19)
- `packages/database/workers.ts`: createWorker (normalizes 07→+254, blocks active phone holder), listWorkers, startEmployment/endEmployment with inclusive checks, listEmployment
- `apps/api/routes/workers.ts`: POST/GET /api/farms/:farmId/workers, POST /api/workers/:id/hire, fire, employment list — consent required (Decision 18)
- Pay calculation in core shared (per-date rate, integer tenths * cents, one half-up rounding per worker/week, grand total sum, weighted bands — Decision 7,8) already tested
- PWA 2 sections (m4 preview started in m4 branch): Workers tab (register with consent checkbox + timestamp/author, fire/rehire inclusive) + Daily tab (click Kiptoo → 40kg, present/A flag, NP for no-plucking, auto total KES, Confirm day, Final Saturday pending upload)

## Run
```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
```

## Test counts
- 38 tests: core 26 (phone 8, money 6, settings 4, sms 4, week 2, validation 2, employment 5) + integration 6 (sync 4, workers 2, offline 1)
- Payroll edge cases covered in money.test.ts (mid-week rate, rounding)

## Deviations
- No Admin UI yet (M7 per plan)
- SMS jobs deferred to M5 (mock adapter default)
- Payroll CSV/printable deferred to M6 (lock already enforced)

Tag: v0.3-m3
