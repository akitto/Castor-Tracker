import { addDays, parsePriceCsv, type PriceRow } from '@castor/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { IconUpload } from '../../components/Icons';
import { useCalendar, useDashboard, usePriceSeries } from '../../lib/data';
import { amount, dateFr, stampShort } from '../../lib/format';
import { supabase, unwrap, type StockPriceRow } from '../../lib/supabase';
import { JOB_LABEL, JobNotice, Panel, StatusText, useRunJob } from './common';

function PricesImport() {
  const qc = useQueryClient();
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const parsed = parsePriceCsv(await file.text());
    setRows(parsed.rows);
    setErrors(parsed.errors);
    setMessage(null);
    if (!reason) setReason(`Import ${file.name}`);
  }

  async function run() {
    setBusy(true);
    let inserted = 0;
    let updated = 0;
    try {
      for (let i = 0; i < rows.length; i += 1500) {
        const chunk = rows.slice(i, i + 1500).map((r) => ({
          date: r.date, open: r.open ?? null, high: r.high ?? null, low: r.low ?? null, close: r.close ?? null, vwap: r.vwap ?? null, volume: r.volume ?? null,
        }));
        const res = unwrap(await supabase.rpc('admin_import_prices', { p_rows: chunk, p_reason: reason, p_overwrite: overwrite })) as { inserted: number; updated: number };
        inserted += res.inserted;
        updated += res.updated;
      }
      setMessage({ ok: true, text: `${inserted} séance(s) ajoutée(s), ${updated} remplacée(s), ${rows.length - inserted - updated} ignorée(s) (déjà en base).` });
      setRows([]);
      await qc.invalidateQueries();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-lg">
      <p className="small muted">
        Export Euronext, Yahoo ou Boursorama : colonnes Date et Open (ou Ouverture), plus High, Low, Close, Volume, VWAP
        si disponibles. Cours bruts uniquement : la colonne « Adj Close » est ignorée. Les séances importées ne sont plus
        écrasées par la collecte automatique.
      </p>
      <input type="file" accept=".csv,.txt,text/csv" onChange={(e) => void onFile(e)} aria-label="Fichier CSV de cours" />
      {rows.length > 0 && (
        <>
          <p className="notice">
            {rows.length} séance(s) lue(s), du {dateFr(rows[0].date)} au {dateFr(rows[rows.length - 1].date)} ; dernière
            ouverture {amount(rows[rows.length - 1].open ?? null)} €.
          </p>
          <div className="grid-fields">
            <label className="field">Motif (journal d’audit)<input value={reason} onChange={(e) => setReason(e.target.value)} required /></label>
          </div>
          <label className="check"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />Remplacer les séances déjà en base</label>
          <button type="button" className="btn btn--primary" style={{ alignSelf: 'flex-start' }} disabled={busy || !reason.trim()} onClick={() => void run()}>
            Importer
          </button>
        </>
      )}
      {errors.length > 0 && <div className="notice notice--warn">{errors.slice(0, 10).map((e) => <div key={e}>{e}</div>)}{errors.length > 10 && <div>… {errors.length - 10} autre(s)</div>}</div>}
      {message && <p className={`notice ${message.ok ? 'notice--ok' : 'notice--error'}`}>{message.text}</p>}
    </div>
  );
}

function Correction() {
  const qc = useQueryClient();
  const [date, setDate] = useState('');
  const [row, setRow] = useState<StockPriceRow | null>(null);
  const [values, setValues] = useState({ open: '', high: '', low: '', close: '', reason: '' });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function load(d: string) {
    setDate(d);
    setMessage(null);
    if (!d) return setRow(null);
    const r = unwrap(await supabase.from('stock_prices').select('*').eq('trade_date', d).maybeSingle());
    setRow(r);
    const s = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
    setValues({ open: s(r?.open), high: s(r?.high), low: s(r?.low), close: s(r?.close), reason: r?.manual_reason ?? '' });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const n = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
    const payload = {
      open: n(values.open), high: n(values.high), low: n(values.low), close: n(values.close),
      is_manual: true, manual_reason: values.reason.trim(), source: 'manuel', fetched_at: new Date().toISOString(),
    };
    const res = row
      ? await supabase.from('stock_prices').update(payload).eq('trade_date', date)
      : await supabase.from('stock_prices').insert({ trade_date: date, ...payload });
    if (res.error) return setMessage({ ok: false, text: res.error.message });
    setMessage({ ok: true, text: 'Séance enregistrée (journal d’audit). Relancez l’estimation si la séance est dans la fenêtre.' });
    await qc.invalidateQueries();
  }

  return (
    <form onSubmit={save} className="stack-lg">
      <label className="field" style={{ maxWidth: 220 }}>Séance<input type="date" value={date} onChange={(e) => void load(e.target.value)} required /></label>
      {date && (
        <>
          {row ? (
            <p className="small muted">
              Source {row.source}, collectée le {stampShort(row.fetched_at)}
              {row.check_source ? ` ; contrôle ${row.check_source} : ouverture ${amount(row.check_open)} €, clôture ${amount(row.check_close)} €` : ''}
              {row.is_manual ? ` ; corrigée à la main (${row.manual_reason})` : ''}.
            </p>
          ) : <p className="small muted">Aucune séance en base à cette date : elle sera créée.</p>}
          <div className="grid-fields">
            {(['open', 'high', 'low', 'close'] as const).map((k) => (
              <label key={k} className="field">{{ open: 'Ouverture', high: 'Plus haut', low: 'Plus bas', close: 'Clôture' }[k]}
                <input className="mono" inputMode="decimal" value={values[k]} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <label className="field">Motif de la correction<input value={values.reason} onChange={(e) => setValues({ ...values, reason: e.target.value })} required /></label>
          <button type="submit" className="btn btn--primary" style={{ alignSelf: 'flex-start' }}>Enregistrer la correction</button>
        </>
      )}
      {message && <p className={`notice ${message.ok ? 'notice--ok' : 'notice--error'}`}>{message.text}</p>}
    </form>
  );
}

/** EF-43 : état des collectes, relances, import CSV, correction d'une séance. */
export default function Prices() {
  const series = usePriceSeries();
  const calendar = useCalendar();
  const dash = useDashboard();
  const job = useRunJob();
  const location = useLocation();
  const [historyFrom, setHistoryFrom] = useState('2015-01-01');
  const recent = useQuery({
    queryKey: ['admin', 'prices', 'recent'],
    queryFn: async () => unwrap(await supabase.from('stock_prices').select('*').order('trade_date', { ascending: false }).limit(30)),
  });
  const config = useQuery({ queryKey: ['admin', 'config'], queryFn: async () => unwrap(await supabase.from('app_config').select('*').maybeSingle()) });
  const status = useQuery({ queryKey: ['job-status'], queryFn: async () => unwrap(await supabase.from('v_job_status').select('*')) });

  useEffect(() => {
    if (location.hash === '#import') document.getElementById('import')?.scrollIntoView();
  }, [location.hash]);

  const today = dash.data?.today ?? new Date().toISOString().slice(0, 10);
  const health = useMemo(() => {
    const sessions = series.data ?? [];
    const have = new Set(sessions.filter((s) => s.open && s.close).map((s) => s.date));
    const lastClosed = calendar.previousSession(today);
    const missing30 = calendar.sessionsBetween(addDays(today, -30), lastClosed).filter((d) => !have.has(d));
    const first = sessions[0]?.date ?? null;
    const missingAll = first ? calendar.sessionsBetween(first, lastClosed).filter((d) => !have.has(d)) : [];
    return { count: sessions.length, first, last: sessions[sessions.length - 1]?.date ?? null, missing30, missingAll };
  }, [series.data, calendar, today]);
  const threshold = (config.data?.alert_spread_bps ?? 50) / 10_000;
  const spreads = (recent.data ?? []).filter((r) =>
    (r.check_open && r.open && Math.abs(Number(r.check_open) / Number(r.open) - 1) > threshold) ||
    (r.check_close && r.close && Math.abs(Number(r.check_close) / Number(r.close) - 1) > threshold));

  return (
    <>
      <h1 className="page-title">Données de cours</h1>
      <Panel title="État des collectes">
        <dl className="facts">
          <dt>Séances en base</dt><dd>{health.count.toLocaleString('fr-FR')}{health.first ? ` (depuis le ${dateFr(health.first)})` : ''}</dd>
          <dt>Dernière séance</dt><dd>{dateFr(health.last)}</dd>
          <dt>Séances incomplètes sur 30 jours</dt><dd className={health.missing30.length ? 'status-error' : undefined}>{health.missing30.length}</dd>
          <dt>Séances incomplètes depuis le début</dt><dd>{health.missingAll.length}</dd>
          <dt>Écarts de sources au-delà de {(threshold * 100).toLocaleString('fr-FR')} % (30 dernières séances)</dt><dd className={spreads.length ? 'status-error' : undefined}>{spreads.length}</dd>
        </dl>
        {health.missing30.length > 0 && <p className="small muted">Manquantes : {health.missing30.map(dateFr).join(', ')}</p>}
        <ul className="journal">
          {(status.data ?? []).map((s) => (
            <li key={s.job ?? ''} style={{ gridTemplateColumns: '120px minmax(0, 1fr) max-content' }}>
              <span className="mono muted">{stampShort(s.started_at)}</span>
              <span title={s.message ?? ''}>{JOB_LABEL[s.job ?? ''] ?? s.job} — <span className="small muted">{s.message}</span></span>
              <StatusText status={s.status} />
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Relances manuelles">
        <div className="inline">
          {(['open', 'session', 'catchup', 'estimate'] as const).map((t) => (
            <button key={t} type="button" className="btn" disabled={job.busy !== null} onClick={() => void job.run(t)}>
              {job.busy === t ? '…' : JOB_LABEL[t]}
            </button>
          ))}
        </div>
        <div className="inline" style={{ alignItems: 'flex-end' }}>
          <label className="field">Reprise de l’historique depuis le<input type="date" value={historyFrom} onChange={(e) => setHistoryFrom(e.target.value)} /></label>
          <button type="button" className="btn" disabled={job.busy !== null} onClick={() => void job.run('history', { from: historyFrom })}>
            {job.busy === 'history' ? 'Reprise en cours…' : 'Reprendre l’historique'}
          </button>
        </div>
        <JobNotice result={job.result} error={job.error} />
      </Panel>

      <Panel title="Import CSV de cours" id="import" actions={<IconUpload />}>
        <PricesImport />
      </Panel>

      <Panel title="Corriger une séance">
        <Correction />
      </Panel>

      <Panel title="Dernières séances">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Séance</th><th className="num">Ouverture</th><th className="num">Clôture</th><th className="num">Contrôle ouv.</th><th className="num">Contrôle clôt.</th><th>Source</th></tr></thead>
            <tbody>
              {(recent.data ?? []).map((r) => (
                <tr key={r.trade_date}>
                  <th scope="row" className="mono">{dateFr(r.trade_date)}</th>
                  <td className="num">{amount(r.open)}</td>
                  <td className="num">{amount(r.close)}</td>
                  <td className="num">{amount(r.check_open)}</td>
                  <td className="num">{amount(r.check_close)}</td>
                  <td className="small">{r.source}{r.is_manual ? ` · manuel (${r.manual_reason})` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
