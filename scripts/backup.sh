#!/usr/bin/env bash
# Sauvegarde quotidienne (ENF-07) : dump compressé des schémas applicatifs (public, auth, castor_meta),
# rotation sur BACKUP_KEEP_DAYS jours. À planifier sur l'hôte Coolify, par exemple :
#   15 3 * * * cd /opt/castor-tracker && bash scripts/backup.sh >> /var/log/castor-backup.log 2>&1
# Restauration (instance de test d'abord, REC-11) :
#   docker exec -i <db> pg_restore -U supabase_admin -d postgres --clean --if-exists < castor-AAAAMMJJ.dump
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
: "${BACKUP_DIR:?BACKUP_DIR manquant}"
KEEP="${BACKUP_KEEP_DAYS:-30}"
DB_CONTAINER="${DB_CONTAINER:-$(docker ps --format '{{.Names}}' | grep -E '^supabase-db' | head -1 || true)}"
[ -n "$DB_CONTAINER" ] || { echo "conteneur Postgres introuvable : définir DB_CONTAINER" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/castor-$(date +%Y%m%d-%H%M).dump"
docker exec -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$DB_CONTAINER" \
  pg_dump -U "${BACKUP_DB_USER:-supabase_admin}" -d postgres -Fc -n public -n auth -n castor_meta > "$file.tmp"
mv "$file.tmp" "$file"
find "$BACKUP_DIR" -name 'castor-*.dump' -mtime +"$KEEP" -delete
echo "$(date -Is) sauvegarde $(du -h "$file" | cut -f1) → $file"
