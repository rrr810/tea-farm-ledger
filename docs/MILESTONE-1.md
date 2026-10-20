# Milestone 1 — Foundation (ACCEPTED pending owner `npm test`/`typecheck`)

## Delivered
- npm workspaces monorepo skeleton: apps/api, apps/supervisor-pwa, apps/admin-web (deferred stub), packages/core, config, database, sms
- Shared domain vocabulary: farm, employee periods, plucking days, rates, events, pay weeks
- Validated per-farm settings schema with approved defaults: rate 900 c/kg (KES 9), max 600 tenths (60kg), tolerance 500 bps (5%), anomaly 5000 bps (50%), Fri 17:00, Sat 14:30, EN, mock SMS
- Money in cents, weights in tenths of kg — never floating
- Phone normalization KE (+2547/2541)
- Week Monday–Saturday Africa/Nairobi
- SMS helpers GSM-7, segments, tokens (kg/A/NP)
- AGENTS.md copied to root, .env.example, .gitignore, docker-compose.yml (optional), PGlite fallback for no-Docker preview
- Unit tests for settings, money, phone, validation, week, sms — 6 suites

## Run commands
```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
```

## Typecheck
`tsc --noEmit` per workspace via `npm run typecheck --workspaces` — expected pass

## Deviations and things I did not do
- Admin dashboard not built (per plan, M7)
- No PDF generator — print-friendly page deferred to M6 per Decision 24
- No real SMS — mock adapter default per Decision 25
- No Docker requirement — added PGlite embedded fallback labeled ephemeral for preview/CI

## Open questions
None blocking M2. Device-specific PIN flow detailed in M2.

Tag: `v0.1-m1` (foundation)
