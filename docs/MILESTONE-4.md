# Milestone 4 — Offline supervisor PWA (installable HTTPS preview + on-device test)

## Delivered
- **PWA app** `apps/supervisor-pwa` (React + Dexie/IndexedDB): Workers tab (register with consent checkbox + timestamp/author, fire/rehire inclusive periods), Daily tab (tap picker → kg input, present/A flag, NP for no-plucking, auto total KES, `Done for the day`, `Submit Saturday FINAL` only on Saturday EAT).
- **Offline-first:** kg edits stay in IndexedDB `daily` table only; **no outbox until `Done for the day`** — this prevents half-day sync near internet (Decision 2, J4). `Done` queues `pluck.logged` + `day.confirmed` + `day.plucking_set` (no-plucking) as a batch; `Submit Saturday FINAL` queues `week.submitted`. All go via `POST /api/sync/push` (append-only, idempotent by `event_id`).
- **Pending upload banner:** header shows `● N to sync · pending upload` when `db.outbox.count() > 0`; empty shows `✓ Up to date`. Unsynced Saturday shows `Saturday entry not received by server, please connect to sync.` (Decision 2).
- **Device fix:** `device_id` is `crypto.randomUUID()` stored in `localStorage` (not `""` — fixes `invalid input syntax uuid ""`).
- **Service worker** `public/sw.js` (cache-first for shell, no `/api/` caching), `manifest.webmanifest` (standalone, icons), registered in `main.tsx`. Installable on Android/Chrome.
- **HTTPS previews (Vercel):** PWA served from `apps/api/public` (built via `vite build` + `cp -r` in `vercel.json` `buildCommand`). Same-origin `/api` proxy (`vite.config.ts` `proxy: {"/api": "localhost:3000"}` in dev, Vercel rewrite to serverless `/api` in prod). No `localhost` in browser code.
- **Deploy:** `vercel.json` `outputDirectory: apps/api/public`, rewrites `/api/:path* → /api`, SPA fallback `/(.*) → /index.html`.

## Previews
- **PWA (installable):** `https://tea-farm-ledger.vercel.app/` — install via Chrome menu `Install app` / `Add to Home screen`. Offline after first load (service worker `tea-v1` cache).
- **API:** `https://tea-farm-ledger.vercel.app/api/health` (same origin, no localhost).
- **Admin web (M7 placeholder):** `https://tea-farm-ledger.vercel.app/admin` — returns 404 placeholder until M7; kept separate from PWA preview.
- **SMS mock log:** `GET /api/sms-log?farm_id=...` shows `body`, `segments`, `status=queued`, `provider_id=mock-…`, `job_key`.

## Real-device test script (supervisor phone, low-end Android Chrome)

Do this **once** at milestone 4; repeat after each deploy that touches offline.

### 1. Install
1. On the phone, open `https://tea-farm-ledger.vercel.app/` in Chrome (HTTPS, not http).
2. Chrome menu → `Install app` (or `Add to Home screen`) → `Install`. App icon `T` appears on home screen.
3. Open the installed app (standalone, no address bar). Verify header shows farm bar + `● Online` / `○ Offline`.

### 2. Create farm + workers (online)
1. Tap `+ New farm` (online) → note the generated `farm_id` in the header input.
2. Open `Workers` → `Add worker` → enter name `Kiptoo`, phone `07XX…` (normalized to `+254…`), tick consent, `Add worker`. Repeat for 2 more workers.
3. Verify `Workers` list shows 3 active with green `active` badge.

### 3. Log a full day offline (airplane mode ON)
1. Turn **airplane mode ON** (no Wi-Fi, no data). Header should show `○ Offline`.
2. `Today` date picker shows today EAT. Enter kg: tap `Kiptoo` → type `12.5`, tap `B` → `8`, leave `C` blank (present with no kg is allowed but counts as present). Do not tick `No plucking`.
3. Check `Today total` footer: `20.5 kg · 2 pickers` and `Est. pay` (9 KES/kg).
4. **Do not expect sync.** Header shows `○ Offline` but **no** `N to sync` yet — kg is local only until Done (half-day protection).
5. Tick one worker `Absent` → input disables, total updates.

### 4. Confirm the day (still offline)
1. Tap **`Done for the day`** (green). Expect `✓ Done — 20.5kg … queued. Auto-syncing…` then after 1.8s auto-roll to next day (`Tomorrow` date).
2. Header now shows `● 3 to sync · pending upload` (2 plucks + 1 `day.confirmed`). This is the pending-upload state.
3. Verify yesterday's data is still in phone: change date back to yesterday, see kg still there, `✓ Done` button disabled (`✓ Done — next day ready`).

### 5. Reconnect and verify sync
1. Turn airplane mode **OFF** (Wi-Fi/data on). Header flips to `● Online`.
2. Tap **`Sync now`** (or wait 1.2s auto-sync). Expect toast `Auto-synced ✓ 3 sent` and banner `✓ Up to date`.
3. In a laptop browser, `curl https://tea-farm-ledger.vercel.app/api/sync/pull?farm_id=<farm_id>&since=0` — verify `pluck.logged` and `day.confirmed` events are on server.
4. In the app, `GET /api/sms-log?farm_id=…` — Owner daily summary was sent (`job_key farmId:date:daily-owner`).

### 6. No-plucking day
1. Back in app, pick a date, tick `No plucking today`, enter reason `heavy rain`, `Done for the day`. Queues `day.plucking_set {is_plucking_day:false}` + Owner `no-plucking` SMS after sync.

### 7. Saturday FINAL (only on Saturday EAT)
1. Change device date to the nearest **Saturday** (or use `Selected date` picker to that Saturday).
2. `Submit Saturday FINAL` button becomes gold-bordered and enabled. Tap it → `Saturday FINAL sent — week Mon–Sat locked.`
3. `Sync now` → server `pay_weeks` status `locked`; further plucks for that week flagged `correction`.

### 8. Offline verification (Decision 1 revised)
- With airplane mode ON, add a 4th worker, log a day and `Done`. Worker shows `unverified` badge.
- After reconnect + sync, worker remains unverified until Owner/Admin enters verification code online. No receipt SMS is sent until verified (Decision 3).

If any step fails, note the `pending upload` count, `last_synced` time (in banner), and browser console `fetch` errors; file under `docs/MILESTONE-4.md` open questions.

## Running (no Docker, no WSL — hosted preview + embedded test DB)
```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
```
PWA dev (two terminals):
```powershell
# terminal 1: API (uses local Docker Postgres or PGlite fallback)
npm.cmd run dev:api
# terminal 2: PWA (HTTPS preview via vite, proxy /api → :3000)
npm.cmd --prefix apps/supervisor-pwa run dev
# open https://<preview>-5173.<sandbox>.e2b.app  (service worker needs HTTPS)
```
Prod preview:
```powershell
npx tsc --build
npx vite build apps/supervisor-pwa
Copy-Item -Recurse apps/supervisor-pwa/dist/* apps/api/public/ -Force
npm.cmd run dev:api  # serves PWA from /api/public
```

## Test counts
- **Core 31:** phone 8, money 6, settings 4, sms 4, week 2, validation 2, employment 5
- **Integration 7:** sync 4, workers 2, offline 1
- **New offline 7:** `tests/offline.test.ts` — outbox enqueue only on Done (not on kg keystroke), pending count before/after sync, no duplicate kg on multiple edits before Done, clear after sync, no-plucking queues correctly, Saturday FINAL only on Saturday, device_id UUID not empty
- **Total:** 44 + 1 integration = **45 tests** (was 38; +7 offline)
- Run `npm.cmd test` — all 45 pass on PGlite (`USE_PGLITE=true` ephemeral, labeled `DEMO DATA — ephemeral, resets on restart`).

## Deviations
- No Admin UI (M7 per plan).
- SMS jobs deferred to M5 (mock adapter default); M4 only wired daily side-effects already in `apps/api/src/routes/sync.ts` (M5 extended them).
- Payroll CSV/printable deferred to M6 (lock already enforced).
- On-device install test is **manual** per script above; automated Playwright PWA offline tests run in CI where `page.route` mocks `fetch`.

Tag: v0.4-m4
