import type { TradingCalendar } from './calendar.ts';
import type { ISODate } from './dates.ts';
import { divRound, toUnits, type Rounding } from './fixed.ts';

export type PriceField = 'open' | 'close' | 'vwap';

export interface FormulaParams {
  /** Nombre de séances de la fenêtre (20). */
  windowDays: number;
  /** Décote en points de base (500 = 5 %). */
  discountBps: number;
  rounding: Rounding;
  /** Le jour du CA est exclu de la fenêtre (avis VINCI : « précédant »). */
  excludeBoardDay: boolean;
  /** Cours utilisé : ouverture (« premiers cours cotés ») par défaut. */
  priceField: PriceField;
}

export const DEFAULT_FORMULA: FormulaParams = {
  windowDays: 20,
  discountBps: 500,
  rounding: 'nearest',
  excludeBoardDay: true,
  priceField: 'open',
};

export interface Session {
  date: ISODate;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  vwap?: number | null;
}

export function fieldValue(session: Session | undefined, field: PriceField): number | null {
  if (!session) return null;
  const v = session[field];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

export function indexSessions(sessions: Session[]): Map<ISODate, Session> {
  return new Map(sessions.map((s) => [s.date, s]));
}

/** Les séances de la fenêtre de calcul pour un CA à la date donnée. */
export function windowSessions(
  calendar: TradingCalendar,
  boardDate: ISODate,
  params: Pick<FormulaParams, 'windowDays' | 'excludeBoardDay'>,
): ISODate[] {
  return calendar.sessionsBefore(boardDate, params.windowDays, !params.excludeBoardDay);
}

/**
 * Prix de souscription en euros (au centime) :
 * arrondi((1 − décote) × moyenne des cours de la fenêtre), calculé en entiers.
 */
export function subscriptionPrice(values: number[], params: Pick<FormulaParams, 'discountBps' | 'rounding'>): number {
  if (values.length === 0) throw new Error('fenêtre vide');
  let sum = 0n;
  for (const v of values) sum += toUnits(v);
  // centimes = (10000 − bps) × somme(1e-4 €) / (10^6 × n)
  const num = BigInt(10_000 - params.discountBps) * sum;
  const den = 1_000_000n * BigInt(values.length);
  return Number(divRound(num, den, params.rounding)) / 100;
}

export interface WindowEvaluation {
  dates: ISODate[];
  values: (number | null)[];
  missing: ISODate[];
  price: number | null;
}

export function evaluateWindow(
  sessions: Map<ISODate, Session>,
  calendar: TradingCalendar,
  boardDate: ISODate,
  params: FormulaParams,
): WindowEvaluation {
  const dates = windowSessions(calendar, boardDate, params);
  const values = dates.map((d) => fieldValue(sessions.get(d), params.priceField));
  const missing = dates.filter((_, i) => values[i] === null);
  const price = missing.length === 0 ? subscriptionPrice(values as number[], params) : null;
  return { dates, values, missing, price };
}
