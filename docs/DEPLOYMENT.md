# Deployment Guide — Docker VPS + Vercel alternative

## Option A: Small VPS (recommended for pilot, Decision 27)

### 1. Provision
- Ubuntu 22.04 LTS, 1 vCPU, 2GB RAM, 20GB disk. Open ports 22, 80, 443.
- Point domain `tea.example.com` (or IP) to VPS.

### 2. Install
```bash
sudo apt update && sudo apt install -y docker.io docker-compose git nginx certbot python3-certbot-nginx
git clone https://github.com/rrr810/tea-farm-ledger.git /opt/tea-ledger
cd /opt/tea-ledger
cp .env.example .env
# Edit .env: DATABASE_URL=postgresql://tea_ledger:STRONGPASS@db:5432/tea_ledger
#            SESSION_SECRET=$(openssl rand -hex 32)
#            ADMIN_DEFAULT_PASSWORD=$(openssl rand -base64 16)
#            CRON_SECRET=$(openssl rand -hex 32)
#            REQUIRED_CRON_SECRET=true
#            SMS_PROVIDER=mock (pilot) or africastalking
#            AT_API_KEY, AT_USERNAME, AT_SENDER_ID when live
sudo docker compose up -d db
npm install
npm run migrate
npm run build  # tsc --build
nohup npm run dev:api -- --host 0.0.0.0 --port 3000 &
```

### 3. HTTPS + Domain
```bash
sudo certbot --nginx -d tea.example.com
# Nginx reverse proxy to 3000, with HTTP->HTTPS redirect
```
See `nginx.conf.example` if added.

### 4. Backups (daily automated, see BACKUP-RESTORE.md)
- Cron `0 2 * * * /opt/tea-ledger/scripts/backup.sh` → `/var/backups/tea-ledger/YYYY-MM-DD.sql.gz` + retention 30d.
- Test restore quarterly: `gunzip < backup.sql.gz | psql $DATABASE_URL`.

### 5. Vercel Hobby Cron (alternative scheduler)
- If VPS cron not wanted, use Vercel `vercel.json` `crons` (daily/hourly UTC, production-only) for `GET /api/cron/friday-estimate` and `.../saturday-reminder` with `Authorization: Bearer $CRON_SECRET`. See `docs/MILESTONE-5.md` scheduler docs.

## Option B: Vercel (preview/hosted)

- Connect GitHub repo to Vercel, env vars: `DATABASE_URL` (Neon/Supabase Postgres), `SESSION_SECRET`, `ADMIN_DEFAULT_PASSWORD`, `CRON_SECRET`, `REQUIRED_CRON_SECRET=true`, `SMS_PROVIDER=mock`, `AT_*` if live.
- Build command already in `vercel.json`: `npx tsc --build && npx vite build apps/supervisor-pwa && npx vite build apps/admin-web && mkdir -p apps/api/public && cp -r apps/supervisor-pwa/dist/* apps/api/public/ && mkdir -p apps/api/public/admin && cp -r apps/admin-web/dist/* apps/api/public/admin/`.
- Crons in `vercel.json` run production-only (Hobby daily/hourly limit noted).
- Static PWA at `/`, Admin at `/admin`, API at `/api/*`.

## Env checklist (never commit .env)
See `.env.example`. Required in production: `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_DEFAULT_PASSWORD`, `CRON_SECRET`, `REQUIRED_CRON_SECRET=true`. PGlite refused in production (app throws).

## Health
- `GET /health` and `GET /api/health` — DB connectivity + demo flag (`USE_PGLITE`).

## Costs
No paid resources created by default (mock SMS). Africa's Talking live requires owner-provided credentials via secure secrets only (Decision 25).
