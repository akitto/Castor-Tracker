import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router-dom';
import { supabase, unwrap } from '../../lib/supabase';
import { JOB_LABEL } from './common';

const LINKS: [string, string][] = [
  ['quadrimestres', 'Quadrimestres'],
  ['parametres', 'Paramètres de calcul'],
  ['cours', 'Données de cours'],
  ['reference', 'Dividendes et jours fériés'],
  ['backtest', 'Backtest'],
  ['journal', 'Journal des tâches'],
  ['acces', 'Accès'],
];

/** Back-office : navigation latérale et alertes (deux échecs consécutifs d'une tâche). */
export default function AdminLayout() {
  const status = useQuery({
    queryKey: ['job-status'],
    refetchInterval: 60_000,
    queryFn: async () => unwrap(await supabase.from('v_job_status').select('*')),
  });
  const failing = (status.data ?? []).filter((s) => (s.recent_errors ?? 0) >= 2);
  return (
    <div className="admin-layout">
      <nav className="admin-nav" aria-label="Administration">
        <p>Administration</p>
        {LINKS.map(([to, label]) => (
          <NavLink key={to} to={`/admin/${to}`}>{label}</NavLink>
        ))}
      </nav>
      <div className="admin-main">
        {failing.length > 0 && (
          <div className="notice notice--error" role="alert">
            Alerte : {failing.map((f) => JOB_LABEL[f.job ?? ''] ?? f.job).join(', ')} en échec deux fois de suite. Voir le{' '}
            <NavLink to="/admin/journal">journal des tâches</NavLink>.
          </div>
        )}
        <Outlet />
      </div>
    </div>
  );
}
