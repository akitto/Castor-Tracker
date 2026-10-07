import { indexSessions, windowSessions, type ISODate } from '@castor/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Loading } from '../../components/Guards';
import { IconUpload } from '../../components/Icons';
import { toEstimateParams, useActiveParams, useCalendar, useDashboard, usePriceSeries } from '../../lib/data';
import { dayMonth, euro, reliabilityInt, stampShort, timeOnly, weekdayDate } from '../../lib/format';
import { supabase, unwrap, type QuadrimesterRow } from '../../lib/supabase';
import { JOB_LABEL, JobNotice, StatusText, useRunJob } from './common';
import { OfficialPricesImport } from './Quadrimesters';

interface FormState {
  start: string;
  end: string;
  close: string;
  mode: 'date' | 'slot';
  boardDate: string;
  boardStatus: 'known' | 'estimated' | 'inferred';
  slotStart: string;
  slotEnd: string;
  source: string;
  weights: Record<string, string>;
  notes: string;
}

function fromRow(q: QuadrimesterRow): FormState {
  const weights: Record<string, string> = {};
  if (q.board_weights && typeof q.board_weights === 'object' && !Array.isArray(q.board_weights)) {
    for (const [k, v] of Object.entries(q.board_weights)) weights[k] = String(v);
  }
  return {
    start: q.start_date,
    end: q.end_date,
    close: q.payment_close_date,
    mode: q.board_date ? 'date' : 'slot',
    boardDate: q.board_date ?? '',
    boardStatus: q.board_status as FormState['boardStatus'],
    slotStart: q.board_slot_start ?? '',
    slotEnd: q.board_slot_end ?? '',
    source: q.board_source ?? '',
    weights,
    notes: q.notes ?? '',
  };
}

/** EF-40 et EF-41 : période, date ou créneau du CA avec poids, annonce du prix officiel. */
export default function QuadrimesterEdit() {
  const { code: param } = useParams();
  const code = (param ?? '').replace('-', '/');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const calendar = useCalendar();
  const series = usePriceSeries();
  const params = useActiveParams();
  const dash = useDashboard();
  const job = useRunJob();
  const quad = useQuery({
    queryKey: ['admin', 'quadrimester', code],
    queryFn: async () => unwrap(await supabase.from('quadrimesters').select('*').eq('code', code).maybeSingle()),
  });
  const estimate = useQuery({
    queryKey: ['admin', 'estimate', code],
    queryFn: async () =>
      unwrap(await supabase.from('estimates').select('*').eq('quadrimester_code', code).in('kind', ['scheduled', 'manual'])
        .order('computed_at', { ascending: false }).limit(1).maybeSingle()),
  });
  const runs = useQuery({
    queryKey: ['admin', 'runs', 'recent'],
    queryFn: async () => unwrap(await supabase.from('job_runs').select('*').order('started_at', { ascending: false }).limit(5)),
  });
  const [form, setForm] = useState<FormState | null>(null);
  const [official, setOfficial] = useState({ price: '', date: '', url: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [peak, setPeak] = useState('');
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    if (quad.data) {
      setForm(fromRow(quad.data));
      setOfficial({
        price: quad.data.official_price === null ? '' : String(quad.data.official_price).replace('.', ','),
        date: quad.data.official_published_at ?? '',
        url: quad.data.notice_url ?? '',
      });
    }
  }, [quad.data]);

  const p = toEstimateParams(params.data);
  const today = dash.data?.today ?? new Date().toISOString().slice(0, 10);
  const index = useMemo(() => indexSessions(series.data ?? []), [series.data]);
  const candidates = useMemo(() => {
    if (!form || form.mode !== 'slot' || !form.slotStart || !form.slotEnd || form.slotEnd < form.slotStart) return [];
    return calendar.sessionsBetween(form.slotStart, form.slotEnd);
  }, [form, calendar]);
  const knownFor = (d: ISODate) =>
    windowSessions(calendar, d, p).filter((s) => s <= today && (index.get(s)?.[p.priceField] ?? null) !== null).length;
  const total = candidates.reduce((s, d) => s + (Number((form?.weights[d] ?? '').replace(',', '.')) || 0), 0);

  if (quad.isLoading || !form) return quad.data === null ? <p className="notice notice--error">Quadrimestre {code} introuvable.</p> : <Loading />;
  const q = quad.data as QuadrimesterRow;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  function uniform() {
    const w = candidates.length ? 100 / candidates.length : 0;
    set('weights', Object.fromEntries(candidates.map((d) => [d, (Math.round(w * 10) / 10).toString()])));
  }
  function peakOn(date: string) {
    if (!date || candidates.length < 2) return;
    const rest = 40 / (candidates.length - 1);
    set('weights', Object.fromEntries(candidates.map((d) => [d, d === date ? '60' : (Math.round(rest * 10) / 10).toString()])));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    const weights: Record<string, number> = {};
    for (const d of candidates) {
      const w = Number((form.weights[d] ?? '').replace(',', '.'));
      if (w > 0) weights[d] = w;
    }
    const update = {
      start_date: form.start,
      end_date: form.end,
      payment_close_date: form.close,
      board_date: form.mode === 'date' ? form.boardDate || null : null,
      board_status: form.mode === 'date' ? form.boardStatus : 'estimated',
      board_slot_start: form.mode === 'slot' ? form.slotStart || null : null,
      board_slot_end: form.mode === 'slot' ? form.slotEnd || null : null,
      board_weights: form.mode === 'slot' && Object.keys(weights).length > 0 ? weights : null,
      board_source: form.source.trim() || null,
      notes: form.notes.trim() || null,
    };
    const res = await supabase.from('quadrimesters').update(update).eq('code', code);
    setSaving(false);
    if (res.error) return setError(res.error.message);
    setSaved('Enregistré.');
    await qc.invalidateQueries();
    if (q.official_price === null) await job.run('estimate', { code });
  }

  async function saveOfficial(e: FormEvent) {
    e.preventDefault();
    const price = Number(official.price.replace(/\s/g, '').replace(',', '.'));
    if (!(price > 0)) return setError('Prix officiel invalide.');
    setError(null);
    const res = await supabase.rpc('admin_set_official_price', {
      p_code: code,
      p_price: price,
      p_published: official.date || undefined,
      p_notice_url: official.url || undefined,
    });
    if (res.error) return setError(res.error.message);
    setSaved(`Prix officiel enregistré ; ${res.data ? 'dernière estimation archivée.' : 'aucune estimation à archiver.'}`);
    await qc.invalidateQueries();
    await job.run('estimate');
  }

  const est = estimate.data;
  return (
    <>
      <div className="stack">
        <p className="breadcrumb"><Link to="/admin/quadrimestres">Quadrimestres</Link> / {code}</p>
        <div className="inline">
          <h1 className="page-title">Quadrimestre {code}</h1>
          <span className={`chip chip--lg ${q.official_price === null ? 'chip--warn' : 'chip--accent'}`}>
            {q.official_price === null ? 'Prix non annoncé' : `Officiel · ${euro(Number(q.official_price))}`}
          </span>
          <div className="inline" style={{ marginLeft: 'auto' }}>
            <button type="button" className="btn" onClick={() => setImportOpen((v) => !v)}><IconUpload />Importer des prix officiels (CSV)</button>
            <button type="button" className="btn" onClick={() => navigate('/admin/cours#import')}><IconUpload />Importer des cours (CSV)</button>
          </div>
        </div>
      </div>
      {importOpen && <section className="card"><OfficialPricesImport onDone={() => setImportOpen(false)} /></section>}

      <div className="row" style={{ gap: 20, alignItems: 'flex-start' }}>
        <div className="col-main" style={{ gap: 20 }}>
          <form onSubmit={save} className="stack-lg" style={{ gap: 20 }}>
            <fieldset className="card">
              <legend>Période</legend>
              <div className="grid-fields">
                <label className="field">Début de souscription<input type="date" value={form.start} onChange={(e) => set('start', e.target.value)} required /></label>
                <label className="field">Fin du quadrimestre<input type="date" value={form.end} onChange={(e) => set('end', e.target.value)} required /></label>
                <label className="field">Fermeture des versements<input type="date" value={form.close} onChange={(e) => set('close', e.target.value)} required /></label>
              </div>
            </fieldset>

            <fieldset className="card">
              <legend>Conseil d’administration fixant le prix</legend>
              <div role="radiogroup" aria-label="Type de date" className="inline" style={{ gap: '8px 24px' }}>
                <label className="check"><input type="radio" name="ca-type" checked={form.mode === 'date'} onChange={() => set('mode', 'date')} />Date connue</label>
                <label className="check"><input type="radio" name="ca-type" checked={form.mode === 'slot'} onChange={() => set('mode', 'slot')} />Créneau</label>
              </div>
              {form.mode === 'date' ? (
                <div className="grid-fields">
                  <label className="field">Date du CA<input type="date" value={form.boardDate} onChange={(e) => set('boardDate', e.target.value)} required /></label>
                  <label className="field">Statut
                    <select value={form.boardStatus} onChange={(e) => set('boardStatus', e.target.value as FormState['boardStatus'])}>
                      <option value="known">Connue (source fiable)</option>
                      <option value="estimated">Présumée</option>
                      <option value="inferred">Inférée par le backtest</option>
                    </select>
                  </label>
                  <label className="field">Source de l’information<input type="text" value={form.source} onChange={(e) => set('source', e.target.value)} placeholder="ex. avis VINCI du …" /></label>
                </div>
              ) : (
                <>
                  <div className="grid-fields">
                    <label className="field">Du<input type="date" value={form.slotStart} onChange={(e) => set('slotStart', e.target.value)} required /></label>
                    <label className="field">Au<input type="date" value={form.slotEnd} onChange={(e) => set('slotEnd', e.target.value)} required /></label>
                    <label className="field">Source de l’information<input type="text" value={form.source} onChange={(e) => set('source', e.target.value)} placeholder="ex. communication interne du …" /></label>
                  </div>
                  <div className="stack">
                    <div className="spread">
                      <h3 style={{ fontSize: 14, fontWeight: 600 }}>Pondération des dates candidates</h3>
                      <div className="inline">
                        <button type="button" className="btn btn--small" onClick={uniform}>Répartir uniformément</button>
                        <select value={peak} onChange={(e) => { setPeak(e.target.value); peakOn(e.target.value); }} aria-label="Pic sur une date" style={{ minHeight: 36 }}>
                          <option value="">Pic sur une date…</option>
                          {candidates.map((d) => <option key={d} value={d}>{weekdayDate(d)} (60 %)</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="table-wrap">
                      <table className="data" style={{ minWidth: 420 }}>
                        <thead><tr><th scope="col">Date candidate</th><th scope="col">Séances connues au {dayMonth(today)}</th><th scope="col" className="num">Poids</th></tr></thead>
                        <tbody>
                          {candidates.map((d) => (
                            <tr key={d} className={d === dash.data?.most_probable_date && dash.data?.next_code === code ? 'current' : undefined}>
                              <th scope="row">{weekdayDate(d)}</th>
                              <td className="mono muted">{knownFor(d)} / {p.windowDays}</td>
                              <td className="num">
                                <input type="number" min={0} step={0.1} aria-label={`Poids du ${weekdayDate(d)}`} style={{ width: 90, minHeight: 36 }}
                                  value={form.weights[d] ?? ''} placeholder={(100 / Math.max(1, candidates.length)).toFixed(1)}
                                  onChange={(e) => set('weights', { ...form.weights, [d]: e.target.value })} /> %
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot><tr><th scope="row">Total</th><td /><td className="num">{total ? `${Math.round(total * 10) / 10} %` : 'uniforme'}</td></tr></tfoot>
                      </table>
                    </div>
                    <p className="xsmall muted">Poids vides : répartition uniforme. Les poids sont normalisés au calcul.</p>
                  </div>
                </>
              )}
              <label className="field">Notes<textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
            </fieldset>
            <div className="inline">
              <button type="submit" className="btn btn--primary" disabled={saving || job.busy !== null}>
                {job.busy ? 'Recalcul…' : 'Enregistrer et recalculer'}
              </button>
              <button type="button" className="btn" onClick={() => quad.data && setForm(fromRow(quad.data))}>Annuler</button>
            </div>
          </form>

          <form onSubmit={saveOfficial}>
            <fieldset className="card">
              <legend>Annonce officielle</legend>
              <div className="grid-fields">
                <label className="field">Prix officiel (€)<input className="mono" inputMode="decimal" placeholder="à saisir à l’annonce" value={official.price} onChange={(e) => setOfficial({ ...official, price: e.target.value })} /></label>
                <label className="field">Date de l’annonce<input type="date" value={official.date} onChange={(e) => setOfficial({ ...official, date: e.target.value })} /></label>
                <label className="field">Lien de l’avis VINCI<input type="url" placeholder="https://www.vinci.com/…" value={official.url} onChange={(e) => setOfficial({ ...official, url: e.target.value })} /></label>
              </div>
              <p className="small muted">L’enregistrement du prix archive la dernière estimation, affiche l’écart et passe le quadrimestre en « officiel ».</p>
              <button type="submit" className="btn btn--primary" style={{ alignSelf: 'flex-start' }}>Enregistrer le prix officiel</button>
            </fieldset>
          </form>
          {error && <p className="notice notice--error" role="alert">{error}</p>}
          {saved && <p className="notice notice--ok" role="status">{saved}</p>}
          <JobNotice result={job.result} error={job.error} />
        </div>

        <aside className="col-side" style={{ gap: 20 }}>
          <section className="card">
            <h2 className="card__title card__title--lg">Estimation actuelle</h2>
            {est ? (
              <>
                <p className="mid-price">{euro(Number(est.central))}</p>
                <dl className="facts">
                  <dt>Intervalle à 90 %</dt><dd>{Number(est.p05).toLocaleString('fr-FR', { minimumFractionDigits: 2 })} – {Number(est.p95).toLocaleString('fr-FR', { minimumFractionDigits: 2 })}</dd>
                  <dt>Indice de fiabilité</dt><dd>{reliabilityInt(est.reliability)} / 100</dd>
                  <dt>Calculée le</dt><dd>{stampShort(est.computed_at)}</dd>
                </dl>
                <p className="small muted">
                  Recalcul immédiat à l’enregistrement : {p.nSims.toLocaleString('fr-FR')} tirages{candidates.length > 1 ? ` sur les ${candidates.length} dates candidates` : ''}.
                </p>
              </>
            ) : <p className="small muted">Aucune estimation pour ce quadrimestre.</p>}
          </section>
          <section className="card">
            <h2 className="card__title card__title--lg">Journal des tâches</h2>
            <ul className="journal">
              {(runs.data ?? []).map((r) => (
                <li key={r.id}>
                  <span className="mono muted">{r.started_at.slice(0, 10) === new Date().toISOString().slice(0, 10) ? timeOnly(r.started_at) : dayMonth(r.started_at.slice(0, 10))}</span>
                  <span title={r.message ?? ''}>{JOB_LABEL[r.job] ?? r.job}</span>
                  <StatusText status={r.status} />
                </li>
              ))}
            </ul>
            <Link to="/admin/journal" className="small">Tout le journal</Link>
          </section>
        </aside>
      </div>
    </>
  );
}
