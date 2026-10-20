# Daily Backup & Restore — PostgreSQL

## Daily Automated Backup

### Cron (VPS)
Add to `crontab -e` as `tea-ledger` or `root`:

```cron
0 2 * * * /opt/tea-ledger/scripts/backup.sh >> /var/log/tea-backup.log 2>&1
```

`scripts/backup.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
DATE=$(date +%F)
DIR=/var/backups/tea-ledger
mkdir -p "$DIR"
# DATABASE_URL from .env
source /opt/tea-ledger/.env
pg_dump "$DATABASE_URL" | gzip > "$DIR/$DATE.sql.gz"
# Retention 30 days
find "$DIR" -name "*.sql.gz" -mtime +30 -delete
# Optional: upload to S3/B2
# aws s3 cp "$DIR/$DATE.sql.gz" s3://tea-ledger-backups/
echo "[$(date -Is)] Backup $DATE.sql.gz done" | tee -a /var/log/tea-backup.log
```

Make executable: `chmod +x scripts/backup.sh` and `chmod 700 /opt/tea-ledger/.env`.

### Vercel Hosted (Neon/Supabase)
- Enable provider's automated daily backups (Neon: branching + PITR; Supabase: daily + WAL).
- Additionally run `pg_dump` from a GitHub Action nightly if provider backup not available.

## Restore Procedure (documented, tested quarterly)

### 1. Stop app (to avoid writes during restore)
```bash
pm2 stop tea-api || pkill -f "node.*api"
```

### 2. Restore
```bash
# From latest backup file
gunzip -c /var/backups/tea-ledger/2026-12-01.sql.gz | psql "$DATABASE_URL"
# Or for PGlite pilot (ephemeral, not for prod): re-seed
USE_PGLITE=true npx tsx scripts/seed-demo.ts
```

### 3. Verify migrations re-applied
```bash
npm run migrate
curl http://localhost:3000/api/health
curl "http://localhost:3000/api/farms/$FARM_ID/payroll/2026-11-23" | head
```

### 4. Restart app
```bash
npm run dev:api &
```

### 5. Notify Owner/Admin (if payroll week was affected) + check audit log
```bash
curl http://localhost:3000/api/farms/$FARM_ID/audit-log?limit=5
```

## What is backed up
- All append-only `events`, `pay_weeks`, `payroll_lines`, `adjustments`, `workers`, `employment_periods`, `rates`, `sms_messages`, `audit_log`, `sessions`, `farm_settings` per `farm_id`.

## What is NOT backed up (ephemeral)
- `USE_PGLITE=true` PGlite data resets on restart (labeled `DEMO DATA — ephemeral, resets on restart` in UI). For pilot, set persistent `DATABASE_URL` per `.env.example`.

## Test
Run a restore drill on a staging VPS before pilot week 2026-11-23.
