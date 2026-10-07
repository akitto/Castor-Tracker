import { parisDateOf, type ISODate } from './dates.ts';
import type { PriceRow } from './csv.ts';
import type { Dividend } from './estimate.ts';

/** Réponse utile de l'API « chart » de Yahoo Finance (non officielle). */
export interface YahooChart {
  symbol: string;
  currency: string | null;
  timezone: string | null;
  bars: PriceRow[];
  regularMarketPrice: number | null;
  /** Horodatage du dernier cours, en millisecondes. */
  regularMarketTime: number | null;
  previousClose: number | null;
  /** Détachements de dividende (paramètre `events=div`), montants bruts. */
  dividends: Dividend[];
}

type Num = number | null | undefined;

function clean(v: Num): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 10_000) / 10_000 : null;
}

/**
 * Lecture d'une réponse `v8/finance/chart` : barres quotidiennes en heure de
 * Paris, cours bruts (`indicators.quote`), jamais `adjclose`. Les doublons
 * d'une même séance (barre du jour en double) sont fusionnés.
 */
export function parseYahooChart(json: unknown): YahooChart {
  const chart = (json as { chart?: { result?: unknown[]; error?: { description?: string } | null } })?.chart;
  if (!chart) throw new Error('réponse Yahoo illisible');
  if (chart.error) throw new Error(`Yahoo : ${chart.error.description ?? 'erreur'}`);
  const result = chart.result?.[0] as
    | {
        meta?: Record<string, unknown>;
        timestamp?: number[];
        indicators?: { quote?: { open?: Num[]; high?: Num[]; low?: Num[]; close?: Num[]; volume?: Num[] }[] };
        events?: { dividends?: Record<string, { amount?: number; date?: number }> };
      }
    | undefined;
  if (!result) throw new Error('Yahoo : aucun résultat');
  const meta = result.meta ?? {};
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const byDate = new Map<ISODate, PriceRow>();
  ts.forEach((t, i) => {
    const date = parisDateOf(t * 1000);
    const bar: PriceRow = {
      date,
      open: clean(q.open?.[i]),
      high: clean(q.high?.[i]),
      low: clean(q.low?.[i]),
      close: clean(q.close?.[i]),
      volume: typeof q.volume?.[i] === 'number' ? (q.volume?.[i] as number) : null,
    };
    if (bar.open === null && bar.close === null) return;
    const prev = byDate.get(date);
    if (!prev) {
      byDate.set(date, bar);
      return;
    }
    byDate.set(date, {
      date,
      open: prev.open ?? bar.open,
      high: maxOf(prev.high, bar.high),
      low: minOf(prev.low, bar.low),
      close: bar.close ?? prev.close,
      volume: maxOf(prev.volume ?? null, bar.volume ?? null),
    });
  });
  const num = (k: string) => (typeof meta[k] === 'number' ? (meta[k] as number) : null);
  const time = num('regularMarketTime');
  const dividends: Dividend[] = Object.values(result.events?.dividends ?? {})
    .filter((d) => typeof d.amount === 'number' && d.amount > 0 && typeof d.date === 'number')
    .map((d) => ({ exDate: parisDateOf((d.date as number) * 1000), amount: Math.round((d.amount as number) * 10_000) / 10_000 }))
    .sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
  return {
    symbol: String(meta.symbol ?? ''),
    currency: typeof meta.currency === 'string' ? meta.currency : null,
    timezone: typeof meta.exchangeTimezoneName === 'string' ? meta.exchangeTimezoneName : null,
    bars: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    regularMarketPrice: clean(num('regularMarketPrice')),
    regularMarketTime: time === null ? null : time * 1000,
    previousClose: clean(num('previousClose') ?? num('chartPreviousClose')),
    dividends,
  };
}

function maxOf(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.max(a, b);
}

function minOf(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.min(a, b);
}
