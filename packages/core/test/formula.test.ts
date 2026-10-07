import { describe, expect, it } from 'vitest';
import {
  divRound,
  evaluateWindow,
  fieldValue,
  indexSessions,
  roundCents,
  subscriptionPrice,
  toUnits,
  TradingCalendar,
  DEFAULT_FORMULA,
} from '../src/index.ts';
import { flatSessions } from './helpers.ts';

const twenty = (v: number) => Array.from({ length: 20 }, () => v);

describe('arithmétique exacte', () => {
  it('convertit en dix-millièmes', () => {
    expect(toUnits(112.45)).toBe(1_124_500n);
    expect(toUnits(112.44999694824219)).toBe(1_124_500n);
    expect(() => toUnits(Number.NaN)).toThrow();
  });

  it('divise avec arrondi', () => {
    expect(divRound(10n, 4n, 'nearest')).toBe(3n);
    expect(divRound(9n, 4n, 'nearest')).toBe(2n);
    expect(divRound(9n, 4n, 'up')).toBe(3n);
    expect(divRound(11n, 4n, 'down')).toBe(2n);
    expect(divRound(8n, 4n, 'up')).toBe(2n);
    expect(() => divRound(1n, 0n, 'nearest')).toThrow();
    expect(() => divRound(-1n, 2n, 'nearest')).toThrow();
  });

  it('arrondit les flottants au centime', () => {
    expect(roundCents(95.094999)).toBe(95.09);
    expect(roundCents(95.095)).toBe(95.1);
    expect(roundCents(95.091, 'up')).toBe(95.1);
    expect(roundCents(95.099, 'down')).toBe(95.09);
    expect(roundCents(95.1, 'up')).toBe(95.1);
  });
});

describe('formule officielle (RG-01)', () => {
  it('applique la décote de 5 %', () => {
    expect(subscriptionPrice(twenty(100), DEFAULT_FORMULA)).toBe(95);
    expect(subscriptionPrice(twenty(117.12), DEFAULT_FORMULA)).toBe(111.26);
  });

  it('tranche un demi-centime exact vers le haut, sans erreur de flottant', () => {
    // 0,95 × 100,10 = 95,095 : en flottant 95,09499…, en entiers exactement 95,095
    expect(0.95 * 100.1).toBeLessThan(95.095);
    expect(subscriptionPrice(twenty(100.1), { discountBps: 500, rounding: 'nearest' })).toBe(95.1);
    expect(subscriptionPrice(twenty(100.1), { discountBps: 500, rounding: 'down' })).toBe(95.09);
    expect(subscriptionPrice(twenty(100.1), { discountBps: 500, rounding: 'up' })).toBe(95.1);
  });

  it('distingue les trois arrondis', () => {
    const values = twenty(100.01); // 95,0095
    expect(subscriptionPrice(values, { discountBps: 500, rounding: 'nearest' })).toBe(95.01);
    expect(subscriptionPrice(values, { discountBps: 500, rounding: 'down' })).toBe(95.0);
    expect(subscriptionPrice(values, { discountBps: 500, rounding: 'up' })).toBe(95.01);
  });

  it('refuse une fenêtre vide', () => {
    expect(() => subscriptionPrice([], DEFAULT_FORMULA)).toThrow();
  });

  it('lit le type de cours demandé', () => {
    expect(fieldValue({ date: '2026-10-07', open: 120.1, close: 0 }, 'open')).toBe(120.1);
    expect(fieldValue({ date: '2026-10-07', open: 120.1, close: 0 }, 'close')).toBeNull();
    expect(fieldValue(undefined, 'open')).toBeNull();
  });

  it('évalue une fenêtre et signale les séances manquantes', () => {
    const cal = new TradingCalendar();
    const sessions = flatSessions('2025-09-01', '2025-10-31', 117.12, cal).filter((s) => s.date !== '2025-09-30');
    const ev = evaluateWindow(indexSessions(sessions), cal, '2025-10-15', DEFAULT_FORMULA);
    expect(ev.dates).toHaveLength(20);
    expect(ev.missing).toEqual(['2025-09-30']);
    expect(ev.price).toBeNull();
    const full = evaluateWindow(indexSessions(flatSessions('2025-09-01', '2025-10-31', 117.12, cal)), cal, '2025-10-15', DEFAULT_FORMULA);
    expect(full.price).toBe(111.26);
  });
});
