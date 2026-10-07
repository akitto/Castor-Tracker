import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { stampShort } from '../../lib/format';
import { supabase, unwrap } from '../../lib/supabase';
import { JOB_LABEL, Panel, StatusText } from './common';

function duration(a: string, b: string | null): string {
  if (!b) return '—';
  const ms = Date.parse(b) - Date.parse(a);
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;
}

/** EF-46 : journal des tâches (succès, échecs, durée) et journal d'audit des écritures admin. */
export default function Journal() {
  const [job, setJob] = useState('');
  const [status, setStatus] = useState('');
  const runs = useQuery({
    queryKey: ['admin', 'runs', job, status],
    refetchInterval: 30_000,
    queryFn: async () => {
      let q = supabase.from('job_runs').select('*').order('started_at', { ascending: false }).limit(200);
      if (job) q = q.eq('job', job);
      if (status) q = q.eq('status', status);
      return unwrap(await q);
    },
  });
  const audit = useQuery({
    queryKey: ['admin', 'audit'],
    queryFn: async () => unwrap(await supabase.from('audit_log').select('*').order('at', { ascending: false }).limit(100)),
  });
  return (
    <>
      <h1 className="page-title">Journal des tâches</h1>
      <Panel
        title="Exécutions"
        actions={
          <>
            <select value={job} onChange={(e) => setJob(e.target.value)} aria-label="Tâche">
              <option value="">Toutes les tâches</option>
              {Object.entries(JOB_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Statut">
              <option value="">Tous les statuts</option>
              <option value="success">Succès</option>
              <option value="error">Échecs</option>
              <option value="running">En cours</option>
            </select>
          </>
        }
      >
        <p className="xsmall muted">Les passages planifiés sans travail (hors plage horaire, déjà faits) ne sont pas journalisés, ni le cours en séance.</p>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Début</th><th>Tâche</th><th>Déclencheur</th><th>Statut</th><th className="num">Durée</th><th>Message</th></tr></thead>
            <tbody>
              {(runs.data ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="mono small">{stampShort(r.started_at)}</td>
                  <td>{JOB_LABEL[r.job] ?? r.job}</td>
                  <td className="small">{r.trigger === 'cron' ? 'planifié' : r.trigger === 'admin' ? 'admin' : r.trigger}</td>
                  <td><StatusText status={r.status} /></td>
                  <td className="num">{duration(r.started_at, r.finished_at)}</td>
                  <td className="small">
                    {r.message}
                    {r.details ? (
                      <details><summary className="xsmall">détails</summary><pre className="xsmall" style={{ whiteSpace: 'pre-wrap', maxWidth: 560 }}>{JSON.stringify(r.details, null, 2)}</pre></details>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Journal d’audit">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Date</th><th>Table</th><th>Clé</th><th>Action</th><th>Contenu</th></tr></thead>
            <tbody>
              {(audit.data ?? []).map((a) => (
                <tr key={a.id}>
                  <td className="mono small">{stampShort(a.at)}</td>
                  <td>{a.table_name}</td>
                  <td className="mono small">{a.row_key}</td>
                  <td>{a.action}</td>
                  <td>
                    <details><summary className="xsmall">voir</summary>
                      <pre className="xsmall" style={{ whiteSpace: 'pre-wrap', maxWidth: 560 }}>{JSON.stringify({ avant: a.old, après: a.new }, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
