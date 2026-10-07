import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { CONFIGURED } from '../lib/config';
import MfaSetup from './Mfa';

export function Loading({ text = 'Chargement…' }: { text?: string }) {
  return <p className="loading" role="status">{text}</p>;
}

function Unconfigured() {
  return (
    <main className="page">
      <div className="notice notice--warn">
        Configuration absente : l’URL de l’API et la clé publique (anon) ne sont pas définies. Renseigner
        SUPABASE_URL et SUPABASE_ANON_KEY dans le conteneur web (voir le README).
      </div>
    </main>
  );
}

export function NoAccess({ admin = false }: { admin?: boolean }) {
  const { session } = useAuth();
  return (
    <main className="page">
      <h1 className="page-title">{admin ? 'Réservé aux administrateurs' : 'Accès sur invitation'}</h1>
      <p className="muted">
        {admin
          ? 'Votre compte n’a pas les droits d’administration.'
          : `Le compte ${session?.user.email ?? ''} n’a pas encore accès à Castor Tracker. Demandez une invitation à l’administrateur.`}
      </p>
    </main>
  );
}

/** Pages de consultation : visibles selon le mode du site (public, restreint, privé). */
export function RequireRead() {
  const { access, accessLoading, accessError, session } = useAuth();
  const location = useLocation();
  if (!CONFIGURED) return <Unconfigured />;
  if (accessLoading) return <Loading />;
  if (accessError && !access) {
    return <main className="page"><div className="notice notice--error">API injoignable : {accessError.message}</div></main>;
  }
  if (access?.can_read) return <Outlet />;
  if (!session) return <Navigate to="/connexion" replace state={{ from: location.pathname }} />;
  return <NoAccess />;
}

export function RequireSession({ children }: { children: ReactNode }) {
  const { session, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <Loading />;
  if (!session) return <Navigate to="/connexion" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

/** Back-office : rôle admin et, si exigé, session validée par TOTP. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { session, access, accessLoading, needsMfa } = useAuth();
  const location = useLocation();
  if (!CONFIGURED) return <Unconfigured />;
  if (accessLoading) return <Loading />;
  if (!session) return <Navigate to="/connexion" replace state={{ from: location.pathname }} />;
  if (access?.role !== 'admin') return <NoAccess admin />;
  if (needsMfa) {
    return (
      <main className="page">
        <MfaSetup />
      </main>
    );
  }
  return <>{children}</>;
}
