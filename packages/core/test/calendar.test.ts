import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertISODate,
  diffDays,
  easterSunday,
  euronextHolidays,
  isISODate,
  maxDate,
  minDate,
  parisClock,
  parisDateOf,
  TradingCalendar,
  weekday,
  windowSessions,
  DEFAULT_FORMULA,
} from '../src/index.ts';

describe('dates', () => {
  it('valide les dates ISO', () => {
    expect(isISODate('2026-02-28')).toBe(true);
    expect(isISODate('2026-02-29')).toBe(false);
    expect(isISODate('2024-02-29')).toBe(true);
    expect(isISODate('26-02-28')).toBe(false);
    expect(() => assertISODate('2026-13-01')).toThrow();
    expect(assertISODate('2026-10-07')).toBe('2026-10-07');
  });

  it('calcule sur les dates', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-10-23', '2026-10-07')).toBe(16);
    expect(weekday('2026-10-07')).toBe(3);
    expect(minDate('2026-01-02', '2025-12-31')).toBe('2025-12-31');
    expect(maxDate('2026-01-02', '2025-12-31')).toBe('2026-01-02');
  });

  it("donne l'heure de Paris, été comme hiver", () => {
    // 07:20 UTC le 7 octobre 2026 = 09:20 à Paris (heure d'été)
    expect(parisClock(new Date('2026-10-07T07:20:00Z'))).toEqual({ date: '2026-10-07', minutes: 9 * 60 + 20 });
    // 08:20 UTC le 2 décembre 2026 = 09:20 à Paris (heure d'hiver)
    expect(parisClock(new Date('2026-12-02T08:20:00Z'))).toEqual({ date: '2026-12-02', minutes: 9 * 60 + 20 });
    // 23:30 UTC = lendemain à Paris
    expect(parisDateOf(Date.parse('2026-10-07T23:30:00Z'))).toBe('2026-10-08');
  });
});

describe('calendrier Euronext', () => {
  it('calcule le dimanche de Pâques', () => {
    expect(easterSunday(2019)).toBe('2019-04-21');
    expect(easterSunday(2021)).toBe('2021-04-04');
    expect(easterSunday(2024)).toBe('2024-03-31');
    expect(easterSunday(2025)).toBe('2025-04-20');
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
  });

  it('liste les fermetures standard', () => {
    expect(euronextHolidays(2026).map((h) => h.date)).toEqual([
      '2026-01-01',
      '2026-04-03',
      '2026-04-06',
      '2026-05-01',
      '2026-12-25',
      '2026-12-26',
    ]);
  });

  it('distingue séances et fermetures', () => {
    const cal = new TradingCalendar(['2026-07-14']);
    expect(cal.isTradingDay('2026-10-07')).toBe(true);
    expect(cal.isTradingDay('2026-10-10')).toBe(false); // samedi
    expect(cal.isTradingDay('2026-04-03')).toBe(false); // Vendredi saint
    expect(cal.isTradingDay('2026-12-24')).toBe(true); // séance courte
    expect(cal.isTradingDay('2026-12-31')).toBe(true); // séance courte
    expect(cal.isTradingDay('2026-05-08')).toBe(true); // férié français, Euronext ouvert
    expect(cal.isTradingDay('2026-07-14')).toBe(false); // fermeture saisie en base
    expect(cal.previousSession('2026-04-07')).toBe('2026-04-02');
    expect(cal.nextSession('2026-04-02')).toBe('2026-04-07');
    expect(cal.sessionsBetween('2026-12-23', '2027-01-04')).toEqual([
      '2026-12-23',
      '2026-12-24',
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-04',
    ]);
    expect(cal.sessionsBefore('2026-10-07', 0)).toEqual([]);
    expect(cal.sessionsBefore('2026-10-07', 2, true)).toEqual(['2026-10-06', '2026-10-07']);
  });
});

describe('fenêtre de 20 séances (RG-01, RG-03)', () => {
  const cal = new TradingCalendar();
  const cases: [string, string, string, string][] = [
    ['2026/3', '2026-06-23', '2026-05-26', '2026-06-22'],
    ['2026/2', '2026-02-05', '2026-01-08', '2026-02-04'],
    ['2026/1', '2025-10-15', '2025-09-17', '2025-10-14'],
    ['2024/3', '2024-06-13', '2024-05-16', '2024-06-12'],
    ['2022/1', '2021-10-20', '2021-09-22', '2021-10-19'],
  ];
  it.each(cases)('%s : CA du %s → %s à %s', (_code, board, first, last) => {
    const w = windowSessions(cal, board, DEFAULT_FORMULA);
    expect(w).toHaveLength(20);
    expect(w[0]).toBe(first);
    expect(w[19]).toBe(last);
  });

  it('saute Pâques et le 1er mai (REC-02)', () => {
    const w = windowSessions(cal, '2026-05-04', DEFAULT_FORMULA);
    expect(w).toHaveLength(20);
    expect(w[0]).toBe('2026-04-01');
    expect(w[19]).toBe('2026-04-30');
    expect(w).not.toContain('2026-04-03');
    expect(w).not.toContain('2026-04-06');
    expect(w).not.toContain('2026-05-01');
  });

  it('inclut le jour du CA si la variante le demande', () => {
    const w = windowSessions(cal, '2025-10-15', { windowDays: 20, excludeBoardDay: false });
    expect(w[0]).toBe('2025-09-18');
    expect(w[19]).toBe('2025-10-15');
  });

  it('compte les séances connues au 7 octobre 2026 pour chaque date du créneau', () => {
    const known = cal
      .sessionsBetween('2026-10-14', '2026-10-23')
      .map((d) => windowSessions(cal, d, DEFAULT_FORMULA).filter((s) => s <= '2026-10-07').length);
    expect(known).toEqual([16, 15, 14, 13, 12, 11, 10, 9]);
  });
});
