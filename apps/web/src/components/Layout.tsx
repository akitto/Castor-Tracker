import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useAuth } from '../lib/auth';
import { useDashboard } from '../lib/data';
import { stamp, stampShort } from '../lib/format';
import { usePageTracking } from '../lib/tracking';
import { IconChart, IconHistory, IconHome, IconMethod, Logo } from './Icons';

function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

function UpdateBanner() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (registration) setInterval(() => void registration.update(), 60 * 60 * 1000);
    },
  });
  if (!needRefresh) return null;
  return (
    <div className="banner banner--update" role="status">
      <span>Une nouvelle version de Castor Tracker est disponible.</span>
      <button type="button" className="btn btn--small btn--primary" onClick={() => void updateServiceWorker(true)}>Recharger</button>
      <button type="button" className="btn btn--small" onClick={() => setNeedRefresh(false)}>Plus tard</button>
    </div>
  );
}

export default function Layout() {
  const { session, access, signOut } = useAuth();
  const online = useOnline();
  usePageTracking();
  const canRead = Boolean(access?.can_read);
  const dash = useDashboard();
  const updated = canRead ? (dash.data?.quote_time ?? dash.data?.computed_at ?? null) : null;
  const isAdminRole = access?.role === 'admin';
  const initial = session?.user.email?.[0]?.toUpperCase() ?? '?';
  // NavLink pose aria-current="page" sur le lien actif (styles .main-nav et .tabbar).
  const nav = (to: string, label: string, end = false) => (
    <NavLink to={to} end={end}>{label}</NavLink>
  );

  return (
    <>
      <a href="#contenu" className="skip-link">Aller au contenu</a>
      <header className="app-header">
        <div className="app-header__inner">
          <Link to="/" className="brand"><Logo /><span className="brand__name">Castor Tracker</span></Link>
          <nav className="main-nav" aria-label="Navigation principale">
            {nav('/', 'Tableau de bord', true)}
            {nav('/historique', 'Historique')}
            {nav('/methode', 'Méthode')}
            {isAdminRole && nav('/admin', 'Admin')}
          </nav>
          <div className="header-side">
            {updated && <span className="header-status">Mis à jour {stamp(updated)} · cours différés de 15 min</span>}
            {session ? (
              <>
                <Link to="/compte" className="inline" style={{ gap: 8, color: 'var(--muted)', textDecoration: 'none' }} title={session.user.email ?? ''}>
                  <span className="avatar" aria-hidden="true">{initial}</span>
                  <span className="header-status">{isAdminRole ? 'Administrateur' : 'Mon compte'}</span>
                </Link>
                <button type="button" className="btn btn--small" onClick={() => void signOut()}>Déconnexion</button>
              </>
            ) : (
              <Link to="/connexion" className="btn btn--small">Se connecter</Link>
            )}
          </div>
        </div>
      </header>
      {!online && (
        <div className="banner banner--offline" role="status">
          Hors ligne : affichage des dernières données reçues{updated ? ` (données du ${stampShort(updated)})` : ''}.
        </div>
      )}
      <UpdateBanner />
      <div id="contenu">
        <Outlet />
      </div>
      <nav className="tabbar" aria-label="Navigation">
        <NavLink to="/" end><IconHome />Accueil</NavLink>
        <NavLink to="/graphique"><IconChart />Graphique</NavLink>
        <NavLink to="/historique"><IconHistory />Historique</NavLink>
        <NavLink to="/methode"><IconMethod />Méthode</NavLink>
      </nav>
    </>
  );
}
