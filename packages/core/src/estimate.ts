import { TradingCalendar } from './calendar.ts';
import type { ISODate } from './dates.ts';
import { roundCents } from './fixed.ts';
import {
  DEFAULT_FORMULA,
  fieldValue,
  subscriptionPrice,
  windowSessions,
  type FormulaParams,
  type PriceField,
  type Session,
} from './formula.ts';
import { mulberry32, normal, randomSeed } from './random.ts';

export interface Dividend {
  /** Date de détachement : la première ouverture de cette date est hors dividende. */
  exDate: ISODate;
  amount: number;
}

export type BoardSpec =
  | { mode: 'date'; date: ISODate }
  | { mode: 'slot'; start: ISODate; end: ISODate; weights?: Record<string, number> | null };

export interface EstimateParams extends FormulaParams {
  /** Tolérance de l'IF en points de base (100 = ±1 %). */
  toleranceBps: number;
  /** Nombre de tirages Monte Carlo. */
  nSims: number;
  /** Profondeur de l'historique de rendements rééchantillonné. */
  bootstrapDays: number;
  /** Erreur de modèle (écart-type relatif, en points de base), issue du backtest. */
  modelSigmaBps: number;
}

export const DEFAULT_ESTIMATE: EstimateParams = {
  ...DEFAULT_FORMULA,
  toleranceBps: 100,
  nSims: 10_000,
  bootstrapDays: 250,
  modelSigmaBps: 0,
};

/** Volatilité quotidienne de repli quand l'historique est trop court (1,3 %). */
export const FALLBACK_DAILY_SIGMA = 0.013;
/** Nombre minimal de rendements pour rééchantillonner l'historique. */
export const MIN_RETURNS = 20;
/** Un rendement quotidien au-delà de ±25 % est traité comme une donnée aberrante. */
const MAX_ABS_RETURN = 0.25;

export type EstimateState = 'projection' | 'window' | 'frozen' | 'computed';

export interface Candidate {
  date: ISODate;
  weight: number;
}

/** Dates de CA possibles et leur probabilité (somme = 1). */
export function candidateDates(calendar: TradingCalendar, board: BoardSpec): Candidate[] {
  if (board.mode === 'date') return [{ date: board.date, weight: 1 }];
  if (board.end < board.start) throw new Error(`créneau invalide : ${board.start} → ${board.end}`);
  let days = calendar.sessionsBetween(board.start, board.end);
  if (days.length === 0) days = [board.start];
  const weights = board.weights && Object.keys(board.weights).length > 0 ? board.weights : null;
  let list = days.map((date) => ({
    date,
    weight: weights ? Math.max(0, Number(weights[date] ?? 0)) || 0 : 1,
  }));
  let total = list.reduce((s, c) => s + c.weight, 0);
  if (!(total > 0)) {
    list = days.map((date) => ({ date, weight: 1 }));
    total = list.length;
  }
  return list.filter((c) => c.weight > 0).map((c) => ({ date: c.date, weight: c.weight / total }));
}

/** Date la plus probable : poids maximal ; à poids égaux, la date centrale du créneau. */
export function mostProbable(candidates: Candidate[]): Candidate {
  if (candidates.length === 0) throw new Error('aucune date candidate');
  const max = Math.max(...candidates.map((c) => c.weight));
  const top = candidates.filter((c) => Math.abs(c.weight - max) < 1e-12);
  return top[Math.floor((top.length - 1) / 2)];
}

export interface ReturnsSample {
  returns: number[];
  /** Rendements écartés car aberrants. */
  outliers: number;
}

/**
 * Rendements logarithmiques séance à séance du type de cours, sur les
 * `maxDays` dernières séances connues à `asOf`, corrigés des dividendes
 * (le montant détaché est rajouté au cours) puis recentrés sur zéro.
 */
export function dailyReturns(
  sessions: Session[],
  field: PriceField,
  asOf: ISODate,
  maxDays: number,
  dividends: Dividend[] = [],
): ReturnsSample {
  const points: { date: ISODate; v: number }[] = [];
  for (const s of sessions) {
    if (s.date > asOf) continue;
    const v = fieldValue(s, field);
    if (v !== null) points.push({ date: s.date, v });
  }
  points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const slice = points.slice(-(Math.max(1, maxDays) + 1));
  const raw: number[] = [];
  let outliers = 0;
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1];
    const cur = slice[i];
    let div = 0;
    for (const d of dividends) if (d.exDate > prev.date && d.exDate <= cur.date) div += d.amount;
    const r = Math.log((cur.v + div) / prev.v);
    if (!Number.isFinite(r) || Math.abs(r) > MAX_ABS_RETURN) {
      outliers++;
      continue;
    }
    raw.push(r);
  }
  if (raw.length === 0) return { returns: [], outliers };
  const mean = raw.reduce((s, r) => s + r, 0) / raw.length;
  return { returns: raw.map((r) => r - mean), outliers };
}

export function standardDeviation(values: ArrayLike<number>): number {
  const n = values.length;
  if (n < 2) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += values[i];
  mean /= n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (values[i] - mean) ** 2;
  return Math.sqrt(ss / (n - 1));
}

/** Quantile (interpolation linéaire, type 7) d'un tableau trié. */
export function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** Quantile d'une loi discrète pondérée (inverse de la fonction de répartition). */
export function weightedQuantile(values: number[], weights: number[], p: number): number {
  const order = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v);
  const total = order.reduce((s, o) => s + o.w, 0);
  let acc = 0;
  for (const o of order) {
    acc += o.w;
    if (acc >= p * total - 1e-12) return o.v;
  }
  return order[order.length - 1].v;
}

export function reliabilityLabel(reliability: number): string {
  if (reliability >= 95) return 'Quasi certain';
  if (reliability >= 80) return 'Fiable';
  if (reliability >= 50) return 'Indicatif';
  return 'Spéculatif';
}

interface PreparedWindow {
  dates: ISODate[];
  /** Valeurs connues (null = séance à simuler). */
  values: (number | null)[];
  known: number;
}

interface Prepared {
  calendar: TradingCalendar;
  params: EstimateParams;
  candidates: Candidate[];
  windows: PreparedWindow[];
  /** Séances simulées, de la première séance inconnue à la fin de la dernière fenêtre. */
  path: ISODate[];
  pathIndex: Map<ISODate, number>;
  /** Dividendes retirés à chaque pas de la trajectoire. */
  dividendAt: number[];
  lastPrice: number;
  lastPriceDate: ISODate;
  warnings: string[];
}

export interface ProjectionInput {
  sessions: Session[];
  /** Dernière date d'information : les cours postérieurs sont ignorés. */
  asOf: ISODate;
  /** Dernier cours connu (cours en séance, sinon dernière clôture). */
  lastPrice: number;
  /** Séance à laquelle appartient `lastPrice` (par défaut `asOf`). */
  lastPriceDate?: ISODate;
  dividends?: Dividend[];
  extraClosures?: ISODate[];
  calendar?: TradingCalendar;
}

export interface EstimateInput extends ProjectionInput {
  board: BoardSpec;
  params?: Partial<EstimateParams>;
  /** Prix du quadrimestre en cours, pour la probabilité « N+1 < N ». */
  referencePrice?: number | null;
  seed?: number;
}

function prepare(input: EstimateInput): Prepared {
  const params: EstimateParams = { ...DEFAULT_ESTIMATE, ...(input.params ?? {}) };
  const calendar = input.calendar ?? new TradingCalendar(input.extraClosures ?? []);
  const warnings: string[] = [];
  const byDate = new Map<ISODate, Session>();
  for (const s of input.sessions) if (s.date <= input.asOf) byDate.set(s.date, s);
  const asOfValue = fieldValue(byDate.get(input.asOf), params.priceField);
  const pathStart =
    calendar.isTradingDay(input.asOf) && asOfValue === null ? input.asOf : calendar.nextSession(input.asOf);

  const candidates = candidateDates(calendar, input.board);
  const fills = new Set<ISODate>();
  const windows: PreparedWindow[] = candidates.map((c) => {
    const dates = windowSessions(calendar, c.date, params);
    let lastKnown: number | null = null;
    const values = dates.map((d) => {
      if (d >= pathStart) return null;
      const v = fieldValue(byDate.get(d), params.priceField);
      if (v !== null) {
        lastKnown = v;
        return v;
      }
      fills.add(d);
      return lastKnown ?? previousValue(byDate, calendar, d, params.priceField);
    });
    // Séance passée sans donnée et sans cours antérieur : on prend le suivant connu.
    for (let i = values.length - 1; i >= 0; i--) {
      if (dates[i] < pathStart && (values[i] === null || Number.isNaN(values[i] as number))) {
        values[i] = nextKnownValue(values, i);
      }
    }
    const known = dates.filter((d) => d < pathStart).length;
    return { dates, values, known };
  });
  if (fills.size > 0) {
    warnings.push(`séances passées sans cours, complétées par le cours précédent : ${[...fills].sort().join(', ')}`);
  }
  for (const w of windows) {
    for (let i = 0; i < w.dates.length; i++) {
      if (w.dates[i] < pathStart && w.values[i] === null) {
        throw new Error(`aucun cours disponible pour la séance du ${w.dates[i]}`);
      }
    }
  }

  const maxEnd = windows.reduce((m, w) => (w.dates[w.dates.length - 1] > m ? w.dates[w.dates.length - 1] : m), '');
  const path = pathStart <= maxEnd ? calendar.sessionsBetween(pathStart, maxEnd) : [];
  const pathIndex = new Map(path.map((d, i) => [d, i]));
  const lastPriceDate = input.lastPriceDate ?? input.asOf;
  const dividends = input.dividends ?? [];
  const dividendAt = path.map((d, i) => {
    const prev = i === 0 ? lastPriceDate : path[i - 1];
    let amount = 0;
    for (const div of dividends) {
      if (div.exDate > prev && div.exDate <= d && div.exDate > lastPriceDate) amount += div.amount;
    }
    return amount;
  });
  if (path.length > 0 && !(input.lastPrice > 0)) throw new Error('dernier cours manquant pour la projection');
  return {
    calendar,
    params,
    candidates,
    windows,
    path,
    pathIndex,
    dividendAt,
    lastPrice: input.lastPrice,
    lastPriceDate,
    warnings,
  };
}

function previousValue(
  byDate: Map<ISODate, Session>,
  calendar: TradingCalendar,
  date: ISODate,
  field: PriceField,
): number | null {
  let d = date;
  for (let i = 0; i < 30; i++) {
    d = calendar.previousSession(d);
    const v = fieldValue(byDate.get(d), field);
    if (v !== null) return v;
  }
  return null;
}

function nextKnownValue(values: (number | null)[], index: number): number | null {
  for (let i = index + 1; i < values.length; i++) if (values[i] !== null) return values[i];
  return null;
}

/** Prix exact pour une fenêtre dont les séances inconnues valent `future(date)`. */
function windowPrice(
  prep: Prepared,
  w: PreparedWindow,
  future: (index: number) => number,
): number {
  const values = w.dates.map((d, i) => {
    const v = w.values[i];
    if (v !== null) return v;
    return future(prep.pathIndex.get(d) as number);
  });
  return subscriptionPrice(values, prep.params);
}

/** Cours projeté sans aléa : dernier cours diminué des dividendes détachés entre-temps. */
function centralPath(prep: Prepared, assumed: number): number[] {
  let s = assumed;
  return prep.path.map((_, i) => {
    s = Math.max(0.01, s - prep.dividendAt[i]);
    return Math.round(s * 10_000) / 10_000;
  });
}

export interface CandidateDetail {
  date: ISODate;
  weight: number;
  windowStart: ISODate;
  windowEnd: ISODate;
  /** Séances de la fenêtre déjà passées (cours connus). */
  known: number;
  /** Prix exact si toute la fenêtre est connue. */
  exact: number | null;
  /** Projection centrale : séances restantes au dernier cours, dividendes déduits. */
  projected: number;
  /** Médiane simulée pour cette date. */
  median: number | null;
}

export interface EstimateResult {
  asOf: ISODate;
  lastPrice: number;
  lastPriceDate: ISODate;
  seed: number;
  /** Tirages effectués (0 si le résultat est exact). */
  nSims: number;
  state: EstimateState;
  /** Résultat sans aucune incertitude (date connue, fenêtre complète). */
  deterministic: boolean;
  central: number;
  p05: number;
  p25: number;
  p75: number;
  p95: number;
  /** Indice de fiabilité, de 0 à 100. */
  reliability: number;
  /** Probabilité que le prix soit inférieur au prix de référence (prix N). */
  probBelow: number | null;
  referencePrice: number | null;
  mostProbableDate: ISODate;
  knownMostProbable: number;
  knownMin: number;
  knownMax: number;
  windowDays: number;
  windowUnion: { start: ISODate; end: ISODate };
  /** Séances à venir à simuler. */
  simulatedSessions: ISODate[];
  candidates: CandidateDetail[];
  returnsUsed: number;
  /** Volatilité quotidienne utilisée (écart-type des rendements). */
  sigmaDaily: number;
  params: EstimateParams;
  warnings: string[];
}

/**
 * Estimation du prix de souscription : simulation Monte Carlo des cours
 * manquants (bootstrap des rendements recentrés), dividendes déduits,
 * date du CA tirée dans le créneau, formule officielle appliquée à chaque
 * tirage. Exact et sans tirage quand plus rien n'est inconnu.
 */
export function estimate(input: EstimateInput): EstimateResult {
  const prep = prepare(input);
  const { params, candidates, windows, path } = prep;
  const seed = (input.seed ?? randomSeed()) >>> 0;
  const reference = input.referencePrice ?? null;
  const tolerance = params.toleranceBps / 10_000;
  const warnings = [...prep.warnings];

  const knownCounts = windows.map((w) => w.known);
  const probableIdx = candidates.indexOf(mostProbable(candidates));
  const unionStart = windows.reduce((m, w) => (w.dates[0] < m ? w.dates[0] : m), windows[0].dates[0]);
  const unionEnd = windows.reduce(
    (m, w) => (w.dates[w.dates.length - 1] > m ? w.dates[w.dates.length - 1] : m),
    windows[0].dates[windows[0].dates.length - 1],
  );

  const central0 = centralPath(prep, prep.lastPrice > 0 ? prep.lastPrice : 1);
  const exacts = windows.map((w) => (w.values.every((v) => v !== null) ? subscriptionPrice(w.values as number[], params) : null));
  const details: CandidateDetail[] = candidates.map((c, i) => ({
    date: c.date,
    weight: c.weight,
    windowStart: windows[i].dates[0],
    windowEnd: windows[i].dates[windows[i].dates.length - 1],
    known: windows[i].known,
    exact: exacts[i],
    projected: exacts[i] ?? windowPrice(prep, windows[i], (k) => central0[k]),
    median: exacts[i],
  }));

  const base = {
    asOf: input.asOf,
    lastPrice: prep.lastPrice,
    lastPriceDate: prep.lastPriceDate,
    seed,
    referencePrice: reference,
    mostProbableDate: candidates[probableIdx].date,
    knownMostProbable: knownCounts[probableIdx],
    knownMin: Math.min(...knownCounts),
    knownMax: Math.max(...knownCounts),
    windowDays: params.windowDays,
    windowUnion: { start: unionStart, end: unionEnd },
    simulatedSessions: path,
    candidates: details,
    params,
  };

  const allKnown = exacts.every((p) => p !== null);
  if (allKnown && params.modelSigmaBps <= 0) {
    const values = exacts as number[];
    const weights = candidates.map((c) => c.weight);
    const central = weightedQuantile(values, weights, 0.5);
    let within = 0;
    let below = 0;
    values.forEach((v, i) => {
      if (Math.abs(v - central) <= tolerance * central + 1e-9) within += weights[i];
      if (reference !== null && v < reference - 1e-9) below += weights[i];
    });
    return {
      ...base,
      nSims: 0,
      state: candidates.length === 1 ? 'computed' : 'frozen',
      deterministic: candidates.length === 1,
      central,
      p05: weightedQuantile(values, weights, 0.05),
      p25: weightedQuantile(values, weights, 0.25),
      p75: weightedQuantile(values, weights, 0.75),
      p95: weightedQuantile(values, weights, 0.95),
      reliability: round1(within * 100),
      probBelow: reference === null ? null : round4(below),
      returnsUsed: 0,
      sigmaDaily: 0,
      warnings,
    };
  }

  const sample = path.length > 0
    ? dailyReturns(input.sessions, params.priceField, input.asOf, params.bootstrapDays, input.dividends ?? [])
    : { returns: [], outliers: 0 };
  if (sample.outliers > 0) warnings.push(`${sample.outliers} rendement(s) aberrant(s) écarté(s) de l'historique`);
  const useBootstrap = sample.returns.length >= MIN_RETURNS;
  if (path.length > 0 && !useBootstrap) {
    warnings.push(`historique trop court (${sample.returns.length} rendements) : loi normale à σ = 1,3 % par jour`);
  }
  const returns = sample.returns;
  const sigmaDaily = useBootstrap ? standardDeviation(returns) : path.length > 0 ? FALLBACK_DAILY_SIGMA : 0;

  const nSims = Math.max(100, Math.floor(params.nSims));
  const rand = mulberry32(seed);
  const cumulative: number[] = [];
  let acc = 0;
  for (const c of candidates) {
    acc += c.weight;
    cumulative.push(acc);
  }
  const windowNeeds = windows.map((w) => {
    const firstUnknown = w.values.findIndex((v) => v === null);
    if (firstUnknown < 0) return { from: -1, to: -1, knownSum: 0 };
    let knownSum = 0;
    for (let i = 0; i < firstUnknown; i++) knownSum += w.values[i] as number;
    return {
      from: prep.pathIndex.get(w.dates[firstUnknown]) as number,
      to: prep.pathIndex.get(w.dates[w.dates.length - 1]) as number,
      knownSum,
    };
  });
  const factor = (10_000 - params.discountBps) / 10_000;
  const modelSigma = params.modelSigmaBps / 10_000;
  const simPath = new Float64Array(path.length);
  const results = new Float64Array(nSims);
  const perCandidate: number[][] = candidates.map(() => []);

  for (let s = 0; s < nSims; s++) {
    const u = rand();
    let ci = cumulative.findIndex((c) => u < c);
    if (ci < 0) ci = candidates.length - 1;
    const need = windowNeeds[ci];
    let price: number;
    if (need.from < 0) {
      price = exacts[ci] as number;
    } else {
      let spot = prep.lastPrice;
      for (let i = 0; i <= need.to; i++) {
        const r = useBootstrap ? returns[Math.floor(rand() * returns.length)] : FALLBACK_DAILY_SIGMA * normal(rand);
        spot = spot * Math.exp(r) - prep.dividendAt[i];
        if (spot < 0.01) spot = 0.01;
        simPath[i] = spot;
      }
      let sum = need.knownSum;
      for (let i = need.from; i <= need.to; i++) sum += simPath[i];
      price = roundCents((factor * sum) / params.windowDays, params.rounding);
    }
    if (modelSigma > 0) price = roundCents(price * (1 + modelSigma * normal(rand)), params.rounding);
    results[s] = price;
    perCandidate[ci].push(price);
  }

  const sorted = results.slice().sort();
  const central = roundCents(quantileSorted(sorted, 0.5));
  let within = 0;
  let below = 0;
  for (let i = 0; i < nSims; i++) {
    const v = results[i];
    if (Math.abs(v - central) <= tolerance * central + 1e-9) within++;
    if (reference !== null && v < reference - 1e-9) below++;
  }
  perCandidate.forEach((list, i) => {
    if (list.length > 0) {
      const arr = Float64Array.from(list).sort();
      details[i].median = roundCents(quantileSorted(arr, 0.5));
    }
  });

  const state: EstimateState = allKnown
    ? candidates.length === 1
      ? 'computed'
      : 'frozen'
    : base.knownMax === 0
      ? 'projection'
      : 'window';
  return {
    ...base,
    nSims,
    state,
    deterministic: false,
    central,
    p05: roundCents(quantileSorted(sorted, 0.05)),
    p25: roundCents(quantileSorted(sorted, 0.25)),
    p75: roundCents(quantileSorted(sorted, 0.75)),
    p95: roundCents(quantileSorted(sorted, 0.95)),
    reliability: round1((within / nSims) * 100),
    probBelow: reference === null ? null : round4(below / nSims),
    returnsUsed: useBootstrap ? returns.length : 0,
    sigmaDaily: round6(sigmaDaily),
    warnings,
  };
}

export interface WhatIfInput extends Omit<ProjectionInput, 'lastPrice'> {
  boardDate: ISODate;
  /** Cours supposé pour toutes les séances restantes (avant détachement des dividendes). */
  assumedPrice: number;
  params?: Partial<FormulaParams>;
}

export interface WhatIfResult {
  price: number;
  known: number;
  remaining: number;
  windowStart: ISODate;
  windowEnd: ISODate;
}

/** Simulateur « et si » : prix obtenu si les séances restantes cotent `assumedPrice`. */
export function whatIfPrice(input: WhatIfInput): WhatIfResult {
  const prep = prepare({
    ...input,
    lastPrice: input.assumedPrice,
    board: { mode: 'date', date: input.boardDate },
    params: { ...DEFAULT_ESTIMATE, ...(input.params ?? {}) },
  });
  const w = prep.windows[0];
  const projected = centralPath(prep, input.assumedPrice);
  return {
    price: windowPrice(prep, w, (k) => projected[k]),
    known: w.known,
    remaining: w.dates.length - w.known,
    windowStart: w.dates[0],
    windowEnd: w.dates[w.dates.length - 1],
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}
function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}
