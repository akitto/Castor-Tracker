#!/usr/bin/env bash
# Rejoue les migrations sur un Postgres local jetable (avec doublures Supabase),
# lance les tests de droits, puis (RUN_FUNCTIONS=1) le test de bout en bout de castor-jobs.
# Usage : bash scripts/test-db.sh            → migrations + tests SQL
#         GEN_TYPES=1 bash scripts/test-db.sh → régénère packages/core/src/database.ts
#         RUN_FUNCTIONS=1 bash scripts/test-db.sh → ajoute le test de la fonction (Deno requis)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DENO="${DENO:-deno}"
WORK="$(mktemp -d)"
PORT="${PGPORT_TEST:-54329}"
API_PORT="${API_PORT_TEST:-54400}"
export PGHOST="$WORK" PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres
API_PID=""

cleanup() {
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# initdb refuse de tourner en root : on passe par l'utilisateur postgres si besoin.
RUN=()
if [ "$(id -u)" = "0" ]; then
  chown -R postgres "$WORK" 2>/dev/null || true
  RUN=(runuser -u postgres --)
fi

"${RUN[@]}" "$PG_BIN/initdb" -D "$WORK/data" -U postgres -A trust --locale=C.UTF-8 >/dev/null
"${RUN[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/pg.log" -w start >/dev/null

PSQL=(psql -X -q -v ON_ERROR_STOP=1)

migrate() {
  "${PSQL[@]}" -f "$ROOT/supabase/tests/supabase_stubs.sql"
  for f in "$ROOT"/supabase/migrations/*.sql; do
    echo "→ $(basename "$f") ($PGDATABASE)"
    "${PSQL[@]}" -f "$f" 2>&1 | grep -v NOTICE || true
  done
}

migrate
if [ "${GEN_TYPES:-0}" = "1" ]; then
  "${PSQL[@]}" -f "$ROOT/supabase/tests/introspect.sql" > "$WORK/schema.json"
  node "$ROOT/scripts/gen-db-types.mjs" "$WORK/schema.json"
fi
"${PSQL[@]}" -f "$ROOT/supabase/tests/rls_test.sql" 2>&1 | sed -e 's/^psql:[^ ]* NOTICE:  /  /'

if [ "${RUN_FUNCTIONS:-0}" = "1" ]; then
  echo "— Test de bout en bout de castor-jobs"
  createdb castor_fn
  export PGDATABASE=castor_fn
  migrate
  SECRET="test-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  "${PSQL[@]}" -v cron_secret="$SECRET" -f "$ROOT/supabase/tests/function/setup.sql" >/dev/null
  node "$ROOT/scripts/sync-core.mjs" >/dev/null
  [ -d "$ROOT/supabase/tests/function/node_modules/pg" ] || npm install --prefix "$ROOT/supabase/tests/function" --no-audit --no-fund >/dev/null
  node "$ROOT/supabase/tests/function/fake-supabase.mjs" "$API_PORT" > "$WORK/api.log" 2>&1 &
  API_PID=$!
  for _ in $(seq 1 50); do grep -q "fake-supabase" "$WORK/api.log" 2>/dev/null && break; sleep 0.1; done
  SERVICE_KEY="$(printf '{"alg":"HS256","typ":"JWT"}' | base64 | tr -d '=\n' | tr '/+' '_-').$(printf '{"role":"service_role"}' | base64 | tr -d '=\n' | tr '/+' '_-').test"
  (cd "$ROOT/supabase/functions" && \
    SUPABASE_URL="http://127.0.0.1:$API_PORT" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_KEY" CASTOR_TEST_CRON_SECRET="$SECRET" \
    "$DENO" test --config deno.json --allow-net --allow-env --allow-read ../tests/function/castor-jobs.test.ts) || {
      echo "--- journal de la doublure API"; tail -30 "$WORK/api.log"; exit 1; }
fi
