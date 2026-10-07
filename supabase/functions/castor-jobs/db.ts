import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.117.2';
import {
  DEFAULT_ESTIMATE,
  defaultBoardSlot,
  TradingCalendar,
  type BoardSpec,
  type Database,
  type Dividend,
  type Json,
  type EstimateParams,
  type ISODate,
  type Rounding,
  type PriceField,
  type Session,
} from '../_shared/core/index.ts';

export type Db = SupabaseClient<Database>;

export function serviceClient(): Db {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY absent de l’environnement des fonctions');
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

type Result<T> = { data: T | null; error: { message: string } | null };

/** Exécute une requête et lève une erreur lisible en cas d'échec. */
// deno-lint-ignore no-explicit-any
export async function must<T = any>(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string,
): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(`${label} : ${error.message}`);
  return data as T;
}

/** Lecture paginée (indépendante de la limite max-rows de PostgREST). */
export async function selectAll<T>(
  page: (from: number, to: number) => PromiseLike<Result<T[]>>,
  label: string,
  size = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw new Error(`${label} : ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    from += data.length;
  }
  return out;
}

export interface AppConfig {
  visibility: 'public' | 'restricted' | 'private';
  admin_mfa_required: boolean;
  site_url: string | null;
  yahoo_symbol: string;
  euronext_code: string;
  euronext_history_url: string | null;
  alert_spread_bps: number;
}

export interface ParamsRow {
  id: number;
  label: string;
  window_days: number;
  discount_bps: number;
  price_field: PriceField;
  rounding: Rounding;
  exclude_board_day: boolean;
  tolerance_bps: number;
  n_sims: number;
  bootstrap_days: number;
  model_sigma_bps: number;
}

export interface QuadRow {
  code: string;
  start_date: ISODate;
  end_date: ISODate;
  payment_close_date: ISODate;
  board_date: ISODate | null;
  board_slot_start: ISODate | null;
  board_slot_end: ISODate | null;
  board_weights: Record<string, number> | null;
  board_status: 'estimated' | 'known' | 'inferred';
  official_price: number | null;
  computed_price: number | null;
  computed_missing: number | null;
}

export interface QuoteRow {
  price: number;
  prev_close: number | null;
  day_open: number | null;
  quote_time: string;
  source: string;
}

export interface PriceRowDb {
  trade_date: ISODate;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  vwap: number | null;
  volume: number | null;
  is_manual: boolean;
  check_open: number | null;
  check_close: number | null;
  check_at: string | null;
}

export interface Market {
  config: AppConfig;
  params: ParamsRow;
  estimateParams: EstimateParams;
  calendar: TradingCalendar;
  closures: ISODate[];
  rows: PriceRowDb[];
  sessions: Session[];
  dividends: Dividend[];
  quads: QuadRow[];
  quote: QuoteRow | null;
}

export async function loadConfig(db: Db): Promise<AppConfig> {
  const cfg = await must(db.from('app_config').select('*').maybeSingle(), 'réglages');
  if (!cfg) throw new Error('réglages absents (table app_config vide)');
  return cfg as AppConfig;
}

export async function loadCalendar(db: Db): Promise<{ calendar: TradingCalendar; closures: ISODate[] }> {
  const rows = await must(db.from('market_holidays').select('day, half_day'), 'jours fériés');
  const closures = (rows as { day: ISODate; half_day: boolean }[]).filter((r) => !r.half_day).map((r) => r.day);
  return { calendar: new TradingCalendar(closures), closures };
}

export function toEstimateParams(p: ParamsRow): EstimateParams {
  return {
    ...DEFAULT_ESTIMATE,
    windowDays: p.window_days,
    discountBps: p.discount_bps,
    priceField: p.price_field,
    rounding: p.rounding,
    excludeBoardDay: p.exclude_board_day,
    toleranceBps: p.tolerance_bps,
    nSims: p.n_sims,
    bootstrapDays: p.bootstrap_days,
    modelSigmaBps: Number(p.model_sigma_bps),
  };
}

export async function loadMarket(db: Db): Promise<Market> {
  const [config, paramsRow, cal, rows, dividends, quads, quote] = await Promise.all([
    loadConfig(db),
    must(db.from('calc_params').select('*').eq('active', true).maybeSingle(), 'paramètres actifs'),
    loadCalendar(db),
    selectAll<PriceRowDb>(
      (from, to) =>
        db
          .from('stock_prices')
          .select('trade_date, open, high, low, close, vwap, volume, is_manual, check_open, check_close, check_at')
          .order('trade_date')
          .range(from, to),
      'cours',
    ),
    must(db.from('dividends').select('ex_date, amount').order('ex_date'), 'dividendes'),
    must(db.from('quadrimesters').select('*').order('start_date'), 'quadrimestres'),
    must(db.from('quote_live').select('*').maybeSingle(), 'cours en séance'),
  ]);
  if (!paramsRow) throw new Error('aucune version de paramètres active');
  const params = paramsRow as ParamsRow;
  return {
    config,
    params,
    estimateParams: toEstimateParams(params),
    calendar: cal.calendar,
    closures: cal.closures,
    rows,
    sessions: rows.map((r) => ({
      date: r.trade_date,
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      close: num(r.close),
      vwap: num(r.vwap),
    })),
    dividends: (dividends as { ex_date: ISODate; amount: number }[]).map((d) => ({
      exDate: d.ex_date,
      amount: Number(d.amount),
    })),
    quads: (quads as QuadRow[]).map((q) => ({
      ...q,
      official_price: num(q.official_price),
      computed_price: num(q.computed_price),
    })),
    quote: quote ? ({ ...(quote as QuoteRow), price: Number((quote as QuoteRow).price) } as QuoteRow) : null,
  };
}

/** Valeur sérialisable en jsonb (supprime undefined, NaN → null). */
export function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Date ou créneau du CA d'un quadrimestre (créneau par défaut si rien n'est saisi). */
export function boardSpecOf(q: QuadRow): BoardSpec {
  if (q.board_date) return { mode: 'date', date: q.board_date };
  if (q.board_slot_start && q.board_slot_end) {
    return { mode: 'slot', start: q.board_slot_start, end: q.board_slot_end, weights: q.board_weights };
  }
  const slot = defaultBoardSlot(q.code);
  return { mode: 'slot', start: slot.start, end: slot.end };
}
