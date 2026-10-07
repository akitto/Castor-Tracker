import type { BacktestRow, InferenceResult, ReplayBucket, Variant, VariantResult } from '@castor/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useActiveParams, useLatestBacktest } from '../../lib/data';
import { dateFr, euro, euroDiff, pct, stampShort, weekdayDate } from '../../lib/format';
import { JobNotice, Panel, useRunJob } from './common';
import { createAndActivate } from './Params';

/** EF-45 : backtest de la formule, inférence des dates de CA, rejeu des estimations. */
export default function Backtest() {
  const qc = useQueryClient();
  const job = useRunJob();
  const params = useActiveParams();
  const formula = useLatestBacktest('formula');
  const inference = useLatestBacktest('inference');
  const replay = useLatestBacktest('replay');
  const [range, setRange] = useState(60);
  const [apply, setApply] = useState(false);
  const [nSims, setNSims] = useState(1000);
  const [daysBefore, setDaysBefore] = useState(60);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const variants = ((formula.data?.results as { variants?: VariantResult[] } | null)?.variants ?? []) as VariantResult[];
  const summary = formula.data?.summary as { active?: string; exact?: string | null } | undefined;
  const shown = variants.find((v) => v.key === (selected ?? summary?.exact ?? variants[0]?.key)) ?? null;
  const inferences = ((inference.data?.results as { inferences?: InferenceResult[] } | null)?.inferences ?? []) as InferenceResult[];
  const rsum = replay.data?.summary as { coverage?: number | null; n?: number; buckets?: ReplayBucket[]; skipped?: string[] } | undefined;

  async function chooseVariant(v: VariantResult) {
    if (!params.data) return;
    const variant: Variant = v.variant;
    const { id: _i, valid_from: _f, active: _a, created_at: _c, created_by: _b, ...base } = params.data;
    try {
      await createAndActivate({
        ...base,
        label: `Backtest du ${new Date().toLocaleDateString('fr-FR')} : ${v.label}`,
        price_field: variant.priceField,
        rounding: variant.rounding,
        exclude_board_day: variant.excludeBoardDay,
        model_sigma_bps: v.exactRate === 1 ? 0 : v.sigmaBps ?? 0,
        note: `${v.nExact}/${v.n} prix retrouvés au centime ; écart moyen ${v.mae ?? '—'} €.`,
      });
      await qc.invalidateQueries();
      setMessage(`Variante « ${v.label} » activée.`);
      await job.run('estimate');
    } catch (e) {
      setMessage((e as Error).message);
    }
  }

  return (
    <>
      <h1 className="page-title">Backtest</h1>
      <Panel title="Lancement">
        <div className="inline">
          <button type="button" className="btn btn--primary" disabled={job.busy !== null} onClick={() => void job.run('backtest')}>
            {job.busy === 'backtest' ? 'Backtest…' : 'Lancer le backtest de la formule'}
          </button>
        </div>
        <div className="inline" style={{ alignItems: 'flex-end' }}>
          <label className="field">Recherche autour de la date présumée (séances)
            <input type="number" min={5} max={120} value={range} onChange={(e) => setRange(Number(e.target.value))} style={{ width: 120 }} />
          </label>
          <label className="check"><input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} />Appliquer les dates trouvées sans ambiguïté</label>
          <button type="button" className="btn" disabled={job.busy !== null} onClick={() => void job.run('infer', { rangeSessions: range, apply })}>
            {job.busy === 'infer' ? 'Inférence…' : 'Inférer les dates de CA'}
          </button>
        </div>
        <div className="inline" style={{ alignItems: 'flex-end' }}>
          <label className="field">Tirages par point<input type="number" min={200} max={5000} step={100} value={nSims} onChange={(e) => setNSims(Number(e.target.value))} style={{ width: 120 }} /></label>
          <label className="field">Jours avant le CA<input type="number" min={5} max={120} value={daysBefore} onChange={(e) => setDaysBefore(Number(e.target.value))} style={{ width: 120 }} /></label>
          <button type="button" className="btn" disabled={job.busy !== null} onClick={() => void job.run('replay', { nSims, daysBefore })}>
            {job.busy === 'replay' ? 'Rejeu…' : 'Rejouer les estimations'}
          </button>
        </div>
        <JobNotice result={job.result} error={job.error} />
        {message && <p className="notice">{message}</p>}
      </Panel>

      <Panel title="Variantes de la formule">
        {formula.data ? (
          <>
            <p className="small muted">Backtest du {stampShort(formula.data.run_at)}. La variante retenue doit retrouver 100 % des prix au centime.</p>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Variante</th><th className="num">Exacts</th><th className="num">Écart moyen</th><th className="num">Écart max</th><th className="num">σ résidus</th><th /></tr></thead>
                <tbody>
                  {variants.map((v) => (
                    <tr key={v.key} className={v.key === summary?.active ? 'current' : undefined}>
                      <th scope="row" style={{ fontWeight: 500 }}>
                        <button type="button" className="btn btn--small" style={{ border: 0, padding: 0, minHeight: 0, background: 'none', color: 'var(--accent)' }} onClick={() => setSelected(v.key)}>{v.label}</button>
                        {v.key === summary?.active && <span className="chip chip--accent" style={{ marginLeft: 8 }}>active</span>}
                      </th>
                      <td className="num">{v.nExact}/{v.n}{v.nMissing ? ` (+${v.nMissing})` : ''}</td>
                      <td className="num">{v.mae === null ? '—' : euro(v.mae)}</td>
                      <td className="num">{v.maxAbs === null ? '—' : euro(v.maxAbs)}</td>
                      <td className="num">{v.sigmaBps === null ? '—' : `${(v.sigmaBps / 100).toLocaleString('fr-FR')} %`}</td>
                      <td>{v.key !== summary?.active && v.n > 0 && <button type="button" className="btn btn--small" onClick={() => void chooseVariant(v)}>Choisir</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {shown && (
              <>
                <h3 style={{ fontSize: 15 }}>Détail : {shown.label}</h3>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Quadrimestre</th><th>CA</th><th className="num">Officiel</th><th className="num">Recalculé</th><th className="num">Écart</th><th className="num">Séances manquantes</th></tr></thead>
                    <tbody>
                      {shown.rows.map((r: BacktestRow) => (
                        <tr key={r.code}>
                          <th scope="row">{r.code}</th>
                          <td className="mono">{dateFr(r.boardDate)}</td>
                          <td className="num">{euro(r.official)}</td>
                          <td className="num">{euro(r.computed)}</td>
                          <td className={`num ${r.exact ? 'status-success' : r.diff === null ? '' : 'status-error'}`}>{r.diff === null ? '—' : euroDiff(r.diff)}{r.diffPct !== null && !r.exact ? ` (${pct(r.diffPct, 2)})` : ''}</td>
                          <td className="num">{r.missing}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="xsmall muted">Un écart isolé signale souvent une ouverture erronée chez le fournisseur de cours : vérifier la séance dans « Données de cours ».</p>
              </>
            )}
          </>
        ) : <p className="muted">Pas encore de backtest.</p>}
      </Panel>

      <Panel title="Inférence des dates de CA">
        {inference.data ? (
          inferences.length ? (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Quadrimestre</th><th className="num">Prix officiel</th><th>Date présumée</th><th>Dates qui retrouvent le prix</th><th>Plus proches</th></tr></thead>
                <tbody>
                  {inferences.map((r) => (
                    <tr key={r.code}>
                      <th scope="row">{r.code}</th>
                      <td className="num">{euro(r.officialPrice)}</td>
                      <td className="mono">{dateFr(r.presumedDate)}</td>
                      <td>{r.matches.length ? r.matches.map((m) => weekdayDate(m.date) + ' ' + m.date.slice(0, 4)).join(' ; ') : <span className="status-error">aucune</span>}{r.matches.length > 1 && <span className="chip chip--warn" style={{ marginLeft: 6 }}>ambigu</span>}</td>
                      <td className="small">{r.closest.slice(0, 3).map((c) => `${dateFr(c.date)} (${euroDiff(c.diff)})`).join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted small">Aucun prix officiel sans date de CA connue.</p>
        ) : <p className="muted">Pas encore d’inférence.</p>}
      </Panel>

      <Panel title="Rejeu des estimations">
        {rsum ? (
          <>
            <p>
              Couverture de l’intervalle à 90 % : <strong>{pct(rsum.coverage ?? null, 1, false)}</strong> sur {rsum.n} estimations rejouées
              (critère de recette REC-05 : entre 80 et 98 %).
            </p>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Situation</th><th className="num">Points</th><th className="num">Dans l’intervalle</th><th className="num">À ±1 %</th><th className="num">IF moyen</th></tr></thead>
                <tbody>
                  {(rsum.buckets ?? []).map((b) => (
                    <tr key={b.label}><td>{b.label}</td><td className="num">{b.n}</td><td className="num">{pct(b.coverage, 0, false)}</td><td className="num">{pct(b.hitRate, 0, false)}</td><td className="num">{b.meanReliability === null ? '—' : Math.round(b.meanReliability)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="xsmall muted">Un IF bien calé a un IF moyen proche du taux « à ±1 % ».</p>
            {(rsum.skipped?.length ?? 0) > 0 && <details><summary className="small">{rsum.skipped?.length} point(s) ignoré(s)</summary><p className="xsmall muted">{rsum.skipped?.join(' ; ')}</p></details>}
          </>
        ) : <p className="muted">Pas encore de rejeu.</p>}
      </Panel>
    </>
  );
}
