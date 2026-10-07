import { mulberry32, normal, TradingCalendar, type ISODate, type Session } from '../src/index.ts';

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Séances synthétiques (marche aléatoire) sur le calendrier Euronext. */
export function syntheticSessions(
  from: ISODate,
  to: ISODate,
  seed = 1,
  start = 100,
  calendar = new TradingCalendar(),
): Session[] {
  const rand = mulberry32(seed);
  let price = start;
  const out: Session[] = [];
  for (const date of calendar.sessionsBetween(from, to)) {
    const open = round2(price * Math.exp(0.006 * normal(rand)));
    const close = round2(open * Math.exp(0.01 * normal(rand)));
    out.push({
      date,
      open,
      close,
      high: round2(Math.max(open, close) * 1.004),
      low: round2(Math.min(open, close) * 0.996),
      vwap: Math.round(((open + close) / 2) * 10_000) / 10_000,
    });
    price = close;
  }
  return out;
}

/** Séances à cours constant. */
export function flatSessions(from: ISODate, to: ISODate, value: number, calendar = new TradingCalendar()): Session[] {
  return calendar.sessionsBetween(from, to).map((date) => ({ date, open: value, close: value, high: value, low: value }));
}
