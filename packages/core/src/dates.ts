/**
 * Dates calendaires au format ISO « AAAA-MM-JJ », sans fuseau.
 * Toute la logique de séance travaille sur ces chaînes : la comparaison
 * lexicographique suit l'ordre chronologique.
 */
export type ISODate = string;

const DAY_MS = 86_400_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(value: string): boolean {
  if (!ISO_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === value;
}

export function assertISODate(value: string, label = 'date'): ISODate {
  if (!isISODate(value)) throw new Error(`${label} invalide : ${value}`);
  return value;
}

export function toDayNumber(date: ISODate): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function fromDayNumber(day: number): ISODate {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: ISODate, days: number): ISODate {
  return fromDayNumber(toDayNumber(date) + days);
}

/** Nombre de jours calendaires de b à a (a − b). */
export function diffDays(a: ISODate, b: ISODate): number {
  return toDayNumber(a) - toDayNumber(b);
}

/** 0 = dimanche … 6 = samedi. */
export function weekday(date: ISODate): number {
  return new Date(toDayNumber(date) * DAY_MS).getUTCDay();
}

export function isWeekend(date: ISODate): boolean {
  const w = weekday(date);
  return w === 0 || w === 6;
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a <= b ? a : b;
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a >= b ? a : b;
}

export interface ParisClock {
  /** Date du jour à Paris. */
  date: ISODate;
  /** Minutes écoulées depuis minuit, heure de Paris. */
  minutes: number;
}

const parisFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Date et heure de Paris pour un instant donné (heure d'été incluse). */
export function parisClock(now: Date = new Date()): ParisClock {
  const parts = parisFormatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** Date de Paris correspondant à un horodatage en millisecondes. */
export function parisDateOf(epochMs: number): ISODate {
  return parisClock(new Date(epochMs)).date;
}
