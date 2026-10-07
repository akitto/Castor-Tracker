import { diffDays, type ISODate } from './dates.ts';

/** Code d'un quadrimestre : « AAAA/n », n = 1 (janv.–avr.), 2 (mai–août), 3 (sept.–déc.). */
export type QuadCode = string;

const CODE_RE = /^(\d{4})\/([123])$/;

export function isQuadCode(code: string): boolean {
  return CODE_RE.test(code);
}

export function parseQuadCode(code: QuadCode): { year: number; index: 1 | 2 | 3 } {
  const m = CODE_RE.exec(code);
  if (!m) throw new Error(`code de quadrimestre invalide : ${code}`);
  return { year: Number(m[1]), index: Number(m[2]) as 1 | 2 | 3 };
}

export function formatQuadCode(year: number, index: number): QuadCode {
  return `${year}/${index}`;
}

/** Quadrimestre de souscription qui contient la date. */
export function quadrimesterOf(date: ISODate): QuadCode {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return formatQuadCode(year, Math.floor((month - 1) / 4) + 1);
}

export interface QuadPeriod {
  code: QuadCode;
  start: ISODate;
  end: ISODate;
  /** Fermeture des versements : le 15 du dernier mois. */
  paymentClose: ISODate;
}

const PERIODS: Record<1 | 2 | 3, { start: string; end: string; close: string }> = {
  1: { start: '01-01', end: '04-30', close: '04-15' },
  2: { start: '05-01', end: '08-31', close: '08-15' },
  3: { start: '09-01', end: '12-31', close: '12-15' },
};

export function quadPeriod(code: QuadCode): QuadPeriod {
  const { year, index } = parseQuadCode(code);
  const p = PERIODS[index];
  return {
    code,
    start: `${year}-${p.start}`,
    end: `${year}-${p.end}`,
    paymentClose: `${year}-${p.close}`,
  };
}

export function nextQuad(code: QuadCode): QuadCode {
  const { year, index } = parseQuadCode(code);
  return index === 3 ? formatQuadCode(year + 1, 1) : formatQuadCode(year, index + 1);
}

export function prevQuad(code: QuadCode): QuadCode {
  const { year, index } = parseQuadCode(code);
  return index === 1 ? formatQuadCode(year - 1, 3) : formatQuadCode(year, index - 1);
}

export function compareQuad(a: QuadCode, b: QuadCode): number {
  const pa = parseQuadCode(a);
  const pb = parseQuadCode(b);
  return pa.year !== pb.year ? pa.year - pb.year : pa.index - pb.index;
}

/** Codes de `from` à `to` inclus. */
export function quadsBetween(from: QuadCode, to: QuadCode): QuadCode[] {
  const out: QuadCode[] = [];
  for (let c = from; compareQuad(c, to) <= 0; c = nextQuad(c)) out.push(c);
  return out;
}

/**
 * Créneau par défaut du CA qui fixe le prix d'un quadrimestre, d'après les
 * dates observées : mi-octobre de l'année précédente pour /1 (15/10/2025,
 * 19/10/2023, 19/10/2022, 20/10/2021), début février pour /2 (05/02/2026),
 * juin pour /3 (23/06/2026, 13/06/2024).
 */
export function defaultBoardSlot(code: QuadCode): { start: ISODate; end: ISODate } {
  const { year, index } = parseQuadCode(code);
  if (index === 1) return { start: `${year - 1}-10-14`, end: `${year - 1}-10-23` };
  if (index === 2) return { start: `${year}-02-01`, end: `${year}-02-12` };
  return { start: `${year}-06-10`, end: `${year}-06-26` };
}

export type PaymentStatus = 'upcoming' | 'open' | 'closed' | 'ended';

/** État des versements d'un quadrimestre à une date donnée. */
export function paymentStatus(
  period: Pick<QuadPeriod, 'start' | 'end' | 'paymentClose'>,
  today: ISODate,
): { status: PaymentStatus; daysToClose: number | null; daysToStart: number | null } {
  if (today < period.start) {
    return { status: 'upcoming', daysToClose: diffDays(period.paymentClose, today), daysToStart: diffDays(period.start, today) };
  }
  if (today <= period.paymentClose) {
    return { status: 'open', daysToClose: diffDays(period.paymentClose, today), daysToStart: null };
  }
  if (today <= period.end) return { status: 'closed', daysToClose: null, daysToStart: null };
  return { status: 'ended', daysToClose: null, daysToStart: null };
}
