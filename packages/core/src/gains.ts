import type { TradingCalendar } from './calendar.ts';
import type { ISODate } from './dates.ts';
import { fieldValue, subscriptionPrice, windowSessions, type FormulaParams, type Session } from './formula.ts';

/** Plus-value latente au cours `current` pour un prix de souscription `price` (0,05 = +5 %). */
export function gainPct(current: number, price: number): number {
  if (!(price > 0)) throw new Error('prix de souscription invalide');
  return current / price - 1;
}

/** Fourchette de gain pour un prix estimé : le prix bas donne le gain haut. */
export function gainRange(current: number, low: number, high: number): { low: number; high: number } {
  return { low: gainPct(current, high), high: gainPct(current, low) };
}

/**
 * Prix théorique glissant (EF-11) : pour chaque séance, le prix qu'aurait
 * donné un CA réuni ce jour-là. Seules les séances dont la fenêtre est
 * complète sont renvoyées.
 */
export function rollingTheoretical(
  sessions: Session[],
  calendar: TradingCalendar,
  params: FormulaParams,
  from?: ISODate,
): { date: ISODate; price: number }[] {
  const byDate = new Map(sessions.map((s) => [s.date, s]));
  const dates = sessions
    .map((s) => s.date)
    .filter((d) => (!from || d >= from) && calendar.isTradingDay(d))
    .sort();
  const out: { date: ISODate; price: number }[] = [];
  for (const d of dates) {
    const window = windowSessions(calendar, d, params);
    const values: number[] = [];
    for (const w of window) {
      const v = fieldValue(byDate.get(w), params.priceField);
      if (v === null) break;
      values.push(v);
    }
    if (values.length === window.length) out.push({ date: d, price: subscriptionPrice(values, params) });
  }
  return out;
}
