import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { stampShort } from '../../lib/format';
import { supabase, unwrap, type NotificationLogRow } from '../../lib/supabase';
import { JobNotice, Panel, useRunJob } from './common';

/** Journal des notifications envoyées et moniteur externe (battement toutes les 15 min). */
export default function AdminNotifications() {
  const qc = useQueryClient();
  const job = useRunJob();
  const [heartbeat, setHeartbeat] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const types = useQuery({
    queryKey: ['notif', 'types'],
    queryFn: async () => unwrap(await supabase.from('notification_types').select('*').order('sort')),
  });
  const log = useQuery({
    queryKey: ['admin', 'notification-log'],
    refetchInterval: 30_000,
    queryFn: async () => unwrap(await supabase.from('v_notification_log').select('*').order('created_at', { ascending: false }).limit(150)) as NotificationLogRow[],
  });
  const config = useQuery({
    queryKey: ['admin', 'admin-config'],
    queryFn: async () => unwrap(await supabase.from('admin_config').select('*').maybeSingle()),
  });
  useEffect(() => {
    setHeartbeat(config.data?.heartbeat_url ?? '');
  }, [config.data]);

  const label = (code: string | null) => types.data?.find((t) => t.code === code)?.label ?? code ?? '—';

  async function saveHeartbeat(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    const res = await supabase.from('admin_config').update({ heartbeat_url: heartbeat.trim() || null }).eq('id', true);
    setMessage(res.error ? { ok: false, text: res.error.message } : { ok: true, text: 'Moniteur enregistré.' });
    await qc.invalidateQueries({ queryKey: ['admin', 'admin-config'] });
  }

  return (
    <>
      <h1 className="page-title">Notifications</h1>
      <p className="small muted">
        Chaque compte choisit ses notifications dans <Link to="/compte/notifications">Mon compte › Notifications</Link> (vos
        préférences et votre webhook y sont aussi).
      </p>
      <Panel title="Moniteur externe">
        <p className="small muted" style={{ margin: 0 }}>
          La planification appelle cette URL toutes les 15 minutes. Si plus rien n’arrive (pg_cron arrêté, fonction en panne,
          base injoignable), le moniteur vous alerte : aucune notification interne ne peut le faire. Uptime Kuma : moniteur
          « Push », intervalle 30 min ; healthchecks.io : période 15 min, tolérance 15 min.
        </p>
        <form className="inline" style={{ alignItems: 'flex-end' }} onSubmit={saveHeartbeat}>
          <label className="field" style={{ flex: 1, minWidth: 260 }}>URL du battement
            <input type="url" className="mono" placeholder="https://kuma.exemple.fr/api/push/…" value={heartbeat}
              onChange={(e) => setHeartbeat(e.target.value)} />
          </label>
          <button type="submit" className="btn btn--primary">Enregistrer</button>
        </form>
        {message && <p className={`notice ${message.ok ? 'notice--ok' : 'notice--error'}`}>{message.text}</p>}
      </Panel>
      <Panel
        title="Journal des notifications"
        actions={<button type="button" className="btn btn--small" disabled={job.busy !== null} onClick={() => void job.run('notify')}>Envoyer maintenant</button>}
      >
        <JobNotice result={job.result} error={job.error} />
        <p className="xsmall muted">
          Les envois de nuit attendent 8 h pour les comptes en heures calmes ; un envoi en échec est relancé deux fois (15 puis 30 min).
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Date</th><th>Type</th><th>Notification</th><th className="num">Remises</th><th className="num">En attente</th><th className="num">Échecs</th></tr></thead>
            <tbody>
              {(log.data ?? []).map((n) => (
                <tr key={n.id}>
                  <td className="mono small nowrap">{stampShort(n.created_at)}</td>
                  <td className="small">{label(n.type)}{n.personal ? <span className="sub">alerte personnelle</span> : null}</td>
                  <td className="small">
                    <strong>{n.title}</strong>
                    <span className="sub">{n.body}</span>
                    {n.last_error && <span className="sub status-error">{n.last_error}</span>}
                  </td>
                  <td className="num">{n.sent ?? 0}</td>
                  <td className="num">{n.pending ?? 0}</td>
                  <td className="num">{(n.failed ?? 0) > 0 ? <span className="status-error">{n.failed}</span> : 0}</td>
                </tr>
              ))}
              {(log.data ?? []).length === 0 && <tr><td colSpan={6} className="small muted">Aucune notification pour l’instant.</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
