import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePriceCsv, runBacktest, type Reference } from '../src/index.ts';

/**
 * REC-01 sur données réelles : déposer un export des cours VINCI (DG.PA,
 * cours bruts) dans test/fixtures/dg-pa.csv, au format Euronext ou Yahoo.
 * Sans fichier, le test est ignoré : la même vérification tourne en
 * production avec le backtest du back-office.
 */
const fixture = fileURLToPath(new URL('./fixtures/dg-pa.csv', import.meta.url));
const hasFixture = existsSync(fixture);

const references: Reference[] = [
  { code: '2026/3', boardDate: '2026-06-23', officialPrice: 119.33 },
  { code: '2026/2', boardDate: '2026-02-05', officialPrice: 112.93 },
  { code: '2026/1', boardDate: '2025-10-15', officialPrice: 111.27 },
  { code: '2024/3', boardDate: '2024-06-13', officialPrice: 107.41 },
  { code: '2022/1', boardDate: '2021-10-20', officialPrice: 85.59 },
];

describe.skipIf(!hasFixture)('prix de référence sur cours réels (REC-01)', () => {
  it('recalcule les cinq prix officiels au centime', () => {
    const { rows } = parsePriceCsv(readFileSync(fixture, 'utf8'));
    const report = runBacktest({
      sessions: rows,
      references,
      variants: [{ priceField: 'open', rounding: 'nearest', excludeBoardDay: true }],
    });
    const v = report.variants[0];
    expect(v.rows.filter((r) => !r.exact)).toEqual([]);
    expect(v.nExact).toBe(5);
  });
});
