import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { runJob, type JobResponse } from '../../lib/supabase';

/** Lance une tâche castor-jobs et rafraîchit les données affichées. */
export function useRunJob() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<JobResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(task: string, body: Record<string, unknown> = {}): Promise<JobResponse | null> {
    setBusy(task);
    setError(null);
    setResult(null);
    try {
      const res = await runJob(task, body);
      setResult(res);
      await qc.invalidateQueries();
      return res;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  }
  return { run, busy, result, error, setError, setResult };
}

export function JobNotice({ result, error }: { result: JobResponse | null; error: string | null }) {
  if (error) return <p className="notice notice--error" role="alert">{error}</p>;
  if (!result) return null;
  return (
    <p className={`notice ${result.skipped ? 'notice--warn' : 'notice--ok'}`} role="status">
      {result.skipped ? `Rien à faire : ${result.skipped}` : result.message ?? 'Terminé.'}
    </p>
  );
}

export function Panel({ title, children, actions, id }: { title: string; children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <section className="card" id={id} aria-label={title}>
      <div className="spread">
        <h2 className="card__title card__title--lg">{title}</h2>
        {actions && <div className="inline">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function StatusText({ status }: { status: string | null | undefined }) {
  const label: Record<string, string> = { success: 'OK', error: 'Échec', running: 'En cours', skipped: 'Ignorée' };
  return <span className={`status-${status ?? 'skipped'}`}>{label[status ?? ''] ?? status ?? '—'}</span>;
}

export const JOB_LABEL: Record<string, string> = {
  open: 'Ouverture du jour et estimation',
  quote: 'Cours en séance',
  session: 'Séance complète et contrôle croisé',
  catchup: 'Rattrapage des séances manquantes',
  history: 'Reprise de l’historique',
  estimate: 'Estimation',
  backtest: 'Backtest de la formule',
  infer: 'Inférence des dates de CA',
  replay: 'Rejeu des estimations',
  maintenance: 'Maintenance mensuelle',
  invite: 'Invitation',
  'set-role': 'Changement de rôle',
  'delete-user': 'Suppression de compte',
};

export function percentInput(v: number): string {
  return (Math.round(v * 100) / 100).toString();
}
