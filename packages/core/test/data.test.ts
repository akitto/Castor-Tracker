import { describe, expect, it } from 'vitest';
import {
  compareQuad,
  defaultBoardSlot,
  formatQuadCode,
  gainPct,
  gainRange,
  htmlTableToCsv,
  isQuadCode,
  nextQuad,
  parseDateCell,
  parseDecimal,
  parsePriceCsv,
  parseQuadCode,
  parseQuadrimesterCsv,
  parseYahooChart,
  paymentStatus,
  prevQuad,
  quadPeriod,
  quadrimesterOf,
  quadsBetween,
  rollingTheoretical,
  splitCsvLine,
  subscriptionPrice,
  TradingCalendar,
  DEFAULT_FORMULA,
} from '../src/index.ts';
import { flatSessions } from './helpers.ts';

describe('quadrimestres (RG-02)', () => {
  it('lit et écrit les codes', () => {
    expect(isQuadCode('2027/1')).toBe(true);
    expect(isQuadCode('2027/4')).toBe(false);
    expect(parseQuadCode('2026/3')).toEqual({ year: 2026, index: 3 });
    expect(() => parseQuadCode('2026-3')).toThrow();
    expect(formatQuadCode(2027, 2)).toBe('2027/2');
  });

  it('situe une date et enchaîne les quadrimestres', () => {
    expect(quadrimesterOf('2026-10-07')).toBe('2026/3');
    expect(quadrimesterOf('2026-04-30')).toBe('2026/1');
    expect(quadrimesterOf('2026-05-01')).toBe('2026/2');
    expect(nextQuad('2026/3')).toBe('2027/1');
    expect(nextQuad('2027/1')).toBe('2027/2');
    expect(prevQuad('2027/1')).toBe('2026/3');
    expect(prevQuad('2026/3')).toBe('2026/2');
    expect(compareQuad('2026/3', '2027/1')).toBeLessThan(0);
    expect(compareQuad('2027/2', '2027/1')).toBeGreaterThan(0);
    expect(quadsBetween('2026/2', '2027/1')).toEqual(['2026/2', '2026/3', '2027/1']);
  });

  it('donne les périodes et la fermeture des versements', () => {
    expect(quadPeriod('2027/1')).toEqual({
      code: '2027/1',
      start: '2027-01-01',
      end: '2027-04-30',
      paymentClose: '2027-04-15',
    });
    expect(quadPeriod('2026/2').paymentClose).toBe('2026-08-15');
    expect(quadPeriod('2026/3')).toMatchObject({ start: '2026-09-01', end: '2026-12-31', paymentClose: '2026-12-15' });
  });

  it('propose un créneau de CA par défaut', () => {
    expect(defaultBoardSlot('2027/1')).toEqual({ start: '2026-10-14', end: '2026-10-23' });
    expect(defaultBoardSlot('2027/2')).toEqual({ start: '2027-02-01', end: '2027-02-12' });
    expect(defaultBoardSlot('2027/3')).toEqual({ start: '2027-06-10', end: '2027-06-26' });
  });

  it('donne l’état des versements', () => {
    const p = quadPeriod('2026/3');
    expect(paymentStatus(p, '2026-10-07')).toEqual({ status: 'open', daysToClose: 69, daysToStart: null });
    expect(paymentStatus(p, '2026-12-16').status).toBe('closed');
    expect(paymentStatus(p, '2027-01-02').status).toBe('ended');
    expect(paymentStatus(quadPeriod('2027/1'), '2026-10-07')).toMatchObject({ status: 'upcoming', daysToStart: 86 });
  });
});

describe('gains (RG-11)', () => {
  it('calcule la plus-value latente', () => {
    expect(gainPct(131.26, 119.33)).toBeCloseTo(0.099975, 6);
    expect(() => gainPct(100, 0)).toThrow();
    const r = gainRange(120, 110, 115);
    expect(r.low).toBeCloseTo(120 / 115 - 1, 12);
    expect(r.high).toBeCloseTo(120 / 110 - 1, 12);
  });

  it('trace le prix théorique glissant (EF-11)', () => {
    const cal = new TradingCalendar();
    const sessions = flatSessions('2026-08-03', '2026-10-07', 120, cal);
    const series = rollingTheoretical(sessions, cal, DEFAULT_FORMULA);
    expect(series[0].date).toBe('2026-08-31');
    expect(series.every((p) => p.price === subscriptionPrice(Array(20).fill(120), DEFAULT_FORMULA))).toBe(true);
    expect(rollingTheoretical(sessions, cal, DEFAULT_FORMULA, '2026-10-01')).toHaveLength(5);
  });
});

describe('import CSV', () => {
  it('découpe les lignes avec guillemets', () => {
    expect(splitCsvLine('"a;b";c;"d ""e"""', ';')).toEqual(['a;b', 'c', 'd "e"']);
  });

  it('lit les nombres et les dates', () => {
    expect(parseDecimal('1 234,56')).toBe(1234.56);
    expect(parseDecimal('1,234.56')).toBe(1234.56);
    expect(parseDecimal('112.45')).toBe(112.45);
    expect(parseDecimal('112,45 €')).toBe(112.45);
    expect(parseDecimal('1,234,567')).toBe(1234567);
    expect(parseDecimal('-')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
    expect(parseDecimal(undefined)).toBeNull();
    expect(parseDateCell('2026-10-07')).toBe('2026-10-07');
    expect(parseDateCell('07/10/2026')).toBe('2026-10-07');
    expect(parseDateCell('7.10.2026')).toBe('2026-10-07');
    expect(parseDateCell('31/02/2026')).toBeNull();
    expect(parseDateCell('2026-02-31')).toBeNull();
    expect(parseDateCell('')).toBeNull();
  });

  it('lit un export Euronext', () => {
    const csv = [
      '"Historical Data"',
      '"From 01/10/2026 to 07/10/2026"',
      'Date;Open;High;Low;Last;Close;"Number of Shares";"Number of Trades";Turnover;VWAP',
      '07/10/2026;121.20;122.05;120.80;121.90;121.90;612345;4210;74598765;121.6123',
      '06/10/2026;120.50;121.40;120.10;121.00;121.00;598000;4100;72310000;120.9001',
    ].join('\n');
    const r = parsePriceCsv(csv);
    expect(r.delimiter).toBe(';');
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { date: '2026-10-06', open: 120.5, high: 121.4, low: 120.1, close: 121, volume: 598000, vwap: 120.9001 },
      { date: '2026-10-07', open: 121.2, high: 122.05, low: 120.8, close: 121.9, volume: 612345, vwap: 121.6123 },
    ]);
  });

  it('ignore « Adj Close » dans un export Yahoo', () => {
    const csv = 'Date,Open,High,Low,Close,Adj Close,Volume\n2026-10-07,121.2,122.05,120.8,121.9,118.5,612345\n';
    const r = parsePriceCsv(csv);
    expect(r.rows[0]).toEqual({ date: '2026-10-07', open: 121.2, high: 122.05, low: 120.8, close: 121.9, volume: 612345 });
  });

  it('accepte « Last » faute de « Close » et les en-têtes français', () => {
    const r = parsePriceCsv('Date;Ouverture;Plus haut;Plus bas;Last\n07/10/2026;121,20;122,05;120,80;121,90\n');
    expect(r.rows[0]).toEqual({ date: '2026-10-07', open: 121.2, high: 122.05, low: 120.8, close: 121.9 });
  });

  it('signale les lignes invalides', () => {
    const r = parsePriceCsv(
      'Date,Open,Close\n2026-10-07,121.2,121.9\nnope,1,2\n2026-10-08,,\n2026-10-09,-5,121\n2026-10-07,121.3,122\n',
    );
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toEqual({ date: '2026-10-07', open: 121.3, close: 122 });
    expect(r.rows[1]).toEqual({ date: '2026-10-09', open: null, close: 121 });
    expect(r.errors).toHaveLength(4);
    expect(parsePriceCsv('a,b\n1,2').errors[0]).toContain('en-tête introuvable');
  });

  it('lit le jeu de référence des quadrimestres', () => {
    const r = parseQuadrimesterCsv(
      'code;date_ca;prix;avis\n2026/1;15/10/2025;111,27;https://example.org/avis.pdf\n2026/2;;112,93;\n2026/9;;1;\n2026/3;23/06/2026;-1;\n',
    );
    expect(r.rows).toEqual([
      { code: '2026/1', boardDate: '2025-10-15', officialPrice: 111.27, noticeUrl: 'https://example.org/avis.pdf' },
      { code: '2026/2', boardDate: null, officialPrice: 112.93, noticeUrl: null },
    ]);
    expect(r.errors).toHaveLength(2);
    expect(parseQuadrimesterCsv('').errors).toEqual(['fichier vide']);
    expect(parseQuadrimesterCsv('x;y\n1;2').errors[0]).toContain('code');
  });
});

describe('API chart de Yahoo', () => {
  const t = (iso: string) => Date.parse(iso) / 1000;
  it('lit les barres quotidiennes en heure de Paris, sans ajustement', () => {
    const json = {
      chart: {
        error: null,
        result: [
          {
            meta: {
              symbol: 'DG.PA',
              currency: 'EUR',
              exchangeTimezoneName: 'Europe/Paris',
              regularMarketPrice: 121.95000457763672,
              regularMarketTime: t('2026-10-07T13:05:00Z'),
              chartPreviousClose: 119.9,
            },
            timestamp: [t('2026-10-05T07:00:00Z'), t('2026-10-06T07:00:00Z'), t('2026-10-07T07:00:00Z'), t('2026-10-07T13:05:00Z')],
            indicators: {
              quote: [
                {
                  open: [120.0999984741211, 120.5, 121.19999694824219, 121.8],
                  high: [121, 121.4, 122, 122.05],
                  low: [119.8, 120.1, 120.8, 121.5],
                  close: [120.6, 121, 121.7, 121.95000457763672],
                  volume: [500000, 598000, 300000, 312345],
                },
              ],
              adjclose: [{ adjclose: [1, 2, 3, 4] }],
            },
            events: {
              dividends: {
                [String(t('2026-04-21T07:00:00Z'))]: { amount: 3.9500000476837, date: t('2026-04-21T07:00:00Z') },
                [String(t('2025-11-12T08:00:00Z'))]: { amount: 1.05, date: t('2025-11-12T08:00:00Z') },
              },
            },
          },
        ],
      },
    };
    const c = parseYahooChart(json);
    expect(c.symbol).toBe('DG.PA');
    expect(c.timezone).toBe('Europe/Paris');
    expect(c.regularMarketPrice).toBe(121.95);
    expect(c.regularMarketTime).toBe(Date.parse('2026-10-07T13:05:00Z'));
    expect(c.previousClose).toBe(119.9);
    expect(c.bars.map((b) => b.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
    expect(c.bars[0].open).toBe(120.1);
    expect(c.bars[2]).toEqual({ date: '2026-10-07', open: 121.2, high: 122.05, low: 120.8, close: 121.95, volume: 312345 });
    expect(c.dividends).toEqual([
      { exDate: '2025-11-12', amount: 1.05 },
      { exDate: '2026-04-21', amount: 3.95 },
    ]);
  });

  it('remonte les erreurs', () => {
    expect(() => parseYahooChart({})).toThrow();
    expect(() => parseYahooChart({ chart: { error: { description: 'No data found' } } })).toThrow(/No data/);
    expect(() => parseYahooChart({ chart: { result: [] } })).toThrow();
    const empty = parseYahooChart({ chart: { result: [{ meta: {}, timestamp: [t('2026-10-07T07:00:00Z')], indicators: { quote: [{ open: [null], close: [null] }] } }] } });
    expect(empty.bars).toEqual([]);
    expect(empty.regularMarketPrice).toBeNull();
    expect(empty.regularMarketTime).toBeNull();
    expect(empty.dividends).toEqual([]);
  });
});

describe('page historique Euronext', () => {
  it('convertit un tableau HTML en CSV', () => {
    const html = `<div><table class="table"><thead><tr><th>Date</th><th>Open</th><th>High</th><th>Low</th><th>Last</th>
      <th>Close</th><th>Number of shares</th><th>Turnover</th><th>VWAP</th></tr></thead>
      <tbody><tr><td>07/10/2026</td><td>121.20</td><td>122.05</td><td>120.80</td><td>121.90</td><td><span>121.90</span></td>
      <td>612&nbsp;345</td><td>74&#160;598&#x20;765</td><td>121.6123</td></tr></tbody></table></div>`;
    const csv = htmlTableToCsv(html);
    expect(csv.split('\n')[0]).toBe('Date;Open;High;Low;Last;Close;Number of shares;Turnover;VWAP');
    const r = parsePriceCsv(csv);
    expect(r.rows).toEqual([
      { date: '2026-10-07', open: 121.2, high: 122.05, low: 120.8, close: 121.9, volume: 612345, vwap: 121.6123 },
    ]);
    expect(htmlTableToCsv('<p>rien</p>')).toBe('');
    expect(htmlTableToCsv('<table><tr><td>a&amp;b &unknown; &#65;</td></tr></table>')).toBe('a&b &unknown, A');
  });
});
