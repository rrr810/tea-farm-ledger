# Tea Farm Plucking Ledger — Phase 1

Kenyan smallholder tea farm ledger: offline-first supervisor PWA, SMS to Owner/workers via Africa's Talking (mock by default), Admin dashboard (M7). No money movement in Phase 1.

## Quick start — Windows PowerShell

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run dev:api   # starts Fastify on http://localhost:3000 — no Docker required (uses USE_PGLITE=true fallback)
```

If you have Docker:

```powershell
docker compose up -d db
npm.cmd run migrate
npm.cmd run dev:api
```

## Stack

TypeScript monorepo · npm workspaces · React + Dexie/IndexedDB · Fastify · PostgreSQL (or PGlite embedded fallback) · Vitest · Playwright · shared @tea-ledger/core

## Previews (no ZIP needed)

- `main` → production preview (Vercel, HTTPS, same-origin `/api` proxy)
- Branch previews: `m4-pwa`, `m5-sms-jobs`, `m6-payroll`, `m7-admin`, `m8-hardening`
- All previews use **ephemeral demo data** banner unless connected to a persistent Postgres URL. No real SMS sent (mock adapter).

See `docs/MILESTONE-1.md`, `docs/MILESTONE-2.md`, `docs/TEST-PLAN.md`, `docs/DECISIONS.md`.

## Decisions

Authoritative list in `docs/DECISIONS.md` (28 decisions). `docs/PROJECT-BRIEF.md` is the brief; on conflict, `DECISIONS.md` wins.

## Timezone

All business dates are `Africa/Nairobi` (EAT, UTC+3). Week = Monday to Saturday.
