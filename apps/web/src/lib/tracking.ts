import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { CONFIGURED } from './config';
import { supabase } from './supabase';

const VISITOR_KEY = 'castor-visitor';
const VISITOR_RE = /^[0-9a-f-]{8,64}$/;

function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Identifiant aléatoire du navigateur (aucune donnée personnelle) ; null si le stockage est bloqué. */
function visitorId(): string | null {
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id || !VISITOR_RE.test(id)) {
      id = randomId();
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

/** Compte chaque page affichée (hors back-office) pour le graphe de fréquentation de l'admin. */
export function usePageTracking(): void {
  const { pathname } = useLocation();
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!CONFIGURED || pathname.startsWith('/admin') || last.current === pathname) return;
    last.current = pathname;
    if (!navigator.onLine) return;
    // Sans attente ni message : un échec de comptage ne doit jamais gêner la navigation.
    void supabase.rpc('track_page_view', { p_path: pathname, p_visitor: visitorId() ?? undefined }).then(
      () => undefined,
      () => undefined,
    );
  }, [pathname]);
}
