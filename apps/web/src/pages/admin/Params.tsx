import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Loading } from '../../components/Guards';
import { stampShort } from '../../lib/format';
import { supabase, unwrap, type ParamsRow } from '../../lib/supabase';
import { JobNotice, Panel, useRunJob } from './common';

type Draft = Omit<ParamsRow, 'id' | 'valid_from' | 'active' | 'created_at' | 'created_by'>;

const FIELD: Record<string, string> = { open: 'Ouverture (premier cours coté)', close: 'Clôture', vwap: 'VWAP' };
const ROUND: Record<string, string> = { nearest: 'Centime le plus proche', up: 'Centime supérieur', down: 'Centime inférieur' };

export function useParamsVersions() {
  return useQuery({
    queryKey: ['admin', 'params'],
    queryFn: async () => unwrap(await supabase.from('calc_params').select('*').order('created_at', { ascending: false })),
  });
}

/** Crée une version de paramètres, l'active et relance l'estimation. */
export async function createAndActivate(draft: Partial<Draft> & { label: string }): Promise<number> {
  const { data, error } = await supabase.from('calc_params').insert({ ...draft, active: false }).select('id').single();
  if (error || !data) throw new Error(error?.message ?? 'version non créée');
  unwrap(await supabase.rpc('activate_calc_params', { p_id: data.id }));
  return data.id;
}

/** EF-42 : paramètres de calcul versionnés. */
export default function Params() {
  const versions = useParamsVersions();
  const qc = useQueryClient();
  const job = useRunJob();
  const active = versions.data?.find((v) => v.active) ?? null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (active && !draft) {
      const { id: _i, valid_from: _v, active: _a, created_at: _c, created_by: _b, ...rest } = active;
      setDraft({ ...rest, label: `${rest.label} (copie)` });
    }
  }, [active, draft]);

  if (versions.isLoading || !draft) return <Loading />;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setError(null);
    try {
      await createAndActivate(draft);
      await qc.invalidateQueries();
      await job.run('estimate');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function activate(id: number) {
    setError(null);
    const res = await supabase.rpc('activate_calc_params', { p_id: id });
    if (res.error) return setError(res.error.message);
    await qc.invalidateQueries();
    await job.run('estimate');
  }

  return (
    <>
      <h1 className="page-title">Paramètres de calcul</h1>
      <p className="muted small">Chaque estimation enregistre la version utilisée. Une seule version est active.</p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th scope="col">Version</th><th scope="col">Formule</th><th scope="col">Simulation</th><th scope="col">Depuis</th><th scope="col" /></tr>
          </thead>
          <tbody>
            {(versions.data ?? []).map((v) => (
              <tr key={v.id} className={v.active ? 'current' : undefined}>
                <th scope="row">{v.label}{v.active && <span className="chip chip--accent" style={{ marginLeft: 8 }}>active</span>}</th>
                <td className="small">
                  {v.window_days} séances, décote {(v.discount_bps / 100).toLocaleString('fr-FR')} %, {FIELD[v.price_field]?.toLowerCase()}, {ROUND[v.rounding]?.toLowerCase()}, jour du CA {v.exclude_board_day ? 'exclu' : 'inclus'}
                </td>
                <td className="small">
                  {v.n_sims.toLocaleString('fr-FR')} tirages, {v.bootstrap_days} séances, tolérance IF ±{(v.tolerance_bps / 100).toLocaleString('fr-FR')} %, erreur de modèle {(Number(v.model_sigma_bps) / 100).toLocaleString('fr-FR')} %
                </td>
                <td className="mono small">{stampShort(v.valid_from)}</td>
                <td>{!v.active && <button type="button" className="btn btn--small" onClick={() => void activate(v.id)}>Activer</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={submit}>
        <Panel title="Nouvelle version">
          <label className="field">Libellé<input value={draft.label} onChange={(e) => set('label', e.target.value)} required /></label>
          <div className="grid-fields">
            <label className="field">Nombre de séances<input type="number" min={1} max={60} value={draft.window_days} onChange={(e) => set('window_days', Number(e.target.value))} /></label>
            <label className="field">Décote (%)<input type="number" min={0} max={50} step={0.01} value={draft.discount_bps / 100} onChange={(e) => set('discount_bps', Math.round(Number(e.target.value) * 100))} /></label>
            <label className="field">Type de cours
              <select value={draft.price_field} onChange={(e) => set('price_field', e.target.value)}>
                {Object.entries(FIELD).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="field">Arrondi
              <select value={draft.rounding} onChange={(e) => set('rounding', e.target.value)}>
                {Object.entries(ROUND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          </div>
          <label className="check"><input type="checkbox" checked={draft.exclude_board_day} onChange={(e) => set('exclude_board_day', e.target.checked)} />Jour du CA exclu de la fenêtre</label>
          <div className="grid-fields">
            <label className="field">Tolérance de l’IF (± %)<input type="number" min={0.01} max={20} step={0.01} value={draft.tolerance_bps / 100} onChange={(e) => set('tolerance_bps', Math.round(Number(e.target.value) * 100))} /></label>
            <label className="field">Tirages<input type="number" min={100} max={100000} step={100} value={draft.n_sims} onChange={(e) => set('n_sims', Number(e.target.value))} /></label>
            <label className="field">Séances d’historique<input type="number" min={20} max={2500} value={draft.bootstrap_days} onChange={(e) => set('bootstrap_days', Number(e.target.value))} /></label>
            <label className="field">Erreur de modèle (%)<input type="number" min={0} step={0.01} value={Number(draft.model_sigma_bps) / 100} onChange={(e) => set('model_sigma_bps', Math.round(Number(e.target.value) * 10000) / 100)} /></label>
          </div>
          <label className="field">Note<textarea value={draft.note ?? ''} onChange={(e) => set('note', e.target.value)} /></label>
          <button type="submit" className="btn btn--primary" style={{ alignSelf: 'flex-start' }} disabled={job.busy !== null}>Créer, activer et recalculer</button>
          {error && <p className="notice notice--error">{error}</p>}
          <JobNotice result={job.result} error={job.error} />
        </Panel>
      </form>
    </>
  );
}
