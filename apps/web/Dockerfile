# PWA Castor Tracker : build Vite puis service statique par Nginx.
# Contexte de build : racine du dépôt (le moteur packages/core est partagé).
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@castor/web..."
COPY packages/core packages/core
COPY apps/web apps/web
# Repli : si Coolify passe aussi les variables au build, elles sont intégrées à la PWA (valeurs publiques).
# /config.js, écrit au démarrage, reste prioritaire.
ARG SUPABASE_URL=""
ARG SUPABASE_PUBLISHABLE_KEY=""
ARG SUPABASE_ANON_KEY=""
RUN VITE_SUPABASE_URL="$SUPABASE_URL" VITE_SUPABASE_ANON_KEY="${SUPABASE_PUBLISHABLE_KEY:-$SUPABASE_ANON_KEY}" \
    pnpm --filter @castor/web build

FROM nginx:stable-alpine
# Variables d'exécution (Coolify) : SUPABASE_URL et SUPABASE_PUBLISHABLE_KEY (ou SUPABASE_ANON_KEY).
# Vides par défaut pour que le modèle Nginx reste valide et que la PWA affiche « Configuration absente ».
ENV SUPABASE_URL="" SUPABASE_PUBLISHABLE_KEY="" SUPABASE_ANON_KEY=""
# Modèle Nginx (CSP calculée à partir de SUPABASE_URL au démarrage) et écriture de /config.js.
COPY apps/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY apps/web/nginx/40-castor-config.sh /docker-entrypoint.d/40-castor-config.sh
RUN chmod +x /docker-entrypoint.d/40-castor-config.sh && rm -f /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
