import { describe, expect, it } from 'vitest';
import {
  allVariants,
  evaluateWindow,
  indexSessions,
  inferBoardDates,
  replayEstimates,
  runBacktest,
  TradingCalendar,
  variantKey,
  variantLabel,
  DEFAULT_FORMULA,
  type Reference,
} from '../src/index.ts';
import { syntheticSessions } from './helpers.ts';

const cal = new TradingCalendar();
const sessions = syntheticSessions('2020-06-01', '2026-10-07', 11, 70, cal);
const byDate = indexSessions(sessions);
const boards: [string, string][] = [
  ['2022/1', '2021-10-20'],
  ['2023/1', '2022-10-19'],
  ['2024/1', '2023-10-19'],
  ['2024/3', '2024-06-13'],
  ['2026/1', '2025-10-15'],
  ['2026/2', '2026-02-05'],
  ['2026/3', '2026-06-23'],
];
// « Prix officiels » fabriqués avec la règle des avis : ouvertures, arrondi au plus proche, jour du CA exclu.
const references: Reference[] = boards.map(([code, boardDate]) => ({
  code,
  boardDate,
  officialPrice: evaluateWindow(byDate, cal, boardDate, DEFAULT_FORMULA).price as number,
}));

describe('backtest de la formule (RG-12)', () => {
  it('teste 18 variantes', () => {
    const variants = allVariants();
    expect(variants).toHaveLength(18);
    expect(new Set(variants.map(variantKey)).size).toBe(18);
    expect(variantLabel(variants[0])).toBe('ouverture, centime au plus proche, jour du CA exclu');
  });

  it('retrouve la variante exacte au centime', () => {
    const report = runBacktest({ sessions, references });
    expect(report.references).toBe(7);
    expect(report.exact?.key).toBe('open/nearest/exclu');
    expect(report.best?.key).toBe('open/nearest/exclu');
    expect(report.exact?.mae).toBe(0);
    expect(report.exact?.sigmaBps).toBe(0);
    const close = report.variants.find((v) => v.key === 'close/nearest/exclu');
    expect(close?.exactRate).toBeLessThan(1);
    expect(close?.mae).toBeGreaterThan(0);
  });

  it('signale les fenêtres incomplètes', () => {
    const holes = sessions.filter((s) => s.date !== '2025-10-01');
    const report = runBacktest({ sessions: holes, references, variants: [allVariants()[0]] });
    const v = report.variants[0];
    expect(v.nMissing).toBe(1);
    expect(v.n).toBe(6);
    expect(v.rows.find((r) => r.code === '2026/1')?.computed).toBeNull();
    expect(report.exact).toBeNull();
    expect(report.best?.exactRate).toBe(1);
  });

  it('ignore les références sans date de CA', () => {
    const report = runBacktest({
      sessions,
      references: [{ code: '2019/1', boardDate: null, officialPrice: 80 }],
      variants: [allVariants()[0]],
    });
    expect(report.references).toBe(0);
    expect(report.best).toBeNull();
  });
});

describe('inférence des dates de CA (RG-13)', () => {
  it('retrouve la date à partir du prix officiel', () => {
    const ref = references.find((r) => r.code === '2026/1') as Reference;
    const res = inferBoardDates({
      sessions,
      reference: { code: ref.code, boardDate: null, officialPrice: ref.officialPrice, presumedDate: '2025-10-20' },
    });
    expect(res.matches.map((m) => m.date)).toContain('2025-10-15');
    expect(res.closest[0].diff).toBe(0);
    expect(res.scanned).toBe(121);
    expect(res.incomplete).toBe(0);
  });

  it('exige une date présumée', () => {
    expect(() =>
      inferBoardDates({ sessions, reference: { code: 'x', boardDate: null, officialPrice: 1 } }),
    ).toThrow();
  });

  it('cherche aussi autour d’un jour non coté', () => {
    const res = inferBoardDates({
      sessions,
      reference: { code: '2026/1', boardDate: null, officialPrice: 1, presumedDate: '2025-10-18' },
      rangeSessions: 5,
    });
    expect(res.scanned).toBe(10);
    expect(res.matches).toEqual([]);
  });
});

describe('rejeu des estimations (RG-14)', () => {
  it('mesure la couverture de l’intervalle à 90 %', () => {
    const report = replayEstimates({
      sessions,
      references: [...references.slice(-3), { code: '2019/3', boardDate: null, officialPrice: 80 }],
      daysBefore: 30,
      step: 3,
      nSims: 400,
      seed: 1,
    });
    expect(report.skipped).toEqual(['2019/3 : date du CA inconnue']);
    expect(report.n).toBe(30);
    expect(report.coverage).not.toBeNull();
    expect(report.coverage as number).toBeGreaterThan(0.5);
    const complete = report.buckets.find((b) => b.minKnown === 20);
    expect(complete?.n).toBe(3);
    expect(complete?.coverage).toBe(1);
    expect(complete?.hitRate).toBe(1);
    const lastPoint = report.points.find((p) => p.code === '2026/3' && p.sessionsToBoard === 1);
    expect(lastPoint?.known).toBe(20);
    expect(lastPoint?.reliability).toBe(100);
    expect(report.buckets.find((b) => b.minKnown === 0)?.n).toBeGreaterThan(0);
  });
});
