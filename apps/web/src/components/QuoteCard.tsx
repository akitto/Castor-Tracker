import type { Session } from '@castor/core';
import { euro, pct, timeOnly } from '../lib/format';
import type { DashboardRow } from '../lib/supabase';
import Sparkline from './Sparkline';

/** EF-04 : dernier cours VINCI, variation du jour, heure et source. */
export default function QuoteCard({ dash, sessions }: { dash: DashboardRow; sessions: Session[] }) {
  const price = dash.quote_price ?? dash.last_close;
  const change = dash.quote_change_pct === null ? null : Number(dash.quote_change_pct);
  const recent = sessions.slice(-60).map((s) => s.close ?? s.open).filter((v): v is number => typeof v === 'number');
  const firstDate = sessions.length > 60 ? sessions[sessions.length - 60].date : sessions[0]?.date;
  return (
    <section className="card" aria-labelledby="cours-title" style={{ gap: 10 }}>
      <div className="spread">
        <h2 id="cours-title" className="card__title">Cours VINCI</h2>
        <span className="xsmall muted">Euronext Paris · DG</span>
      </div>
      <div className="inline" style={{ alignItems: 'baseline', gap: '4px 12px' }}>
        <p className="mid-price">{euro(price === null ? null : Number(price))}</p>
        {change !== null && (
          <p className={`mono strong ${change >= 0 ? 'up' : 'down'}`} style={{ fontSize: 15 }}>{pct(change, 2)}</p>
        )}
      </div>
      <Sparkline values={recent} />
      <p className="xsmall muted">
        {firstDate ? `Depuis le ${new Date(firstDate + 'T00:00:00Z').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' })}` : ''}
        {dash.quote_day_open ? ` · ouverture du jour ${euro(Number(dash.quote_day_open))}` : ''}
        {dash.quote_time ? ` · cours de ${timeOnly(dash.quote_time)} (${dash.quote_source ?? 'source'}, différé 15 min)` : ''}
      </p>
    </section>
  );
}
