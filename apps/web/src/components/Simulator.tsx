import { whatIfPrice, type Dividend, type EstimateParams, type Session, type TradingCalendar, parisDateOf } from '@castor/core';
import { useEffect, useMemo, useState } from 'react';
import type { EstimateDetails } from '../lib/data';
import { euro, weekdayDate } from '../lib/format';
import type { DashboardRow } from '../lib/supabase';

/** EF-06 : prix obtenu si les séances restantes cotent un cours supposé (même moteur que les fonctions). */
export default function Simulator({ dash, details, sessions, calendar, dividends, params }: {
  dash: DashboardRow;
  details: EstimateDetails;
  sessions: Session[];
  calendar: TradingCalendar;
  dividends: Dividend[];
  params: EstimateParams;
}) {
  const last = Number(dash.quote_price ?? dash.last_close ?? dash.estimate_last_price ?? 0);
  const candidates = details.candidates ?? [];
  const [board, setBoard] = useState<string>(dash.most_probable_date ?? candidates[0]?.date ?? '');
  const [assumed, setAssumed] = useState<number>(last);
  useEffect(() => setAssumed(last), [last]);
  useEffect(() => {
    if (dash.most_probable_date) setBoard(dash.most_probable_date);
  }, [dash.most_probable_date]);

  const lastPriceDate = dash.quote_time ? parisDateOf(Date.parse(dash.quote_time)) : dash.last_session ?? undefined;
  const result = useMemo(() => {
    if (!board || !(assumed > 0) || !dash.today || sessions.length === 0) return null;
    try {
      return whatIfPrice({ sessions, asOf: dash.today, lastPriceDate, boardDate: board, assumedPrice: assumed, params, dividends, calendar });
    } catch {
      return null;
    }
  }, [board, assumed, dash.today, sessions, lastPriceDate, params, dividends, calendar]);

  if (!(last > 0) || !board) return null;
  const min = Math.floor(last * 0.8);
  const max = Math.ceil(last * 1.2);
  const factor = ((10_000 - params.discountBps) / 10_000).toLocaleString('fr-FR');
  const remaining = result?.remaining ?? 0;

  return (
    <section className="card" aria-labelledby="simu-title" style={{ gap: 16 }}>
      <h2 id="simu-title" className="card__title card__title--lg">Simulateur « et si »</h2>
      {candidates.length > 1 && (
        <label className="field">
          Date du CA
          <select value={board} onChange={(e) => setBoard(e.target.value)}>
            {candidates.map((c) => (
              <option key={c.date} value={c.date}>
                {weekdayDate(c.date)}{c.date === dash.most_probable_date ? ' (plus probable)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {remaining > 0 ? (
        <div className="stack">
          <label htmlFor="simu-cours" className="muted" style={{ fontSize: 14 }}>
            Cours d’ouverture supposé pour {remaining === 1 ? 'la séance restante' : `les ${remaining} séances restantes`}
          </label>
          <input id="simu-cours" type="range" min={min} max={max} step={0.1} value={assumed}
            onChange={(e) => setAssumed(Number(e.target.value))} aria-valuetext={euro(assumed)} />
          <div className="spread mono xsmall muted">
            <span>{min} €</span>
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{euro(assumed)}</span>
            <span>{max} €</span>
          </div>
        </div>
      ) : (
        <p className="small muted">Fenêtre complète pour cette date : le prix ne dépend plus du cours.</p>
      )}
      <div className="result-box">
        <p className="small muted">Prix {dash.next_code} obtenu (CA le {weekdayDate(board)})</p>
        <p className="mid-price">{euro(result?.price ?? null)}</p>
        {result && (
          <p className="small muted">
            {result.known} séance{result.known > 1 ? 's' : ''} réelle{result.known > 1 ? 's' : ''}
            {remaining > 0 ? ` + ${remaining} au cours supposé` : ''}, × {factor}
            {dividends.some((d) => d.exDate > dash.today! && d.exDate <= result.windowEnd) ? ', dividende déduit après détachement' : ''}
          </p>
        )}
      </div>
      {remaining > 0 && (
        <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setAssumed(last)}>
          Revenir au dernier cours
        </button>
      )}
    </section>
  );
}
