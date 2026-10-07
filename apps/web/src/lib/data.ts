import {
  TradingCalendar,
  type CandidateDetail,
  type Dividend,
  type EstimateParams,
  type ISODate,
  type Session,
  DEFAULT_ESTIMATE,
} from '@castor/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { supabase, unwrap, type DashboardRow, type ParamsRow } from './supabase';

const FIVE_MIN = 5 * 60_000;

export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    refetchInterval: FIVE_MIN,
    queryFn: async () => unwrap(await supabase.from('v_dashboard').select('*').maybeSingle()),
  });
}

export function useHistory() {
  return useQuery({
    queryKey: ['history'],
    refetchInterval: FIVE_MIN,
    queryFn: async () => unwrap(await supabase.from('v_history').select('*').order('start_date', { ascending: false })),
  });
}

/** Série complète [date, ouverture, clôture], en une seule valeur JSON (RPC en GET, cachable). */
export function usePriceSeries() {
  return useQuery({
    queryKey: ['series'],
    staleTime: FIVE_MIN,
    refetchInterval: 15 * 60_000,
    queryFn: async () => {
      const raw = unwrap(await supabase.rpc('price_series', {}, { get: true })) as unknown as [string, number | null, number | null][];
      return raw.map(([date, open, close]): Session => ({ date, open, close }));
    },
  });
}

export function useEstimateHistory(code: string | null | undefined) {
  return useQuery({
    queryKey: ['estimate-history', code],
    enabled: Boolean(code),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('v_estimate_history')
          .select('*')
          .eq('quadrimester_code', code as string)
          .order('day'),
      ),
  });
}

export function useClosures() {
  return useQuery({
    queryKey: ['holidays'],
    staleTime: 60 * 60_000,
    queryFn: async () => unwrap(await supabase.from('market_holidays').select('*').order('day')),
  });
}

export function useDividends() {
  return useQuery({
    queryKey: ['dividends'],
    staleTime: 60 * 60_000,
    queryFn: async () => unwrap(await supabase.from('dividends').select('*').order('ex_date')),
  });
}

export function useActiveParams() {
  return useQuery({
    queryKey: ['params', 'active'],
    staleTime: FIVE_MIN,
    queryFn: async () => unwrap(await supabase.from('calc_params').select('*').eq('active', true).maybeSingle()),
  });
}

export function useLatestBacktest(kind: 'formula' | 'inference' | 'replay') {
  return useQuery({
    queryKey: ['backtest', kind],
    queryFn: async () =>
      unwrap(
        await supabase.from('backtests').select('*').eq('kind', kind).order('run_at', { ascending: false }).limit(1).maybeSingle(),
      ),
  });
}

/** Calendrier Euronext avec les fermetures saisies en base. */
export function useCalendar(): TradingCalendar {
  const { data } = useClosures();
  return useMemo(() => new TradingCalendar((data ?? []).filter((h) => !h.half_day).map((h) => h.day)), [data]);
}

export function useDividendList(): Dividend[] {
  const { data } = useDividends();
  return useMemo(() => (data ?? []).map((d) => ({ exDate: d.ex_date, amount: Number(d.amount) })), [data]);
}

export function toEstimateParams(p: ParamsRow | null | undefined): EstimateParams {
  if (!p) return DEFAULT_ESTIMATE;
  return {
    windowDays: p.window_days,
    discountBps: p.discount_bps,
    priceField: p.price_field as EstimateParams['priceField'],
    rounding: p.rounding as EstimateParams['rounding'],
    excludeBoardDay: p.exclude_board_day,
    toleranceBps: p.tolerance_bps,
    nSims: p.n_sims,
    bootstrapDays: p.bootstrap_days,
    modelSigmaBps: Number(p.model_sigma_bps),
  };
}

export interface EstimateDetails {
  candidates?: CandidateDetail[];
  warnings?: string[];
  window?: { date: ISODate; value: number | null; known: boolean }[];
  sigmaDaily?: number;
  returnsUsed?: number;
  simulated?: number;
  deterministic?: boolean;
}

export function detailsOf(row: Pick<DashboardRow, 'details'> | null | undefined): EstimateDetails {
  const d = row?.details;
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as unknown as EstimateDetails) : {};
}

export const FIELD_LABEL: Record<string, { one: string; many: string }> = {
  open: { one: 'ouverture', many: 'ouvertures' },
  close: { one: 'clôture', many: 'clôtures' },
  vwap: { one: 'VWAP', many: 'VWAP' },
};

export function formulaText(p: EstimateParams): string {
  const factor = ((10_000 - p.discountBps) / 10_000).toLocaleString('fr-FR', { maximumFractionDigits: 4 });
  return `${factor} × moyenne des ${p.windowDays} ${FIELD_LABEL[p.priceField]?.many ?? p.priceField} avant le CA`;
}
