import { addDays, isWeekend, type ISODate } from './dates.ts';

/** Dimanche de Pâques (algorithme grégorien anonyme). */
export function easterSunday(year: number): ISODate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface Holiday {
  date: ISODate;
  label: string;
}

/** Fermetures standard d'Euronext Paris pour une année. */
export function euronextHolidays(year: number): Holiday[] {
  const easter = easterSunday(year);
  return [
    { date: `${year}-01-01`, label: "Jour de l'an" },
    { date: addDays(easter, -2), label: 'Vendredi saint' },
    { date: addDays(easter, 1), label: 'Lundi de Pâques' },
    { date: `${year}-05-01`, label: 'Fête du travail' },
    { date: `${year}-12-25`, label: 'Noël' },
    { date: `${year}-12-26`, label: 'Lendemain de Noël' },
  ];
}

/**
 * Calendrier des séances Euronext Paris : jours ouvrés hors fermetures
 * standard et hors fermetures supplémentaires saisies en base.
 * Les séances courtes (24 et 31 décembre) restent des séances.
 */
export class TradingCalendar {
  private readonly extra: Set<ISODate>;
  private readonly byYear = new Map<number, Set<ISODate>>();

  constructor(extraClosures: Iterable<ISODate> = []) {
    this.extra = new Set(extraClosures);
  }

  isHoliday(date: ISODate): boolean {
    if (this.extra.has(date)) return true;
    const year = Number(date.slice(0, 4));
    let set = this.byYear.get(year);
    if (!set) {
      set = new Set(euronextHolidays(year).map((h) => h.date));
      this.byYear.set(year, set);
    }
    return set.has(date);
  }

  isTradingDay(date: ISODate): boolean {
    return !isWeekend(date) && !this.isHoliday(date);
  }

  previousSession(date: ISODate): ISODate {
    let d = addDays(date, -1);
    while (!this.isTradingDay(d)) d = addDays(d, -1);
    return d;
  }

  nextSession(date: ISODate): ISODate {
    let d = addDays(date, 1);
    while (!this.isTradingDay(d)) d = addDays(d, 1);
    return d;
  }

  /**
   * Les `n` séances qui précèdent `date`, dans l'ordre chronologique.
   * `inclusive` : la séance de `date` elle-même compte si c'en est une.
   */
  sessionsBefore(date: ISODate, n: number, inclusive = false): ISODate[] {
    if (n <= 0) return [];
    const out: ISODate[] = [];
    let d = inclusive ? date : addDays(date, -1);
    while (out.length < n) {
      if (this.isTradingDay(d)) out.push(d);
      d = addDays(d, -1);
    }
    return out.reverse();
  }

  /** Séances entre deux dates, bornes incluses. */
  sessionsBetween(from: ISODate, to: ISODate): ISODate[] {
    const out: ISODate[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (this.isTradingDay(d)) out.push(d);
    }
    return out;
  }
}
