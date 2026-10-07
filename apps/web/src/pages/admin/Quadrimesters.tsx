import { compareQuad, defaultBoardSlot, isQuadCode, parseQuadrimesterCsv, quadPeriod, type QuadrimesterImportRow } from '@castor/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loading } from '../../components/Guards';
import { IconUpload } from '../../components/Icons';
import { dateFr, dateRange, euro } from '../../lib/format';
import { supabase, unwrap } from '../../lib/supabase';
import { Panel, useRunJob, JobNotice } from './common';

export function useQuadrimesters() {
  return useQuery({
    queryKey: ['admin', 'quadrimesters'],
    queryFn: async () => unwrap(await supabase.from('quadrimesters').select('*')),
  });
}

/** Import CSV du jeu de référence (code ; date du CA ; prix officiel ; lien de l'avis). */
export function OfficialPricesImport({ onDone }: { onDone?: () => void }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<QuadrimesterImportRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const job = useRunJob();

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const parsed = parseQuadrimesterCsv(await file.text());
    setRows(parsed.rows);
    setErrors(parsed.errors);
    setMessage(null);
  }

  async function importRows() {
    setBusy(true);
    let n = 0;
    try {
      for (const r of rows) {
        const p = quadPeriod(r.code);
        const payload: Record<string, unknown> = {
          code: r.code,
          start_date: p.start,
          end_date: p.end,
          payment_close_date: p.paymentClose,
        };
        if (r.boardDate) Object.assign(payload, { board_date: r.boardDate, board_status: 'known', board_source: r.noticeUrl ? 'Avis VINCI' : 'Import CSV' });
        if (r.officialPrice !== null) payload.official_price = r.officialPrice;
        if (r.noticeUrl) payload.notice_url = r.noticeUrl;
        const existing = unwrap(await supabase.from('quadrimesters').select('code').eq('code', r.code).maybeSingle());
        if (existing) {
          const { code: _code, start_date: _s, end_date: _e, payment_close_date: _c, ...update } = payload;
          unwrap(await supabase.from('quadrimesters').update(update as never).eq('code', r.code));
        } else {
          if (!r.boardDate) Object.assign(payload, { board_slot_start: defaultBoardSlot(r.code).start, board_slot_end: defaultBoardSlot(r.code).end });
          unwrap(await supabase.from('quadrimesters').insert(payload as never));
        }
        n++;
      }
      setMessage(`${n} quadrimestre(s) importé(s). Lancez le backtest pour vérifier la formule.`);
      setRows([]);
      await qc.invalidateQueries();
      await job.run('estimate');
      onDone?.();
    } catch (e) {
      setMessage(`Import interrompu après ${n} ligne(s) : ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-lg">
      <p className="small muted">
        Colonnes attendues (séparateur « ; » ou « , ») : <span className="mono">code;date_ca;prix;avis</span>, par
        exemple <span className="mono">2025/3;12/06/2025;105,82;https://…</span>. Les quadrimestres existants sont mis à jour.
      </p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e)} aria-label="Fichier CSV des prix officiels" />
      {rows.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Code</th><th>Date du CA</th><th className="num">Prix officiel</th><th>Avis</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.code}><td>{r.code}</td><td className="mono">{dateFr(r.boardDate)}</td><td className="num">{euro(r.officialPrice)}</td><td className="small">{r.noticeUrl ?? '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void importRows()}>
            Importer {rows.length} quadrimestre{rows.length > 1 ? 's' : ''}
          </button>
        </>
      )}
      {errors.length > 0 && <div className="notice notice--warn">{errors.slice(0, 8).map((e) => <div key={e}>{e}</div>)}</div>}
      {message && <p className="notice notice--ok">{message}</p>}
      <JobNotice result={job.result} error={job.error} />
    </div>
  );
}

export default function Quadrimesters() {
  const quads = useQuadrimesters();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showImport, setShowImport] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (quads.isLoading) return <Loading />;
  const rows = [...(quads.data ?? [])].sort((a, b) => compareQuad(b.code, a.code));

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const code = newCode.trim();
    if (!isQuadCode(code)) return setError('Code attendu : AAAA/n, n de 1 à 3.');
    const p = quadPeriod(code);
    const slot = defaultBoardSlot(code);
    const res = await supabase.from('quadrimesters').insert({
      code,
      start_date: p.start,
      end_date: p.end,
      payment_close_date: p.paymentClose,
      board_slot_start: slot.start,
      board_slot_end: slot.end,
      board_status: 'estimated',
      board_source: 'Créneau par défaut',
    });
    if (res.error) return setError(res.error.message);
    await qc.invalidateQueries();
    navigate(`/admin/quadrimestres/${code.replace('/', '-')}`);
  }

  return (
    <>
      <div className="spread">
        <h1 className="page-title">Quadrimestres</h1>
        <button type="button" className="btn" onClick={() => setShowImport((v) => !v)}><IconUpload />Importer des prix officiels (CSV)</button>
      </div>
      {showImport && (
        <Panel title="Import des prix officiels">
          <OfficialPricesImport onDone={() => setShowImport(false)} />
        </Panel>
      )}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th scope="col">Code</th><th scope="col">Période</th><th scope="col">CA</th><th scope="col" className="num">Prix officiel</th><th scope="col" className="num">Recalculé</th><th scope="col" /></tr>
          </thead>
          <tbody>
            {rows.map((q) => (
              <tr key={q.code}>
                <th scope="row">{q.code}</th>
                <td className="muted">{dateRange(q.start_date, q.end_date)}</td>
                <td>
                  {q.board_date ? <span className="mono">{dateFr(q.board_date)}</span> : q.board_slot_start && q.board_slot_end ? dateRange(q.board_slot_start, q.board_slot_end) : '—'}{' '}
                  <span className="chip">{q.board_status === 'known' ? 'connue' : q.board_status === 'inferred' ? 'inférée' : 'estimée'}</span>
                </td>
                <td className="num">{euro(q.official_price === null ? null : Number(q.official_price))}</td>
                <td className="num">
                  {q.computed_price === null ? (q.computed_missing ? `${q.computed_missing} séance(s) manquante(s)` : '—') : euro(Number(q.computed_price))}
                  {q.computed_price !== null && q.official_price !== null && Number(q.computed_price) !== Number(q.official_price) && <span className="status-error"> ≠</span>}
                </td>
                <td><Link to={`/admin/quadrimestres/${q.code.replace('/', '-')}`}>Modifier</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form onSubmit={create} className="inline" style={{ alignItems: 'flex-end' }}>
        <label className="field">Nouveau quadrimestre
          <input placeholder="2027/2" value={newCode} onChange={(e) => setNewCode(e.target.value)} className="mono" style={{ width: 140 }} />
        </label>
        <button type="submit" className="btn">Créer</button>
        {error && <span className="status-error">{error}</span>}
      </form>
    </>
  );
}
