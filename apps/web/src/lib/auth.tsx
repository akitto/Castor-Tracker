import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { API_CACHE, CONFIGURED } from './config';
import { forgetDevice } from './push';
import { supabase, unwrap } from './supabase';

export interface Access {
  visibility: 'public' | 'restricted' | 'private';
  mfa_required: boolean;
  role: 'admin' | 'viewer' | null;
  aal: string | null;
  is_admin: boolean;
  can_read: boolean;
}

interface AuthValue {
  session: Session | null;
  ready: boolean;
  access: Access | null;
  accessError: Error | null;
  accessLoading: boolean;
  /** Admin dont la session doit encore passer le second facteur. */
  needsMfa: boolean;
  refreshAccess: () => Promise<unknown>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    if (!CONFIGURED) {
      setReady(true);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'MFA_CHALLENGE_VERIFIED' || event === 'USER_UPDATED') {
        void qc.invalidateQueries();
      }
    });
    return () => data.subscription.unsubscribe();
  }, [qc]);

  const tokenTag = session ? `${session.user.id}:${session.access_token.slice(-16)}` : 'anon';
  const accessQuery = useQuery({
    queryKey: ['access', tokenTag],
    enabled: ready && CONFIGURED,
    staleTime: 60_000,
    queryFn: async () => unwrap(await supabase.rpc('my_access', undefined, { get: true })) as unknown as Access,
  });

  const value = useMemo<AuthValue>(() => {
    const access = accessQuery.data ?? null;
    return {
      session,
      ready,
      access,
      accessError: accessQuery.error as Error | null,
      accessLoading: !ready || accessQuery.isLoading,
      needsMfa: Boolean(access && access.role === 'admin' && access.mfa_required && access.aal !== 'aal2'),
      refreshAccess: () => accessQuery.refetch(),
      signOut: async () => {
        await forgetDevice();
        await supabase.auth.signOut();
        qc.clear();
        if ('caches' in window) await caches.delete(API_CACHE);
      },
    };
  }, [session, ready, accessQuery.data, accessQuery.error, accessQuery.isLoading, accessQuery, qc]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('AuthProvider manquant');
  return ctx;
}
