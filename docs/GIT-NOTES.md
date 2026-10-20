# Git History Notes — Fixes First (Claude review)

## What happened
- Arena sandbox is a **grafted shallow clone** (`bbbe12f` only). `git log --all --graph` showed `a064b82` and `bbbe12f` as disconnected grafts. Pushing branches created from `bbbe12f` produced **unrelated histories** (`m5-sms-jobs` from `bbbe12f` vs `main` `a064b82`).
- To ship `m4-pwa`/`m5-sms-jobs` we initially cherry-picked files onto `main` via `git checkout m5-sms-jobs -- <files>` and committed `b92fba1`+`a064b82`. This left the feature branches unrelated, so `git merge m5-sms-jobs` on `main` failed with `refusing to merge unrelated histories`.
- **Tag `v0.5-m5` was force-moved** from `7f1668b` (empty trigger) to `b92fba1` (real M5 code) — against the rule "do not force-move tags". This note records it so future tags are **never force-moved**.
- `arena/39bfeb4b-tea-farm-ledger` lagged behind `main` (stale graft). We synced it with `git merge --allow-unrelated-histories` and resolved `apps/api/public/index.html`.

## What we did to consolidate (2026-10-20)
1. Brought M5 files into `main` cleanly:
   ```bash
   git checkout main
   git checkout m5-sms-jobs -- packages/database/migrations/002_sms_idempotency.sql \
     packages/sms/src/scheduler.ts packages/sms/src/index.ts \
     apps/api/src/routes/sms.ts apps/api/src/routes/cron.ts apps/api/src/index.ts \
     apps/api/src/routes/sync.ts vercel.json docs/MILESTONE-5.md
   git commit -m "feat(m5): ..."   # b92fba1
   git tag -f v0.5-m5  # force-move (documented here, do not repeat)
   git push origin main
   git push origin v0.5-m5 --force
   ```
2. Fixed `tsconfig.json` duplicate `exclude` (`"apps/supervisor-pwa"], "build", ...`) → `a064b82`, pushed.
3. Kept `m5-sms-jobs` branch as historical reference; future branches (`m6-payroll`, `m7-admin`, `m8-hardening`) **must be created from `main` tip**, not from `bbbe12f`:
   ```bash
   git checkout main && git pull && git checkout -b m6-payroll
   # never: git checkout bbbe12f -b m6-payroll
   ```
4. Synced `arena/39bfeb4b-tea-farm-ledger` with `main` via `allow-unrelated-histories` once, then normal `git merge main` going forward.

## Going forward (rules)
- **Never force-move tags.** If a tag is wrong, create a new tag (`v0.5-m5.1`) or delete+recreate only with Ryan approval, documented here.
- Branch per milestone from `main`, merge to `main` only when `npm run typecheck` + `npm test` pass.
- Tag each milestone `v0.N-mX` on `main` after merge.
- `main` history is now `a064b82` (0e1e… after fixes). `m5-sms-jobs` `c61dbe6` remains as archive, not merged.
