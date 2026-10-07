#!/usr/bin/env bash
# Déploie l'Edge Function castor-jobs sur Supabase auto-hébergé (Coolify) :
# copie castor-jobs et le moteur partagé dans le volume « functions », puis redémarre le service.
# En auto-hébergé, « supabase functions deploy » n'existe pas : le service lit ses fichiers sur disque.
# Usage : bash scripts/deploy-functions.sh   (variables dans .env : FUNCTIONS_DIR, FUNCTIONS_CONTAINER, FUNCTIONS_SSH)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
: "${FUNCTIONS_DIR:?FUNCTIONS_DIR manquant (ex. /data/coolify/services/<uuid>/volumes/functions)}"

say() { printf '\033[1m→ %s\033[0m\n' "$*"; }
remote() { if [ -n "${FUNCTIONS_SSH:-}" ]; then ssh "$FUNCTIONS_SSH" "$@"; else "$@"; fi; }

say "copie du moteur de calcul dans supabase/functions/_shared/core"
node "$ROOT/scripts/sync-core.mjs" >/dev/null

say "copie des fichiers vers ${FUNCTIONS_SSH:+$FUNCTIONS_SSH:}$FUNCTIONS_DIR"
remote mkdir -p "$FUNCTIONS_DIR/castor-jobs" "$FUNCTIONS_DIR/_shared/core"
if command -v rsync >/dev/null 2>&1; then
  dest="${FUNCTIONS_SSH:+$FUNCTIONS_SSH:}$FUNCTIONS_DIR"
  rsync -a --delete "$ROOT/supabase/functions/castor-jobs/" "$dest/castor-jobs/"
  rsync -a --delete "$ROOT/supabase/functions/_shared/core/" "$dest/_shared/core/"
elif [ -z "${FUNCTIONS_SSH:-}" ]; then
  rm -rf "$FUNCTIONS_DIR/castor-jobs" "$FUNCTIONS_DIR/_shared/core"
  cp -R "$ROOT/supabase/functions/castor-jobs" "$FUNCTIONS_DIR/castor-jobs"
  mkdir -p "$FUNCTIONS_DIR/_shared"
  cp -R "$ROOT/supabase/functions/_shared/core" "$FUNCTIONS_DIR/_shared/core"
else
  echo "rsync requis pour une copie distante" >&2
  exit 1
fi

CONTAINER="${FUNCTIONS_CONTAINER:-$(remote docker ps --format '{{.Names}}' | grep -E 'supabase-edge-functions|supabase-functions' | head -1 || true)}"
[ -n "$CONTAINER" ] || { echo "conteneur des fonctions introuvable : définir FUNCTIONS_CONTAINER" >&2; exit 1; }
say "redémarrage de $CONTAINER"
remote docker restart "$CONTAINER" >/dev/null

if [ -n "${SUPABASE_URL:-}" ]; then
  say "vérification"
  auth=()
  [ -n "${SUPABASE_ANON_KEY:-}" ] && auth=(-H "Authorization: Bearer $SUPABASE_ANON_KEY")
  for _ in $(seq 1 30); do
    if out="$(curl -fsS --max-time 5 "${auth[@]}" "${SUPABASE_URL%/}/functions/v1/castor-jobs" 2>/dev/null)"; then
      echo "  $out"
      exit 0
    fi
    sleep 2
  done
  echo "castor-jobs ne répond pas après 60 s : voir « docker logs $CONTAINER »" >&2
  exit 1
fi
