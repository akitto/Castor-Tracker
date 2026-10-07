/**
 * Configuration d'exécution : /config.js (écrit au démarrage du conteneur Nginx)
 * définit window.__CASTOR_CONFIG__ ; à défaut, variables VITE_* du build (développement).
 */
interface RuntimeConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

const runtime: RuntimeConfig = (globalThis as { __CASTOR_CONFIG__?: RuntimeConfig }).__CASTOR_CONFIG__ ?? {};

export const SUPABASE_URL = (runtime.supabaseUrl || import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
export const SUPABASE_ANON_KEY = runtime.supabaseAnonKey || import.meta.env.VITE_SUPABASE_ANON_KEY || '';
export const CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
export const API_CACHE = 'castor-api';
