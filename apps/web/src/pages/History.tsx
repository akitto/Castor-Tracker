import { compareQuad, parseQuadCode, prevQuad, windowSessions } from '@castor/core';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { IconDownload } from '../components/Icons';
import { Loading } from '../components/Guards';
import { toEstimateParams, useActiveParams, useCalendar, useDashboard, useHistory, useLatestBacktest } from '../lib/data';
import { dateFr, dateRange, dayMonth, euro, euroDiff, pct, periodLabel, reliabilityInt } from '../lib/format';
import type { HistoryRow } from '../lib/supabase';
import { Disclaimer } from './Dashboard';

type Line = { kind: 'row'; row: HistoryRow } | { kind: 'gap'; from: string; to: string; count: number };

const KIND_LABEL: Record<string, string> = { final: 'à l’annonce', replay: 'rejeu', scheduled: 'du jour', manual: 'du jour' };

function csvValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v).replace('.', ',');
  const s = String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function History() {
  const history = useHistory();
  const dash = useDashboard();
  const params = useActiveParams();
  const calendar = useCalendar();
  const backtest = useLatestBacktest('formula');
  const [query, setQuery] = useState('');
  const [year, setYear] = useState('');
  const p = toEstimateParams(params.data);
  const rows = useMemo(() => [...(history.data ?? [])].sort((a, b) => compareQuad(b.code as string, a.code as string)), [history.data]);
  const years = useMemo(() => [...new Set(rows.map((r) => (r.code as string).slice(0, 4)))].sort().reverse(), [rows]);

  const lines = useMemo<Line[]>(() => {
    const filtered = rows.filter(
      (r) => (!year || (r.code as string).startsWith(year)) && (!query || JSON.stringify(r).toLowerCase().includes(query.toLowerCase())),
    );
    const out: Line[] = [];
    filtered.forEach((r, i) => {
      out.push({ kind: 'row', row: r });
      const next = filtered[i + 1];
      if (!next || query) return;
      let missing = 0;
      let first = '';
      let last = '';
      for (let q = prevQuad(r.code as string); compareQuad(q, next.code as string) > 0; q = prevQuad(q)) {
        if (!last) last = q;
        first = q;
        missing++;
      }
      if (missing > 0) out.push({ kind: 'gap', from: first, to: last, count: missing });
    });
    return out;
  }, [rows, query, year]);

  if (history.isLoading) return <Loading />;
  const known = rows.filter((r) => r.official_price !== null).length;
  const estimated = rows.filter((r) => r.official_price === null && r.estimate_central !== null).length;
  const quote = dash.data?.quote_price ?? dash.data?.last_close ?? null;

  function exportCsv() {
    const header = ['quadrimestre', 'debut', 'fin', 'fermeture_versements', 'date_ca', 'statut_ca', 'creneau_debut', 'creneau_fin',
      'prix_officiel', 'prix_recalcule', 'prix_estime', 'p05', 'p95', 'indice_fiabilite', 'type_estimation', 'ecart_estime_reel',
      'plus_value_cours_actuel', 'source', 'avis'];
    const body = rows.map((r) => [r.code, r.start_date, r.end_date, r.payment_close_date, r.board_date, r.board_status, r.board_slot_start,
      r.board_slot_end, r.official_price, r.computed_price, r.estimate_central, r.estimate_p05, r.estimate_p95, r.estimate_reliability,
      r.estimate_kind, r.estimate_diff, r.gain_pct, r.board_source, r.notice_url].map(csvValue).join(';'));
    const blob = new Blob([`﻿${[header.join(';'), ...body].join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `castor-historique-${dash.data?.today ?? 'export'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const summary = backtest.data?.summary as { best?: { label: string; nExact: number; n: number }; exact?: string | null } | undefined;
  const byType = [1, 2, 3].map((i) => ({
    index: i,
    dates: rows.filter((r) => r.board_date && parseQuadCode(r.code as string).index === i).map((r) => r.board_date as string),
  }));

  return (
    <main className="page">
      <div className="page-head">
        <div className="page-head__titles">
          <h1 className="page-title">Historique des quadrimestres</h1>
          <p className="muted">
            Prix estimé et prix réel de chaque quadrimestre, avec la date du CA et la fenêtre de {p.windowDays} séances.
            {quote !== null && ` Plus-value calculée au cours actuel de ${euro(Number(quote))}.`}
          </p>
        </div>
      </div>
      <div className="spread">
        <div className="inline">
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center' }}>
            <span className="visually-hidden">Rechercher</span>
            <input type="search" placeholder="Rechercher" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center' }}>
            <span className="visually-hidden">Année</span>
            <select value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">Toutes les années</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
        </div>
        <div className="inline">
          <span className="small muted">{known} quadrimestre{known > 1 ? 's' : ''} connu{known > 1 ? 's' : ''}, {estimated} estimé{estimated > 1 ? 's' : ''}</span>
          <button type="button" className="btn" onClick={exportCsv}><IconDownload />Exporter en CSV</button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="data" style={{ minWidth: 1040 }}>
          <thead>
            <tr>
              <th scope="col">Quadrimestre</th>
              <th scope="col">Souscription</th>
              <th scope="col">CA</th>
              <th scope="col">Fenêtre de {p.windowDays} séances</th>
              <th scope="col" className="num">Prix estimé</th>
              <th scope="col" className="num">Prix réel</th>
              <th scope="col" className="num">Écart</th>
              <th scope="col" className="num">Plus-value</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              if (l.kind === 'gap') {
                return (
                  <tr key={`gap-${l.from}`} className="gap">
                    <td colSpan={9}>
                      {l.count > 1 ? `${l.from} → ${l.to}` : l.from} · {l.count} quadrimestre{l.count > 1 ? 's' : ''} non renseigné{l.count > 1 ? 's' : ''} · saisie réservée à l’admin
                    </td>
                  </tr>
                );
              }
              const r = l.row;
              const current = r.code === dash.data?.next_code;
              const win = r.board_date ? windowSessions(calendar, r.board_date, p) : null;
              const diff = r.estimate_diff === null ? null : Number(r.estimate_diff);
              const gain = r.gain_pct === null ? null : Number(r.gain_pct);
              return (
                <tr key={r.code} className={current ? 'current' : undefined}>
                  <th scope="row">
                    <span className="inline" style={{ gap: 8 }}>
                      {r.code}
                      {current && <span className="chip chip--accent">En cours</span>}
                      {!current && r.official_price === null && <span className="chip">À venir</span>}
                    </span>
                  </th>
                  <td className="muted nowrap">{r.start_date && r.end_date ? periodLabel(r.start_date, r.end_date) : '—'}</td>
                  <td className="nowrap">
                    {r.board_date ? (
                      <>
                        <span className="mono">{dateFr(r.board_date)}</span>
                        {r.board_status !== 'known' && <span className="sub">{r.board_status === 'inferred' ? 'date inférée' : 'date présumée'}</span>}
                      </>
                    ) : r.board_slot_start && r.board_slot_end ? (
                      <>
                        <span>{dateRange(r.board_slot_start, r.board_slot_end)}</span>
                        <span className="sub">créneau</span>
                      </>
                    ) : '—'}
                  </td>
                  <td className={win ? 'mono muted nowrap' : 'muted'}>{win ? `${dayMonth(win[0])} → ${dateFr(win[win.length - 1])}` : 'Selon la date du CA'}</td>
                  <td className="num">
                    {r.estimate_central !== null ? (
                      <>
                        <span style={{ fontWeight: current ? 600 : 400 }}>{euro(Number(r.estimate_central))}</span><br />
                        <span className="xsmall muted" style={{ fontFamily: 'var(--sans)' }}>
                          IF {reliabilityInt(r.estimate_reliability)} · {current ? `${euro(Number(r.estimate_p05)).replace(/\s?€/, '')} – ${euro(Number(r.estimate_p95))}` : KIND_LABEL[r.estimate_kind ?? ''] ?? ''}
                        </span>
                      </>
                    ) : '—'}
                  </td>
                  <td className="num">
                    {r.official_price !== null ? (
                      <>
                        <span className="strong">{euro(Number(r.official_price))}</span>
                        {r.computed_price !== null && (
                          <><br /><span className="xsmall muted" style={{ fontFamily: 'var(--sans)' }}>
                            recalculé {euro(Number(r.computed_price))}{Number(r.computed_price) === Number(r.official_price) ? ' ✓' : ''}
                          </span></>
                        )}
                      </>
                    ) : <span className="muted" style={{ fontStyle: 'italic' }}>à l’annonce</span>}
                  </td>
                  <td className="num" style={{ color: diff === 0 ? 'var(--accent-strong)' : undefined }}>{euroDiff(diff)}</td>
                  <td className={`num strong ${gain === null ? '' : gain >= 0 ? 'up' : 'down'}`}>{pct(gain)}</td>
                  <td className="muted">
                    {r.notice_url ? (
                      <a href={r.notice_url} target="_blank" rel="noreferrer noopener">
                        {r.official_published_at ? `Avis du ${dateFr(r.official_published_at)}` : 'Avis VINCI'}
                      </a>
                    ) : current ? 'Estimation du jour' : r.board_source ?? '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Prix estimé : estimation archivée à l’annonce du prix ; avant la mise en service, il vient du rejeu du modèle à la
        fermeture des versements du quadrimestre précédent (créneau de CA par défaut). Écart = estimé − réel.
      </p>

      <div className="row">
        <section className="card col-main">
          <div className="spread">
            <h2 className="card__title card__title--lg">Contrôle de la formule</h2>
            <span className={`chip ${summary?.exact ? 'chip--accent' : 'chip--warn'}`}>{backtest.data ? (summary?.exact ? 'Formule vérifiée' : 'À vérifier') : 'À lancer'}</span>
          </div>
          <p className="small muted">
            Recalcule les prix de référence avec chaque variante (type de cours, arrondi, jour du CA) et retient celle qui
            les retrouve au centime.
          </p>
          {summary?.best && (
            <p className="small">
              Dernier backtest : <strong>{summary.best.label}</strong>, {summary.best.nExact}/{summary.best.n} prix retrouvés au centime.
            </p>
          )}
          <p className="small"><Link to="/methode">Détail dans la page Méthode</Link></p>
        </section>
        <section className="card col-side">
          <h2 className="card__title card__title--lg">Quand le CA fixe-t-il le prix ?</h2>
          <p className="small muted">Environ deux mois et demi avant l’ouverture du quadrimestre, d’après les avis publiés.</p>
          <dl className="facts">
            {byType.map((t) => (
              <div key={t.index} style={{ display: 'contents' }}>
                <dt>Prix /{t.index}</dt>
                <dd>{t.dates.length ? t.dates.slice(0, 3).map((d) => dateFr(d)).join(' · ') : '—'}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      <Disclaimer />
    </main>
  );
}
