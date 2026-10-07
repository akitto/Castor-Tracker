import { TradingCalendar } from './calendar.ts';
import type { ISODate } from './dates.ts';
import { DEFAULT_ESTIMATE, estimate, type Dividend, type EstimateParams } from './estimate.ts';
import type { Rounding } from './fixed.ts';
import {
  DEFAULT_FORMULA,
  evaluateWindow,
  fieldValue,
  indexSessions,
  type FormulaParams,
  type PriceField,
  type Session,
} from './formula.ts';

/** Prix officiel d'un quadrimestre passé, avec la date du CA si elle est connue. */
export interface Reference {
  code: string;
  boardDate: ISODate | null;
  officialPrice: number;
  /** Date présumée du CA, centre de la recherche quand la date manque. */
  presumedDate?: ISODate | null;
}

export interface Variant {
  priceField: PriceField;
  rounding: Rounding;
  excludeBoardDay: boolean;
}

const FIELD_LABEL: Record<PriceField, string> = { open: 'ouverture', close: 'clôture', vwap: 'VWAP' };
const ROUNDING_LABEL: Record<Rounding, string> = { nearest: 'au plus proche', up: 'supérieur', down: 'inférieur' };

export function variantKey(v: Variant): string {
  return `${v.priceField}/${v.rounding}/${v.excludeBoardDay ? 'exclu' : 'inclus'}`;
}

export function variantLabel(v: Variant): string {
  return `${FIELD_LABEL[v.priceField]}, centime ${ROUNDING_LABEL[v.rounding]}, jour du CA ${v.excludeBoardDay ? 'exclu' : 'inclus'}`;
}

/** Les 18 variantes testées : type de cours × arrondi × jour du CA. */
export function allVariants(): Variant[] {
  const out: Variant[] = [];
  for (const priceField of ['open', 'close', 'vwap'] as PriceField[]) {
    for (const rounding of ['nearest', 'up', 'down'] as Rounding[]) {
      for (const excludeBoardDay of [true, false]) out.push({ priceField, rounding, excludeBoardDay });
    }
  }
  return out;
}

const toCents = (v: number) => Math.round(v * 100);

export interface BacktestRow {
  code: string;
  boardDate: ISODate;
  official: number;
  computed: number | null;
  /** Écart calculé − officiel, en euros. */
  diff: number | null;
  diffPct: number | null;
  exact: boolean;
  /** Séances de la fenêtre sans cours pour cette variante. */
  missing: number;
}

export interface VariantResult {
  variant: Variant;
  key: string;
  label: string;
  rows: BacktestRow[];
  /** Quadrimestres recalculés (fenêtre complète). */
  n: number;
  nExact: number;
  nMissing: number;
  exactRate: number;
  /** Écart absolu moyen en euros. */
  mae: number | null;
  maxAbs: number | null;
  /** Écart-type des résidus relatifs, en points de base : l'erreur de modèle. */
  sigmaBps: number | null;
}

export interface BacktestReport {
  references: number;
  variants: VariantResult[];
  /** Meilleure variante (taux exact, puis écart moyen). */
  best: VariantResult | null;
  /** Variante qui retrouve 100 % des prix, s'il y en a une. */
  exact: VariantResult | null;
}

export interface BacktestInput {
  sessions: Session[];
  references: Reference[];
  variants?: Variant[];
  base?: FormulaParams;
  calendar?: TradingCalendar;
  extraClosures?: ISODate[];
}

/** Backtest de la formule (RG-12) : chaque variante recalcule chaque prix de référence. */
export function runBacktest(input: BacktestInput): BacktestReport {
  const calendar = input.calendar ?? new TradingCalendar(input.extraClosures ?? []);
  const sessions = indexSessions(input.sessions);
  const refs = input.references.filter((r) => r.boardDate && r.officialPrice > 0);
  const base = input.base ?? DEFAULT_FORMULA;
  const results = (input.variants ?? allVariants()).map((variant): VariantResult => {
    const params: FormulaParams = { ...base, ...variant };
    const rows = refs.map((ref): BacktestRow => {
      const ev = evaluateWindow(sessions, calendar, ref.boardDate as ISODate, params);
      const computed = ev.price;
      const diff = computed === null ? null : (toCents(computed) - toCents(ref.officialPrice)) / 100;
      return {
        code: ref.code,
        boardDate: ref.boardDate as ISODate,
        official: ref.officialPrice,
        computed,
        diff,
        diffPct: diff === null ? null : diff / ref.officialPrice,
        exact: diff === 0,
        missing: ev.missing.length,
      };
    });
    const done = rows.filter((r) => r.computed !== null);
    const n = done.length;
    const nExact = done.filter((r) => r.exact).length;
    const abs = done.map((r) => Math.abs(r.diff as number));
    const rel = done.map((r) => (r.computed as number) / r.official - 1);
    return {
      variant,
      key: variantKey(variant),
      label: variantLabel(variant),
      rows,
      n,
      nExact,
      nMissing: rows.length - n,
      exactRate: n > 0 ? nExact / n : 0,
      mae: n > 0 ? round4(abs.reduce((s, v) => s + v, 0) / n) : null,
      maxAbs: n > 0 ? round4(Math.max(...abs)) : null,
      sigmaBps: n > 0 ? round2(Math.sqrt(rel.reduce((s, v) => s + v * v, 0) / n) * 10_000) : null,
    };
  });
  results.sort(
    (a, b) =>
      b.exactRate - a.exactRate || b.n - a.n || (a.mae ?? Number.POSITIVE_INFINITY) - (b.mae ?? Number.POSITIVE_INFINITY),
  );
  const best = results.find((r) => r.n > 0) ?? null;
  const exact = results.find((r) => r.n > 0 && r.n === refs.length && r.exactRate === 1) ?? null;
  return { references: refs.length, variants: results, best, exact };
}

export interface InferenceResult {
  code: string;
  officialPrice: number;
  presumedDate: ISODate;
  /** Dates de CA pour lesquelles la formule retrouve le prix au centime. */
  matches: { date: ISODate; price: number }[];
  /** Dates les plus proches du prix officiel (contrôle visuel). */
  closest: { date: ISODate; price: number; diff: number }[];
  scanned: number;
  incomplete: number;
}

/** Inférence de la date du CA (RG-13) : recherche à ±`rangeSessions` séances de la date présumée. */
export function inferBoardDates(input: {
  sessions: Session[];
  reference: Reference;
  params?: FormulaParams;
  calendar?: TradingCalendar;
  extraClosures?: ISODate[];
  rangeSessions?: number;
}): InferenceResult {
  const calendar = input.calendar ?? new TradingCalendar(input.extraClosures ?? []);
  const params = input.params ?? DEFAULT_FORMULA;
  const presumed = input.reference.presumedDate ?? input.reference.boardDate;
  if (!presumed) throw new Error(`date présumée manquante pour ${input.reference.code}`);
  const range = input.rangeSessions ?? 60;
  const before = calendar.sessionsBefore(presumed, range);
  const after: ISODate[] = [];
  let d = presumed;
  if (calendar.isTradingDay(presumed)) after.push(presumed);
  while (after.length < range + (calendar.isTradingDay(presumed) ? 1 : 0)) {
    d = calendar.nextSession(d);
    after.push(d);
  }
  const sessions = indexSessions(input.sessions);
  const target = toCents(input.reference.officialPrice);
  const matches: { date: ISODate; price: number }[] = [];
  const scored: { date: ISODate; price: number; diff: number }[] = [];
  let incomplete = 0;
  for (const date of [...before, ...after]) {
    const ev = evaluateWindow(sessions, calendar, date, params);
    if (ev.price === null) {
      incomplete++;
      continue;
    }
    const diff = (toCents(ev.price) - target) / 100;
    if (diff === 0) matches.push({ date, price: ev.price });
    scored.push({ date, price: ev.price, diff });
  }
  scored.sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff) || (a.date < b.date ? -1 : 1));
  return {
    code: input.reference.code,
    officialPrice: input.reference.officialPrice,
    presumedDate: presumed,
    matches,
    closest: scored.slice(0, 5),
    scanned: before.length + after.length,
    incomplete,
  };
}

export interface ReplayPoint {
  code: string;
  asOf: ISODate;
  /** Rang de la séance avant le CA (1 = veille du CA). */
  sessionsToBoard: number;
  known: number;
  central: number;
  p05: number;
  p95: number;
  reliability: number;
  official: number;
  covered: boolean;
  /** Prix officiel à moins de la tolérance de l'IF de l'estimation centrale. */
  withinTolerance: boolean;
  error: number;
}

export interface ReplayBucket {
  label: string;
  minKnown: number;
  maxKnown: number;
  n: number;
  coverage: number | null;
  hitRate: number | null;
  meanReliability: number | null;
}

export interface ReplayReport {
  points: ReplayPoint[];
  buckets: ReplayBucket[];
  /** Couverture de l'intervalle à 90 % sur les points incertains (fenêtre incomplète). */
  coverage: number | null;
  n: number;
  skipped: string[];
}

/** Rejeu des estimations (RG-14) : l'estimation affichée chaque jour de J−`daysBefore` à J−1. */
export function replayEstimates(input: {
  sessions: Session[];
  references: Reference[];
  params?: Partial<EstimateParams>;
  dividends?: Dividend[];
  calendar?: TradingCalendar;
  extraClosures?: ISODate[];
  daysBefore?: number;
  step?: number;
  nSims?: number;
  seed?: number;
}): ReplayReport {
  const calendar = input.calendar ?? new TradingCalendar(input.extraClosures ?? []);
  const params: EstimateParams = { ...DEFAULT_ESTIMATE, ...(input.params ?? {}), nSims: input.nSims ?? 1_000 };
  const daysBefore = input.daysBefore ?? 60;
  const step = Math.max(1, input.step ?? 1);
  const byDate = indexSessions(input.sessions);
  const tolerance = params.toleranceBps / 10_000;
  const points: ReplayPoint[] = [];
  const skipped: string[] = [];
  let seed = (input.seed ?? 20_261_007) >>> 0;
  for (const ref of input.references) {
    if (!ref.boardDate || !(ref.officialPrice > 0)) {
      skipped.push(`${ref.code} : date du CA inconnue`);
      continue;
    }
    const days = calendar.sessionsBefore(ref.boardDate, daysBefore);
    for (let i = 0; i < days.length; i++) {
      const rank = days.length - i;
      if ((rank - 1) % step !== 0) continue;
      const asOf = days[i];
      const s = byDate.get(asOf);
      const last = fieldValue(s, 'close') ?? fieldValue(s, params.priceField);
      if (last === null) continue;
      try {
        const r = estimate({
          sessions: input.sessions,
          asOf,
          lastPrice: last,
          board: { mode: 'date', date: ref.boardDate },
          params,
          dividends: input.dividends,
          calendar,
          seed: seed++,
        });
        const error = r.central - ref.officialPrice;
        points.push({
          code: ref.code,
          asOf,
          sessionsToBoard: rank,
          known: r.knownMostProbable,
          central: r.central,
          p05: r.p05,
          p95: r.p95,
          reliability: r.reliability,
          official: ref.officialPrice,
          covered: ref.officialPrice >= r.p05 - 1e-9 && ref.officialPrice <= r.p95 + 1e-9,
          withinTolerance: Math.abs(error) <= tolerance * r.central + 1e-9,
          error: round4(error),
        });
      } catch (e) {
        skipped.push(`${ref.code} au ${asOf} : ${(e as Error).message}`);
      }
    }
  }
  const w = params.windowDays;
  const bucketDefs: [string, number, number][] = [
    ['Fenêtre pas commencée', 0, 0],
    ['1 à 5 séances connues', 1, 5],
    ['6 à 10 séances connues', 6, 10],
    ['11 à 15 séances connues', 11, 15],
    [`16 à ${w - 1} séances connues`, 16, w - 1],
    ['Fenêtre complète', w, w],
  ];
  const buckets = bucketDefs.map(([label, minKnown, maxKnown]): ReplayBucket => {
    const pts = points.filter((p) => p.known >= minKnown && p.known <= maxKnown);
    const n = pts.length;
    return {
      label,
      minKnown,
      maxKnown,
      n,
      coverage: n ? round4(pts.filter((p) => p.covered).length / n) : null,
      hitRate: n ? round4(pts.filter((p) => p.withinTolerance).length / n) : null,
      meanReliability: n ? round2(pts.reduce((s, p) => s + p.reliability, 0) / n) : null,
    };
  });
  const uncertain = points.filter((p) => p.known < w);
  return {
    points,
    buckets,
    coverage: uncertain.length ? round4(uncertain.filter((p) => p.covered).length / uncertain.length) : null,
    n: points.length,
    skipped,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}
