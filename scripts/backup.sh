#!/usr/bin/env bash
set -euo pipefail
DATE=$(date +%F)
DIR=/var/backups/tea-ledger
mkdir -p "$DIR"
# Load .env if present (VPS) else use env DATABASE_URL
if [ -f /opt/tea-ledger/.env ]; then set -a; source /opt/tea-ledger/.env; set +a; fi
if [ -z "${DATABASE_URL:-}" ]; then echo "DATABASE_URL not set — nothing to backup (PGlite ephemeral)"; exit 0; fi
pg_dump "$DATABASE_URL" | gzip > "$DIR/$DATE.sql.gz"
find "$DIR" -name "*.sql.gz" -mtime +30 -delete
echo "[$(date -Is)] Backup $DATE.sql.gz done"
