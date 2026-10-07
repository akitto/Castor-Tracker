import { diffDays, type ISODate } from '@castor/core';

const MINUS = '−';
const euroFmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const int = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

const fixMinus = (s: string) => s.replace(/^-/, MINUS).replace(/-/g, MINUS);

export function euro(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return fixMinus(euroFmt.format(v));
}

export function euroShort(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${int.format(v)} €`;
}

export function amount(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return fixMinus(num2.format(v));
}

/** Écart signé en euros : « +0,11 € », « −0,06 € », « 0,00 € ». */
export function euroDiff(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (Math.abs(v) < 0.005) return '0,00 €';
  return `${v > 0 ? '+' : MINUS}${num2.format(Math.abs(v))} €`;
}

/** Pourcentage signé (0,054 → « +5,4 % »). */
export function pct(v: number | null | undefined, digits = 1, signed = true): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const f = digits === 1 ? num1 : new Intl.NumberFormat('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const s = f.format(Math.abs(v * 100));
  const zero = Math.abs(v) < 0.5 * 10 ** -(digits + 2);
  const sign = zero ? '' : v < 0 ? MINUS : signed ? '+' : '';
  return `${sign}${s} %`;
}

export function probability(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  if (p >= 0.99) return 'plus de 99 %';
  if (p <= 0.01) return 'moins de 1 %';
  return `${int.format(p * 100)} %`;
}

function utc(date: ISODate): Date {
  return new Date(`${date}T00:00:00Z`);
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function dfmt(key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('fr-FR', opts);
    fmtCache.set(key, f);
  }
  return f;
}

/** 07/10/2026 */
export function dateFr(d: ISODate | null | undefined): string {
  if (!d) return '—';
  return dfmt('d', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).format(utc(d));
}

/** 07/10 */
export function dayMonth(d: ISODate | null | undefined): string {
  if (!d) return '—';
  return dfmt('dm', { timeZone: 'UTC', day: '2-digit', month: '2-digit' }).format(utc(d));
}

/** 7 oct. 2026 */
export function dateLong(d: ISODate | null | undefined, withYear = true): string {
  if (!d) return '—';
  return dfmt(withYear ? 'l' : 'ly', { timeZone: 'UTC', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) }).format(utc(d));
}

/** mar. 20 oct. */
export function weekdayDate(d: ISODate | null | undefined): string {
  if (!d) return '—';
  return dfmt('w', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(utc(d));
}

/** 14 – 23 oct. 2026 ; 28 sept. – 3 oct. 2026 */
export function dateRange(a: ISODate, b: ISODate): string {
  if (a === b) return dateLong(a);
  const sameMonth = a.slice(0, 7) === b.slice(0, 7);
  const sameYear = a.slice(0, 4) === b.slice(0, 4);
  if (sameMonth) return `${Number(a.slice(8, 10))} – ${dateLong(b)}`;
  if (sameYear) return `${dateLong(a, false)} – ${dateLong(b)}`;
  return `${dateLong(a)} – ${dateLong(b)}`;
}

/** Horodatage → « mer. 7 oct. à 15:45 » (heure de Paris). */
export function stamp(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const day = dfmt('sd', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  const time = dfmt('st', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(d);
  return `${day} à ${time}`;
}

/** Horodatage → « 07/10 15:45 » (heure de Paris). */
export function stampShort(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return dfmt('ss', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    .format(d)
    .replace(',', '')
    .replace(' ', ' ');
}

export function timeOnly(ts: string | null | undefined): string {
  if (!ts) return '—';
  return dfmt('t', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
}

/** « dans 13 jours », « demain », « aujourd'hui », « il y a 3 jours ». */
export function relativeDays(target: ISODate, today: ISODate): string {
  const n = diffDays(target, today);
  if (n === 0) return 'aujourd’hui';
  if (n === 1) return 'demain';
  if (n === -1) return 'hier';
  return n > 0 ? `dans ${n} jours` : `il y a ${-n} jours`;
}

export function countdown(target: ISODate, today: ISODate): string {
  const n = diffDays(target, today);
  return n >= 0 ? `J${MINUS}${n}` : `J+${-n}`;
}

export function reliabilityInt(v: number | null | undefined): number {
  return v === null || v === undefined ? 0 : Math.round(v);
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

/** Période de souscription : « sept. – déc. 2026 » (mois entiers), sinon dates complètes. */
export function periodLabel(start: ISODate, end: ISODate): string {
  const lastDay = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)), 0)).getUTCDate();
  if (start.endsWith('-01') && Number(end.slice(8, 10)) === lastDay) {
    const m = dfmt('m', { timeZone: 'UTC', month: 'short' });
    const sameYear = start.slice(0, 4) === end.slice(0, 4);
    return `${m.format(utc(start))}${sameYear ? '' : ` ${start.slice(0, 4)}`} – ${m.format(utc(end))} ${end.slice(0, 4)}`;
  }
  return dateRange(start, end);
}
