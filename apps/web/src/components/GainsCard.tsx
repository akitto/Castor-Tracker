import { compareQuad, gainPct, gainRange, prevQuad } from '@castor/core';
import { Link } from 'react-router-dom';
import { euro, pct } from '../lib/format';
import type { DashboardRow, HistoryRow } from '../lib/supabase';

interface GainItem {
  code: string;
  label: string;
  price: number;
  gain: number;
  estimated: boolean;
  range?: { low: number; high: number };
}

/** EF-13 : plus-value latente au cours actuel, par quadrimestre (hors abondement). */
export default function GainsCard({ dash, history, limit = 8 }: { dash: DashboardRow; history: HistoryRow[]; limit?: number }) {
  const current = dash.quote_price ?? dash.last_close;
  if (current === null) return null;
  const c = Number(current);
  const items: GainItem[] = [];
  if (dash.next_code && dash.central !== null) {
    const central = Number(dash.central);
    items.push({
      code: dash.next_code,
      label: `${dash.next_code} estimé`,
      price: central,
      gain: gainPct(c, central),
      estimated: true,
      range: dash.p05 !== null && dash.p95 !== null ? gainRange(c, Number(dash.p05), Number(dash.p95)) : undefined,
    });
  }
  const official = history
    .filter((h) => h.official_price !== null && h.code)
    .sort((a, b) => compareQuad(b.code as string, a.code as string));
  for (const h of official.slice(0, limit)) {
    const p = Number(h.official_price);
    items.push({ code: h.code as string, label: h.code as string, price: p, gain: gainPct(c, p), estimated: false });
  }
  const maxAbs = Math.max(0.05, ...items.map((i) => Math.abs(i.gain)));
  // Quadrimestres sans prix officiel entre le plus ancien connu et le quadrimestre en cours.
  const codes = new Set(official.map((h) => h.code as string));
  let missing = 0;
  if (official.length > 0 && dash.current_code) {
    const oldest = official[official.length - 1].code as string;
    for (let q = dash.current_code; compareQuad(q, oldest) > 0; q = prevQuad(q)) if (!codes.has(q)) missing++;
  }

  return (
    <section className="card" aria-labelledby="gains-title" style={{ gap: 16 }}>
      <div className="spread" style={{ alignItems: 'baseline' }}>
        <h2 id="gains-title" className="card__title card__title--lg">Plus-value au cours actuel ({euro(c)})</h2>
        <p className="small muted">Hors abondement, frais et dividendes</p>
      </div>
      <div className="stack" style={{ gap: 10 }}>
        {items.map((it) => {
          const width = `${((Math.abs(it.gain) / maxAbs) * 48).toFixed(2)}%`;
          const cls = it.gain >= 0 ? 'pos' : 'neg';
          return (
            <div key={it.code} className="gain-row">
              <span className="strong">{it.label}</span>
              <span className="mono muted">{euro(it.price)}</span>
              <div className="gain-bar" aria-hidden="true">
                <div className="gain-bar__zero" />
                <div className={`gain-bar__fill ${cls} ${it.estimated ? 'est' : ''}`} style={{ width }} />
              </div>
              <span className={`mono strong ${it.gain >= 0 ? 'up' : 'down'}`} style={{ textAlign: 'right' }}
                title={it.range ? `de ${pct(it.range.low)} à ${pct(it.range.high)} selon l’intervalle à 90 %` : undefined}>
                {pct(it.gain)}
              </span>
            </div>
          );
        })}
      </div>
      <p className="small muted">
        {missing > 0 ? `${missing} quadrimestre${missing > 1 ? 's' : ''} sans prix officiel saisi. ` : ''}
        <Link to="/historique">Voir l’historique complet</Link>
      </p>
    </section>
  );
}
