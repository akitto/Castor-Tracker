import { Link } from 'react-router-dom';
import type { EstimateDetails } from '../lib/data';
import { dateRange, dayMonth, relativeDays, weekdayDate } from '../lib/format';
import type { DashboardRow } from '../lib/supabase';

/** EF-03 : date ou créneau du CA, compte à rebours, frise des 20 séances. */
export default function BoardCard({ dash, details, isAdmin, windowDays }: {
  dash: DashboardRow;
  details: EstimateDetails;
  isAdmin: boolean;
  windowDays: number;
}) {
  const today = dash.today ?? '';
  const hasDate = Boolean(dash.board_date);
  const slot = dash.board_slot_start && dash.board_slot_end ? { start: dash.board_slot_start, end: dash.board_slot_end } : null;
  const probable = dash.most_probable_date ?? dash.board_date ?? null;
  const last = hasDate ? dash.board_date : slot?.end ?? null;
  const past = last !== null && last < today;
  const status = past
    ? 'Passé'
    : hasDate
      ? dash.board_status === 'inferred' ? 'Date inférée' : dash.board_status === 'known' ? 'Date connue' : 'Date estimée'
      : 'Créneau estimé';
  const window = details.window ?? [];
  const known = window.filter((w) => w.known).length;
  const code = dash.next_code ? dash.next_code.replace('/', '-') : '';

  return (
    <section className="card" aria-labelledby="ca-title">
      <div className="spread">
        <h2 id="ca-title" className="card__title">Conseil d’administration</h2>
        <span className={`chip ${hasDate && dash.board_status === 'known' ? 'chip--accent' : ''}`}>{status}</span>
      </div>
      <p style={{ fontSize: 26, lineHeight: 1.2, fontWeight: 600 }}>
        {hasDate ? weekdayDate(dash.board_date) + ' ' + (dash.board_date ?? '').slice(0, 4) : slot ? dateRange(slot.start, slot.end) : 'Non renseigné'}
      </p>
      {probable && (
        <p className="muted" style={{ fontSize: 14 }}>
          {hasDate ? 'Prix figé ' : 'Date la plus probable : '}
          {!hasDate && <strong style={{ color: 'var(--text)' }}>{weekdayDate(probable)}</strong>}
          {hasDate ? (past ? 'depuis le CA' : relativeDays(probable, today)) : ` · ${relativeDays(probable, today)}`}
        </p>
      )}
      {window.length > 0 && (
        <figure style={{ margin: 0 }} className="stack">
          <div className="frise" aria-hidden="true">
            {window.map((w) => (
              <span key={w.date} className={`${w.known ? 'known' : ''} ${w.date === today ? 'today' : ''}`} title={`${dayMonth(w.date)}${w.value ? ` · ${w.value.toLocaleString('fr-FR')} €` : ''}`} />
            ))}
          </div>
          <div className="spread xsmall muted">
            <span>{dayMonth(window[0].date)}</span>
            <span>{dayMonth(window[window.length - 1].date)}</span>
          </div>
          <figcaption className="inline small muted" style={{ gap: '6px 16px' }}>
            <span className="inline" style={{ gap: 6 }}>
              <span className="legend-dot" style={{ background: 'var(--accent)' }} />
              {known} séance{known > 1 ? 's' : ''} connue{known > 1 ? 's' : ''}
            </span>
            <span className="inline" style={{ gap: 6 }}>
              <span className="legend-dot" style={{ border: '1px solid var(--faint)' }} />
              {windowDays - known} à venir
            </span>
            {!hasDate && probable && <span>pour un CA le {weekdayDate(probable)}</span>}
          </figcaption>
        </figure>
      )}
      <p className="xsmall muted">
        {dash.board_source ?? 'Source non renseignée'}.{' '}
        {isAdmin && code && <Link to={`/admin/quadrimestres/${code}`}>Modifier</Link>}
      </p>
    </section>
  );
}
