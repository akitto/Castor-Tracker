import { describe, expect, it } from 'vitest';
import {
  candidateDates,
  dailyReturns,
  estimate,
  mostProbable,
  quantileSorted,
  reliabilityLabel,
  standardDeviation,
  subscriptionPrice,
  TradingCalendar,
  weightedQuantile,
  whatIfPrice,
  windowSessions,
  DEFAULT_FORMULA,
} from '../src/index.ts';
import { flatSessions, syntheticSessions } from './helpers.ts';

const cal = new TradingCalendar();

describe('dates candidates', () => {
  it('répartit uniformément sur les séances du créneau', () => {
    const c = candidateDates(cal, { mode: 'slot', start: '2026-10-14', end: '2026-10-23' });
    expect(c.map((x) => x.date)).toEqual([
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
    ]);
    expect(c.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1, 12);
    expect(mostProbable(c).date).toBe('2026-10-19');
  });

  it('respecte les poids saisis', () => {
    const c = candidateDates(cal, {
      mode: 'slot',
      start: '2026-10-14',
      end: '2026-10-16',
      weights: { '2026-10-15': 3, '2026-10-16': 1 },
    });
    expect(c).toEqual([
      { date: '2026-10-15', weight: 0.75 },
      { date: '2026-10-16', weight: 0.25 },
    ]);
    expect(mostProbable(c).date).toBe('2026-10-15');
  });

  it('revient à l’uniforme si les poids sont nuls', () => {
    const c = candidateDates(cal, { mode: 'slot', start: '2026-10-14', end: '2026-10-15', weights: { '2026-10-14': 0 } });
    expect(c).toHaveLength(2);
    expect(c[0].weight).toBe(0.5);
  });

  it('accepte une date unique et rejette un créneau inversé', () => {
    expect(candidateDates(cal, { mode: 'date', date: '2026-10-15' })).toEqual([{ date: '2026-10-15', weight: 1 }]);
    expect(() => candidateDates(cal, { mode: 'slot', start: '2026-10-23', end: '2026-10-14' })).toThrow();
    expect(candidateDates(cal, { mode: 'slot', start: '2026-10-10', end: '2026-10-11' })).toEqual([
      { date: '2026-10-10', weight: 1 },
    ]);
    expect(() => mostProbable([])).toThrow();
  });
});

describe('statistiques', () => {
  it('quantiles et écart-type', () => {
    const sorted = Float64Array.from([1, 2, 3, 4, 5]);
    expect(quantileSorted(sorted, 0.5)).toBe(3);
    expect(quantileSorted(sorted, 0.25)).toBe(2);
    expect(quantileSorted(sorted, 0.1)).toBeCloseTo(1.4, 12);
    expect(quantileSorted(new Float64Array(0), 0.5)).toBeNaN();
    expect(quantileSorted([7], 0.9)).toBe(7);
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(standardDeviation([1])).toBe(0);
    expect(weightedQuantile([10, 20, 30], [0.2, 0.5, 0.3], 0.5)).toBe(20);
    expect(weightedQuantile([10, 20, 30], [0.2, 0.5, 0.3], 0.05)).toBe(10);
    expect(weightedQuantile([10, 20, 30], [0.2, 0.5, 0.3], 0.95)).toBe(30);
  });

  it('libelle l’indice de fiabilité', () => {
    expect(reliabilityLabel(100)).toBe('Quasi certain');
    expect(reliabilityLabel(87)).toBe('Fiable');
    expect(reliabilityLabel(60)).toBe('Indicatif');
    expect(reliabilityLabel(12)).toBe('Spéculatif');
  });
});

describe('rendements', () => {
  it('rajoute le dividende détaché et recentre', () => {
    const sessions = [
      { date: '2026-10-08', open: 100 },
      { date: '2026-10-09', open: 101 },
      { date: '2026-10-12', open: 102 },
      { date: '2026-10-13', open: 100.9 }, // détachement de 1,10 €
    ];
    const { returns } = dailyReturns(sessions, 'open', '2026-10-13', 250, [{ exDate: '2026-10-13', amount: 1.1 }]);
    expect(returns).toHaveLength(3);
    expect(returns.reduce((s, r) => s + r, 0)).toBeCloseTo(0, 12);
    // corrigé du dividende, le dernier rendement brut est nul (sans correction : −1,08 %)
    const mean = (Math.log(101 / 100) + Math.log(102 / 101) + 0) / 3;
    expect(returns[2]).toBeCloseTo(-mean, 12);
  });

  it('écarte les rendements aberrants et ignore le futur', () => {
    const sessions = [
      { date: '2026-10-08', open: 100 },
      { date: '2026-10-09', open: 200 },
      { date: '2026-10-12', open: 201 },
      { date: '2026-10-13', open: 50 },
    ];
    const r = dailyReturns(sessions, 'open', '2026-10-12', 250);
    expect(r.outliers).toBe(1);
    expect(r.returns).toHaveLength(1);
    expect(dailyReturns([], 'open', '2026-10-12', 250).returns).toEqual([]);
  });
});

describe('estimation (RG-07 à RG-10)', () => {
  const history = syntheticSessions('2025-06-02', '2026-10-07', 7, 118, cal);
  const last = history[history.length - 1];

  it('est exacte quand le CA est passé et la date connue (REC-03)', () => {
    const r = estimate({
      sessions: history,
      asOf: '2026-10-07',
      lastPrice: last.close as number,
      board: { mode: 'date', date: '2026-06-23' },
      referencePrice: 1000,
    });
    const window = windowSessions(cal, '2026-06-23', DEFAULT_FORMULA);
    const exact = subscriptionPrice(
      window.map((d) => history.find((s) => s.date === d)?.open as number),
      DEFAULT_FORMULA,
    );
    expect(r.state).toBe('computed');
    expect(r.deterministic).toBe(true);
    expect(r.nSims).toBe(0);
    expect(r.central).toBe(exact);
    expect(r.p05).toBe(exact);
    expect(r.p95).toBe(exact);
    expect(r.reliability).toBe(100);
    expect(r.probBelow).toBe(1);
    expect(r.knownMostProbable).toBe(20);
    expect(r.candidates[0].exact).toBe(exact);
  });

  it('donne le même résultat pour la même graine (REC-04)', () => {
    const input = {
      sessions: history,
      asOf: '2026-10-07',
      lastPrice: last.close as number,
      board: { mode: 'slot' as const, start: '2026-10-14', end: '2026-10-23' },
      dividends: [{ exDate: '2026-10-13', amount: 1.1 }],
      referencePrice: 119.33,
      params: { nSims: 3000 },
    };
    const a = estimate({ ...input, seed: 42 });
    const b = estimate({ ...input, seed: 42 });
    const c = estimate({ ...input, seed: 43 });
    expect(a).toEqual(b);
    expect(a.seed).toBe(42);
    expect(c.seed).toBe(43);
    expect([c.p05, c.p95, c.reliability]).not.toEqual([a.p05, a.p95, a.reliability]);
    expect(a.state).toBe('window');
    expect(a.knownMax).toBe(16);
    expect(a.knownMin).toBe(9);
    expect(a.candidates).toHaveLength(8);
    expect(a.mostProbableDate).toBe('2026-10-19');
    expect(a.knownMostProbable).toBe(13);
    expect(a.windowUnion).toEqual({ start: '2026-09-16', end: '2026-10-22' });
    expect(a.p05).toBeLessThanOrEqual(a.p25);
    expect(a.p25).toBeLessThanOrEqual(a.central);
    expect(a.central).toBeLessThanOrEqual(a.p75);
    expect(a.p75).toBeLessThanOrEqual(a.p95);
    expect(a.reliability).toBeGreaterThan(0);
    expect(a.reliability).toBeLessThanOrEqual(100);
    expect(a.probBelow).not.toBeNull();
    expect(a.returnsUsed).toBe(250);
    expect(a.simulatedSessions[0]).toBe('2026-10-08');
    for (const cand of a.candidates) {
      expect(cand.median).not.toBeNull();
      expect(Math.abs((cand.median as number) - cand.projected)).toBeLessThan(cand.projected * 0.02);
    }
  });

  it('déduit le dividende des séances projetées', () => {
    const sessions = flatSessions('2026-01-02', '2026-10-07', 120, cal);
    const r = estimate({
      sessions,
      asOf: '2026-10-07',
      lastPrice: 120,
      board: { mode: 'date', date: '2026-11-20' },
      dividends: [{ exDate: '2026-11-02', amount: 1.1 }],
      params: { nSims: 500 },
      seed: 1,
    });
    // fenêtre du 23/10 au 19/11 : 6 séances avant le détachement, 14 après
    const window = windowSessions(cal, '2026-11-20', DEFAULT_FORMULA);
    const values = window.map((d) => (d >= '2026-11-02' ? 118.9 : 120));
    expect(r.state).toBe('projection');
    expect(r.knownMax).toBe(0);
    expect(r.candidates[0].projected).toBe(subscriptionPrice(values, DEFAULT_FORMULA));
    // historique plat : rendements nuls, donc aucune dispersion
    expect(r.p05).toBe(r.p95);
    expect(r.central).toBe(r.candidates[0].projected);
    expect(r.reliability).toBe(100);
  });

  it('ne retire pas un dividende déjà détaché du dernier cours', () => {
    const sessions = flatSessions('2026-01-02', '2026-10-13', 120, cal);
    const r = whatIfPrice({
      sessions,
      asOf: '2026-10-13',
      lastPriceDate: '2026-10-13',
      boardDate: '2026-11-20',
      assumedPrice: 118.9,
      dividends: [{ exDate: '2026-10-13', amount: 1.1 }],
    });
    expect(r.price).toBe(subscriptionPrice(Array(20).fill(118.9), DEFAULT_FORMULA));
    expect(r.known).toBe(0);
    expect(r.remaining).toBe(20);
  });

  it('passe en loi normale si l’historique est trop court', () => {
    const sessions = flatSessions('2026-09-28', '2026-10-07', 120, cal).map((s, i) => ({ ...s, open: 120 + (i % 2) }));
    const r = estimate({
      sessions,
      asOf: '2026-10-07',
      lastPrice: 120,
      board: { mode: 'date', date: '2026-11-20' },
      params: { nSims: 2000 },
      seed: 3,
    });
    expect(r.returnsUsed).toBe(0);
    expect(r.sigmaDaily).toBe(0.013);
    expect(r.warnings.some((w) => w.includes('historique trop court'))).toBe(true);
    expect(r.p95 - r.p05).toBeGreaterThan(5);
    expect(r.reliability).toBeLessThan(40);
  });

  it('pondère les dates d’un créneau passé (état figé)', () => {
    const sessions = flatSessions('2026-05-01', '2026-10-07', 100, cal).map((s) =>
      s.date === '2026-09-15' ? { ...s, open: 400 } : s,
    );
    // CA le 16/09 : fenêtre qui finit le 15/09 (inclut 400) ; CA le 15/09 : fenêtre sans le pic
    const r = estimate({
      sessions,
      asOf: '2026-10-07',
      lastPrice: 100,
      board: { mode: 'slot', start: '2026-09-15', end: '2026-09-16', weights: { '2026-09-15': 0.6, '2026-09-16': 0.4 } },
      referencePrice: 100,
    });
    expect(r.state).toBe('frozen');
    expect(r.deterministic).toBe(false);
    expect(r.central).toBe(95);
    expect(r.p95).toBe(subscriptionPrice([...Array(19).fill(100), 400], DEFAULT_FORMULA));
    expect(r.reliability).toBe(60);
    expect(r.probBelow).toBe(0.6);
  });

  it('ajoute l’erreur de modèle même quand tout est connu', () => {
    const sessions = flatSessions('2026-05-01', '2026-10-07', 100, cal);
    const r = estimate({
      sessions,
      asOf: '2026-10-07',
      lastPrice: 100,
      board: { mode: 'date', date: '2026-09-15' },
      params: { modelSigmaBps: 50, nSims: 4000 },
      seed: 9,
    });
    expect(r.state).toBe('computed');
    expect(r.nSims).toBe(4000);
    expect(r.central).toBeCloseTo(95, 1);
    expect(r.p95).toBeGreaterThan(r.p05);
    expect(r.reliability).toBeGreaterThan(90);
  });

  it('complète une séance passée manquante et le signale', () => {
    const sessions = flatSessions('2026-05-01', '2026-10-07', 100, cal).filter((s) => s.date !== '2026-09-30');
    const r = estimate({
      sessions,
      asOf: '2026-10-07',
      lastPrice: 100,
      board: { mode: 'date', date: '2026-10-05' },
    });
    expect(r.central).toBe(95);
    expect(r.warnings[0]).toContain('2026-09-30');
  });

  it('simule la séance du jour si son ouverture manque encore', () => {
    const sessions = flatSessions('2026-05-01', '2026-10-06', 100, cal);
    const r = estimate({
      sessions,
      asOf: '2026-10-07',
      lastPrice: 100,
      lastPriceDate: '2026-10-06',
      board: { mode: 'date', date: '2026-10-08' },
      params: { nSims: 200 },
      seed: 5,
    });
    expect(r.simulatedSessions).toEqual(['2026-10-07']);
    expect(r.knownMostProbable).toBe(19);
  });

  it('exige un dernier cours pour projeter', () => {
    expect(() =>
      estimate({
        sessions: [],
        asOf: '2026-10-07',
        lastPrice: 0,
        board: { mode: 'date', date: '2026-11-20' },
      }),
    ).toThrow();
  });

  it('refuse une fenêtre passée sans aucun cours', () => {
    expect(() =>
      estimate({ sessions: [], asOf: '2026-10-07', lastPrice: 100, board: { mode: 'date', date: '2026-09-15' } }),
    ).toThrow(/aucun cours/);
  });
});

describe('simulateur « et si » (EF-06)', () => {
  it('combine cours connus et cours supposé', () => {
    const sessions = flatSessions('2026-05-01', '2026-10-07', 100, cal);
    const r = whatIfPrice({ sessions, asOf: '2026-10-07', boardDate: '2026-10-19', assumedPrice: 110 });
    expect(r.known).toBe(13);
    expect(r.remaining).toBe(7);
    expect(r.price).toBe(subscriptionPrice([...Array(13).fill(100), ...Array(7).fill(110)], DEFAULT_FORMULA));
    expect(r.windowStart).toBe('2026-09-21');
    expect(r.windowEnd).toBe('2026-10-16');
  });
});
