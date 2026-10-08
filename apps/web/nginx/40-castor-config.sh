#!/bin/sh
# Écrit la configuration d'exécution de la PWA à partir des variables du conteneur.
# Seules l'URL publique de l'API et la clé publique (publishable, ou anon historique) sont exposées.
# Sans ces variables, le conteneur démarre quand même : la PWA affiche « Configuration absente ».
set -eu
URL=$(printf '%s' "${SUPABASE_URL:-}" | sed 's:/*$::')
KEY="${SUPABASE_PUBLISHABLE_KEY:-${SUPABASE_ANON_KEY:-}}"
cat > /usr/share/nginx/html/config.js <<CONF
window.__CASTOR_CONFIG__ = { supabaseUrl: "${URL}", supabaseAnonKey: "${KEY}" };
CONF
if [ -z "$URL" ] || [ -z "$KEY" ]; then
  echo "castor : SUPABASE_URL ou SUPABASE_PUBLISHABLE_KEY absente, la PWA affichera « Configuration absente »" >&2
else
  echo "castor : config.js écrit pour ${URL}"
fi
