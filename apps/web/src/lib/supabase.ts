import { createClient } from '@supabase/supabase-js';
import type { Database } from '@castor/core';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config';

export const supabase = createClient<Database>(SUPABASE_URL || 'http://localhost', SUPABASE_ANON_KEY || 'absent', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export type Tables = Database['public']['Tables'];
export type Views = Database['public']['Views'];
export type QuadrimesterRow = Tables['quadrimesters']['Row'];
export type EstimateRow = Tables['estimates']['Row'];
export type ParamsRow = Tables['calc_params']['Row'];
export type DividendRow = Tables['dividends']['Row'];
export type HolidayRow = Tables['market_holidays']['Row'];
export type StockPriceRow = Tables['stock_prices']['Row'];
export type JobRunRow = Tables['job_runs']['Row'];
export type AuditRow = Tables['audit_log']['Row'];
export type BacktestRow = Tables['backtests']['Row'];
export type AppConfigRow = Tables['app_config']['Row'];
export type DashboardRow = Views['v_dashboard']['Row'];
export type HistoryRow = Views['v_history']['Row'];
export type EstimateHistoryRow = Views['v_estimate_history']['Row'];
export type JobStatusRow = Views['v_job_status']['Row'];

/** Lève une erreur lisible si la requête a échoué. */
export function unwrap<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

export interface JobResponse {
  task: string;
  message?: string;
  error?: string;
  skipped?: string;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Appel de l'Edge Function castor-jobs (rôle admin et TOTP vérifiés côté serveur). */
export async function runJob(task: string, body: Record<string, unknown> = {}): Promise<JobResponse> {
  const { data, error } = await supabase.functions.invoke<JobResponse>('castor-jobs', { body: { task, ...body } });
  if (error) {
    let message = error.message;
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const payload = (await ctx.json()) as JobResponse;
        if (payload?.error) message = payload.error;
      } catch {
        /* réponse non JSON */
      }
    }
    throw new Error(message);
  }
  if (!data) throw new Error('réponse vide de castor-jobs');
  if (data.error) throw new Error(data.error);
  return data;
}
