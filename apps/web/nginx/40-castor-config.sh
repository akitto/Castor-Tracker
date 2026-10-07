#!/bin/sh
# Écrit la configuration d'exécution de la PWA à partir des variables du conteneur.
# Seules l'URL publique de l'API et la clé anon (publique par nature) sont exposées.
set -eu
: "${SUPABASE_URL:?Variable SUPABASE_URL manquante (ex. https://api.castor.exemple.fr)}"
: "${SUPABASE_ANON_KEY:?Variable SUPABASE_ANON_KEY manquante (clé anon de Supabase)}"
URL=$(printf '%s' "$SUPABASE_URL" | sed 's:/*$::')
cat > /usr/share/nginx/html/config.js <<CONF
window.__CASTOR_CONFIG__ = { supabaseUrl: "${URL}", supabaseAnonKey: "${SUPABASE_ANON_KEY}" };
CONF
echo "castor : config.js écrit pour ${URL}"
