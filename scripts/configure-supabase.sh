#!/usr/bin/env bash
# Configure l'instance Supabase de Castor Tracker. Idempotent : relançable à chaque mise à jour.
#   1. applique les migrations SQL non encore appliquées (suivi dans castor_meta.migrations) ;
#   2. écrit les secrets Vault (URL des fonctions, secret des tâches planifiées, clé publique) ;
#   3. renseigne l'adresse du site, (re)crée les tâches pg_cron, recharge le schéma PostgREST ;
#   4. crée le premier administrateur (ADMIN_EMAIL) s'il n'existe pas ;
#   5. vérifie la fonction castor-jobs et lance la reprise de l'historique si la base est vide.
# Usage : bash scripts/configure-supabase.sh [--migrations-only] [--rotate-secret]
# Supabase Cloud : DATABASE_URL (connexion « Session pooler »), SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY ;
# en auto-hébergement : DB_CONTAINER (ou DATABASE_URL), SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

MIGRATIONS_ONLY=0
ROTATE=0
for arg in "$@"; do
  case "$arg" in
    --migrations-only) MIGRATIONS_ONLY=1 ;;
    --rotate-secret) ROTATE=1 ;;
    *) echo "option inconnue : $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m→ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Clés d'API : nouvelles clés de Supabase Cloud (publishable / secret) ou clés historiques (anon / service_role).
SUPABASE_ANON_KEY="${SUPABASE_PUBLISHABLE_KEY:-${SUPABASE_ANON_KEY:-}}"
SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SECRET_KEY:-${SUPABASE_SERVICE_ROLE_KEY:-}}"

# En-têtes d'authentification d'une clé : apikey toujours, Bearer seulement pour une clé JWT
# (les clés sb_publishable_… / sb_secret_… ne sont pas des JWT et seraient refusées en Bearer).
auth_args() {
  AUTH_ARGS=(-H "apikey: $1")
  case "$1" in eyJ*) AUTH_ARGS+=(-H "Authorization: Bearer $1") ;; esac
}

psql_cmd() {
  if [ -n "${DATABASE_URL:-}" ]; then
    psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"
  elif [ -n "${DB_CONTAINER:-}" ]; then
    docker exec -i "$DB_CONTAINER" psql -U "${DB_USER:-postgres}" -d "${DB_NAME:-postgres}" -X -q -v ON_ERROR_STOP=1 "$@"
  else
    die "définir DB_CONTAINER (conteneur Postgres de Coolify) ou DATABASE_URL dans $ENV_FILE"
  fi
}
sql_value() { psql_cmd -t -A "$@" | tr -d '[:space:]'; }

if [ -z "${DB_CONTAINER:-}" ] && [ -z "${DATABASE_URL:-}" ] && command -v docker >/dev/null 2>&1; then
  DB_CONTAINER="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^supabase-db' | head -1 || true)"
  [ -n "$DB_CONTAINER" ] && say "conteneur Postgres détecté : $DB_CONTAINER"
fi

say "connexion à Postgres"
psql_cmd -c "select 1" >/dev/null || die "connexion impossible"

say "migrations"
psql_cmd <<'SQL'
set client_min_messages = warning;
create schema if not exists castor_meta;
revoke all on schema castor_meta from public;
create table if not exists castor_meta.migrations (
  filename text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);
SQL
for file in "$ROOT"/supabase/migrations/*.sql; do
  name="$(basename "$file")"
  sum="$(sha256sum "$file" | cut -c1-16)"
  applied="$(sql_value -v name="$name" <<'SQL'
select coalesce((select checksum from castor_meta.migrations where filename = :'name'), '');
SQL
)"
  if [ -n "$applied" ]; then
    [ "$applied" = "$sum" ] || warn "$name modifiée depuis son application (somme $applied → $sum) : non rejouée"
    continue
  fi
  echo "  $name"
  { echo 'begin;'; cat "$file"; echo; echo "insert into castor_meta.migrations (filename, checksum) values ('$name', '$sum');"; echo 'commit;'; } | psql_cmd
done
psql_cmd -c "notify pgrst, 'reload schema';" >/dev/null

[ "$MIGRATIONS_ONLY" = "1" ] && { say "migrations à jour"; exit 0; }

: "${SUPABASE_URL:?SUPABASE_URL manquant dans $ENV_FILE}"
: "${SUPABASE_ANON_KEY:?clé publique manquante : SUPABASE_PUBLISHABLE_KEY (ou SUPABASE_ANON_KEY) dans $ENV_FILE}"
SUPABASE_URL="${SUPABASE_URL%/}"
FUNCTIONS_URL="${CASTOR_FUNCTIONS_URL:-$SUPABASE_URL/functions/v1}"

say "secrets Vault"
current="$(sql_value <<'SQL'
select coalesce(public.castor_secret('castor_cron_secret'), '');
SQL
)"
if [ -z "$current" ] || [ "$ROTATE" = "1" ]; then
  secret="$(openssl rand -hex 32)"
  psql_cmd -v s="$secret" <<'SQL' >/dev/null
select public.castor_set_secret('castor_cron_secret', :'s');
SQL
  echo "  secret des tâches planifiées $([ -n "$current" ] && echo renouvelé || echo créé)"
fi
psql_cmd -v url="${FUNCTIONS_URL%/}" -v anon="$SUPABASE_ANON_KEY" <<'SQL' >/dev/null
select public.castor_set_secret('castor_functions_url', :'url');
select public.castor_set_secret('castor_anon_key', :'anon');
SQL
echo "  fonctions appelées sur ${FUNCTIONS_URL%/}"

if [ -n "${SITE_URL:-}" ]; then
  psql_cmd -v site="${SITE_URL%/}" <<'SQL' >/dev/null
update public.app_config set site_url = :'site' where id;
SQL
fi

say "tâches planifiées (pg_cron)"
psql_cmd -t -A -c "select public.castor_setup_cron()"

if [ -n "${ADMIN_EMAIL:-}" ]; then
  say "premier administrateur : $ADMIN_EMAIL"
  email="$(printf '%s' "$ADMIN_EMAIL" | tr '[:upper:]' '[:lower:]')"
  uid="$(sql_value -v email="$email" <<'SQL'
select coalesce((select id::text from auth.users where lower(email) = :'email' limit 1), '');
SQL
)"
  if [ -z "$uid" ]; then
    if [ -n "${ADMIN_PASSWORD:-}" ]; then
      password="$ADMIN_PASSWORD"
    elif [ -n "${CI:-}" ]; then
      die "compte $email introuvable : le créer dans Supabase (Authentication › Users › Add user), puis relancer"
    elif [ -t 0 ]; then
      read -rsp "  mot de passe (12 caractères min.) : " password; echo
    else
      # Jamais affiché : écrit dans un fichier lisible par le seul propriétaire.
      password="$(openssl rand -base64 18)"
      umask 077
      printf '%s\n' "$password" > "$ROOT/.admin-password"
      echo "  mot de passe généré et écrit dans $ROOT/.admin-password (à supprimer après la première connexion)"
    fi
    [ "${#password}" -ge 12 ] || die "mot de passe trop court"
    [ -n "$SUPABASE_SERVICE_ROLE_KEY" ] || die "SUPABASE_SECRET_KEY (ou SUPABASE_SERVICE_ROLE_KEY) requis pour créer le compte administrateur"
    escaped="$(printf '%s' "$password" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    body="$(printf '{"email":"%s","password":"%s","email_confirm":true}' "$email" "$escaped")"
    auth_args "$SUPABASE_SERVICE_ROLE_KEY"
    response="$(curl -sS -X POST "$SUPABASE_URL/auth/v1/admin/users" "${AUTH_ARGS[@]}" \
      -H 'Content-Type: application/json' -d "$body")"
    uid="$(printf '%s' "$response" | sed -n 's/.*"id":"\([0-9a-f-]\{36\}\)".*/\1/p' | head -1)"
    [ -n "$uid" ] || die "création du compte refusée : $response"
  fi
  psql_cmd -v uid="$uid" <<'SQL' >/dev/null
insert into public.user_roles (user_id, role) values (:'uid'::uuid, 'admin')
on conflict (user_id) do update set role = 'admin';
SQL
  echo "  rôle admin attribué (TOTP demandé à la première connexion à l’administration)"
fi

say "fonction castor-jobs"
# Clé publique jointe : nécessaire si le service functions vérifie les JWT (VERIFY_JWT=true en auto-hébergement).
auth_args "$SUPABASE_ANON_KEY"
if curl -fsS --max-time 10 "${AUTH_ARGS[@]}" "$SUPABASE_URL/functions/v1/castor-jobs" >/dev/null 2>&1; then
  echo "  en ligne"
  count="$(sql_value -c 'select count(*) from public.stock_prices')"
  if [ "$count" = "0" ]; then
    psql_cmd -t -A -c "select public.castor_call('history', '{\"from\": \"2015-01-01\"}'::jsonb)" >/dev/null
    echo "  base vide : reprise de l’historique lancée (résultat dans Admin › Journal des tâches)"
  fi
else
  warn "castor-jobs ne répond pas : déployer la fonction (workflow « Supabase Cloud », ou scripts/deploy-functions.sh en auto-hébergement) puis relancer ce script"
fi
say "configuration terminée"
