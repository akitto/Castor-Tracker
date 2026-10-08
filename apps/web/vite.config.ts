import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'robots.txt', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Castor Tracker',
        short_name: 'Castor',
        description: 'Estimation du prochain prix de souscription Castor (actionnariat salarié VINCI).',
        lang: 'fr',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#F3F4F1',
        theme_color: '#0B5E7E',
        categories: ['finance'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['email/**', 'config.js', 'push-sw.js'],
        // Réception des notifications Web Push et ouverture de la page visée au clic.
        importScripts: ['/push-sw.js'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/config\.js$/, /^\/robots\.txt$/, /^\/email\//, /^\/healthz$/],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Configuration d'exécution (URL et clé publique) : toujours celle du serveur ;
            // la copie en cache ne sert que hors ligne (pas de délai : une copie vide ne doit jamais gagner).
            urlPattern: ({ url }) => url.pathname === '/config.js',
            handler: 'NetworkFirst',
            options: { cacheName: 'castor-config' },
          },
          {
            // Lectures de l'API (tables, vues, RPC en GET) : réseau d'abord, cache hors ligne.
            urlPattern: ({ url, request }) => request.method === 'GET' && url.pathname.startsWith('/rest/v1/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'castor-api',
              networkTimeoutSeconds: 6,
              expiration: { maxEntries: 300, maxAgeSeconds: 30 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  server: { port: 5173 },
});
