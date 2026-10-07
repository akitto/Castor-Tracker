import { reliabilityLabel, type EstimateParams } from '@castor/core';
import { formulaText } from '../lib/data';
import { amount, euro, euroShort, pct, probability, reliabilityInt, stampShort } from '../lib/format';
import type { DashboardRow } from '../lib/supabase';

const STATE_TEXT: Record<string, string> = {
  projection: 'Projection : fenêtre de 20 séances pas encore commencée',
  window: 'Fenêtre en cours : séances connues et séances simulées',
  frozen: 'CA passé, date incertaine : prix exact pour chaque date candidate, pondéré',
  computed: 'Prix calculé au centime : date du CA connue, fenêtre complète',
};

function chipClass(reliability: number): string {
  if (reliability >= 80) return 'chip chip--lg chip--accent';
  if (reliability >= 50) return 'chip chip--lg chip--warn';
  return 'chip chip--lg';
}

/** EF-02 : prochain prix estimé, intervalle à 90 %, indice de fiabilité, arbitrage. */
export default function EstimateCard({ dash, params }: { dash: DashboardRow; params: EstimateParams }) {
  const code = dash.next_code ?? '—';
  if (dash.central === null || dash.p05 === null || dash.p95 === null) {
    return (
      <section className="card card--hero" aria-labelledby="estim-title">
        <h2 id="estim-title" className="card__title">Prochain prix estimé · {code}</h2>
        <p className="muted">
          Pas encore d’estimation. Elle apparaît après la première collecte de cours (reprise de l’historique dans
          l’administration).
        </p>
      </section>
    );
  }
  const central = Number(dash.central);
  const p05 = Number(dash.p05);
  const p95 = Number(dash.p95);
  const reliability = reliabilityInt(dash.reliability);
  const label = reliabilityLabel(reliability);
  const ref = dash.current_price === null ? null : Number(dash.current_price);
  const spread = Math.max(p95 - p05, central * 0.04);
  const lo = Math.floor(Math.min(p05, ref ?? p05) - spread * 0.5);
  const hi = Math.ceil(Math.max(p95, ref ?? p95) + spread * 0.5);
  const pos = (v: number) => `${(((v - lo) / (hi - lo)) * 100).toFixed(2)}%`;
  const tol = params.toleranceBps / 100;
  const segment = reliability >= 95 ? 3 : reliability >= 80 ? 2 : reliability >= 50 ? 1 : 0;
  const known = dash.known_sessions ?? 0;
  const knownRange =
    dash.known_min !== null && dash.known_max !== null && dash.known_min !== dash.known_max
      ? `${dash.known_min} à ${dash.known_max} selon la date du CA`
      : null;

  return (
    <section className="card card--hero" aria-labelledby="estim-title">
      <div className="spread">
        <h2 id="estim-title" className="card__title">Prochain prix estimé · {code}</h2>
        <span className={chipClass(reliability)}>
          {dash.state === 'computed' ? 'Calculé' : label} · IF {reliability}/100
        </span>
      </div>
      <div className="inline" style={{ alignItems: 'baseline', gap: '8px 20px' }}>
        <p className="big-price">{euro(central)}</p>
        <p className="muted">{formulaText(params)}</p>
      </div>

      <div className="stack">
        <div className="spread small muted">
          <span>Intervalle à 90 %</span>
          <span className="mono" style={{ color: 'var(--text)' }}>
            {amount(p05)} – {euro(p95)}
          </span>
        </div>
        <div className="range" aria-hidden="true">
          <div className="range__axis" />
          <div className="range__band" style={{ left: pos(p05), width: `calc(${pos(p95)} - ${pos(p05)})` }} />
          {ref !== null && ref >= lo && ref <= hi && <div className="range__ref" style={{ left: pos(ref) }} title={`Prix ${dash.current_code}`} />}
          <div className="range__mark" style={{ left: pos(central) }} />
        </div>
        <div className="spread mono xsmall muted">
          <span>{euroShort(lo)}</span>
          <span>{euroShort((lo + hi) / 2)}</span>
          <span>{euroShort(hi)}</span>
        </div>
      </div>

      <div className="stack">
        <div className="spread small muted">
          <span>Indice de fiabilité</span>
          <span className="mono" style={{ color: 'var(--text)' }}>{reliability} / 100</span>
        </div>
        <div className="gauge" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={reliability} aria-label="Indice de fiabilité">
          <span /><span /><span /><span />
          <div className="gauge__mark" style={{ left: `${reliability}%` }} />
        </div>
        <div className="gauge-labels">
          {['Spéculatif', 'Indicatif', 'Fiable', ''].map((l, i) => (
            <span key={i} className={i === segment ? 'on' : undefined}>{l}</span>
          ))}
        </div>
        <p className="small muted">
          {reliability} % de chances, selon le modèle, que le prix officiel tombe à ±{tol.toLocaleString('fr-FR')} % de
          l’estimation. {dash.state ? STATE_TEXT[dash.state] ?? '' : ''}.
        </p>
      </div>

      <div className="stats">
        <div className="stat">
          <p className="small muted">Écart avec {dash.current_code} ({euro(ref)})</p>
          <p className="stat-value">{ref ? pct(central / ref - 1) : '—'}</p>
        </div>
        <div className="stat">
          <p className="small muted">Probabilité que {code} soit sous {dash.current_code}</p>
          <p className="stat-value">{probability(dash.prob_below === null ? null : Number(dash.prob_below))}</p>
        </div>
        <div className="stat">
          <p className="small muted">{params.priceField === 'open' ? 'Ouvertures' : 'Séances'} connues</p>
          <p className="stat-value">{known} / {params.windowDays}</p>
          {knownRange && <p className="xsmall muted">{knownRange}</p>}
        </div>
      </div>
      <p className="xsmall muted">
        Calculée le {stampShort(dash.computed_at)} · {dash.n_sims ? `${Number(dash.n_sims).toLocaleString('fr-FR')} tirages` : 'calcul exact'} ·
        graine {dash.seed ?? '—'}
      </p>
    </section>
  );
}
