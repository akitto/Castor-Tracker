import {
  addDays,
  candidateDates,
  CORE_VERSION,
  defaultBoardSlot,
  estimate,
  euronextHolidays,
  evaluateWindow,
  indexSessions,
  inferBoardDates,
  mostProbable,
  nextQuad,
  parisDateOf,
  prevQuad,
  quadPeriod,
  quadrimesterOf,
  randomSeed,
  replayEstimates,
  runBacktest,
  variantKey,
  type EstimateResult,
  type FormulaParams,
  type ISODate,
  type ParisClock,
  type PriceRow,
  type Reference,
  type YahooChart,
} from '../_shared/core/index.ts';
import {
  boardSpecOf,
  loadCalendar,
  loadConfig,
  loadMarket,
  must,
  num,
  toJson,
  type AppConfig,
  type Db,
  type Market,
  type QuadRow,
} from './db.ts';
import { errorMessage, HttpError } from './http.ts';
import {
  dailyChecks,
  dispatch,
  notifyAberrantOpen,
  notifyAmbiguousInference,
  notifyEstimateMove,
  notifyEstimatePhase,
  notifyFallback,
  notifyPriceAlerts,
  notifySpreads,
  pushKeys,
  pushMessage,
  pushToUser,
  safely,
  sendWebhook,
  type EstimateSummary,
  type EventPayload,
} from './notify.ts';
import { fetchEuronext, fetchYahoo } from './providers.ts';

export interface Caller {
  /** cron : secret système ; admin : JWT administrateur (TOTP) ; user : JWT d'un compte avec rôle. */
  trigger: 'cron' | 'admin' | 'user';
  userId: string | null;
}

export interface JobContext {
  db: Db;
  caller: Caller;
  body: Record<string, unknown>;
  clock: ParisClock;
  now: Date;
}

export interface JobResult {
  message: string;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TaskDef {
  /** Appelable avec le secret système (pg_cron, script de configuration) ; sinon JWT admin seulement. */
  cron: boolean;
  /** Comptes autorisés avec un JWT : admin (TOTP exigé, par défaut) ou user (tout compte ayant un rôle). */
  access?: 'admin' | 'user';
  /** Journalisée dans job_runs (par défaut oui). */
  log?: boolean;
  /** Envoie les notifications en attente après la tâche (par défaut oui). */
  dispatch?: boolean;
  /** Pour un appel planifié : raison de ne rien faire, ou null pour travailler. */
  gate?: (ctx: JobContext) => Promise<string | null>;
  run: (ctx: JobContext) => Promise<JobResult>;
}

// Fenêtres horaires, en minutes depuis minuit (heure de Paris).
const OPEN_FROM = 9 * 60 + 10;
const OPEN_UNTIL = 12 * 60;
const QUOTE_FROM = 9 * 60;
const QUOTE_UNTIL = 17 * 60 + 50;
const SESSION_FROM = 17 * 60 + 50;
const CATCHUP_FROM = 7 * 60;
const CATCHUP_UNTIL = 9 * 60 + 5;

const fr = (v: number, digits = 2) => v.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const hhmm = (minutes: number) => `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;

// ---------------------------------------------------------------------------
// Outils communs
// ---------------------------------------------------------------------------

async function lastRun(db: Db, job: string, status = 'success'): Promise<string | null> {
  const row = await must(
    db.from('job_runs').select('started_at').eq('job', job).eq('status', status).order('started_at', { ascending: false }).limit(1).maybeSingle(),
    'journal',
  );
  return (row as { started_at: string } | null)?.started_at ?? null;
}

async function succeededToday(ctx: JobContext, job: string): Promise<boolean> {
  const at = await lastRun(ctx.db, job);
  return at !== null && parisDateOf(Date.parse(at)) === ctx.clock.date;
}

async function sessionRow(db: Db, date: ISODate) {
  return (await must(
    db.from('stock_prices').select('trade_date, open, close, check_at').eq('trade_date', date).maybeSingle(),
    'séance',
  )) as { trade_date: ISODate; open: number | null; close: number | null; check_at: string | null } | null;
}

/** Barres terminées : séances passées, plus celle du jour après la clôture. */
function completedBars(bars: PriceRow[], clock: ParisClock): PriceRow[] {
  return bars.filter((b) => b.date < clock.date || (b.date === clock.date && clock.minutes >= SESSION_FROM));
}

async function storeBars(db: Db, bars: PriceRow[], source: string, mode: 'full' | 'open'): Promise<number> {
  if (bars.length === 0) return 0;
  const rows = bars.map((b) => ({
    date: b.date,
    open: b.open ?? null,
    high: b.high ?? null,
    low: b.low ?? null,
    close: b.close ?? null,
    vwap: b.vwap ?? null,
    volume: b.volume ?? null,
  }));
  let total = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const res = (await must(
      db.rpc('upsert_prices', { p_rows: rows.slice(i, i + 1000), p_source: source, p_mode: mode }),
      'écriture des cours',
    )) as { upserted?: number };
    total += res.upserted ?? 0;
  }
  return total;
}

async function storeDividends(db: Db, chart: YahooChart): Promise<number> {
  if (chart.dividends.length === 0) return 0;
  const rows = chart.dividends.map((d) => ({
    ex_date: d.exDate,
    amount: d.amount,
    kind: Number(d.exDate.slice(5, 7)) >= 9 ? 'acompte' : 'solde',
    source: 'yahoo',
  }));
  const res = await must(
    db.from('dividends').upsert(rows, { onConflict: 'ex_date', ignoreDuplicates: true }).select('ex_date'),
    'dividendes',
  );
  return (res as unknown[] | null)?.length ?? 0;
}

async function storeQuote(
  db: Db,
  chart: YahooChart,
): Promise<{ price: number; day: ISODate; prevClose: number | null; time: string } | null> {
  const price = chart.regularMarketPrice;
  if (!price) return null;
  const time = chart.regularMarketTime ?? Date.now();
  const day = parisDateOf(time);
  const dayBar = chart.bars.find((b) => b.date === day);
  const prevBar = [...chart.bars].reverse().find((b) => b.date < day && b.close);
  const prevClose = prevBar?.close ?? chart.previousClose ?? null;
  await must(
    db.from('quote_live').upsert({
      id: true,
      price,
      prev_close: prevClose,
      change_pct: prevClose ? Math.round((price / prevClose - 1) * 1e6) / 1e6 : null,
      day_open: dayBar?.open ?? null,
      quote_time: new Date(time).toISOString(),
      source: 'yahoo',
      fetched_at: new Date().toISOString(),
    }),
    'cours en séance',
  );
  return { price, day, prevClose, time: new Date(time).toISOString() };
}

/** Contrôle croisé Euronext : enregistre ses cours et liste les écarts au-delà du seuil. */
async function controlWithEuronext(
  db: Db,
  config: AppConfig,
  from: ISODate,
  to: ISODate,
): Promise<{ checked: number; spreads: { date: ISODate; field: string; ours: number; theirs: number; bps: number }[]; error?: string }> {
  let rows: PriceRow[];
  try {
    rows = await fetchEuronext(config.euronext_code, from, to, config.euronext_history_url);
  } catch (e) {
    return { checked: 0, spreads: [], error: (e as Error).message };
  }
  const res = (await must(
    db.rpc('upsert_prices', {
      p_rows: rows.map((r) => ({ date: r.date, open: r.open ?? null, close: r.close ?? null, vwap: r.vwap ?? null })),
      p_source: 'euronext',
      p_mode: 'control',
    }),
    'contrôle Euronext',
  )) as { updated?: number };
  const ours = (await must(
    db.from('stock_prices').select('trade_date, open, close').gte('trade_date', from).lte('trade_date', to),
    'cours contrôlés',
  )) as { trade_date: ISODate; open: number | null; close: number | null }[];
  const byDate = new Map(ours.map((o) => [o.trade_date, o]));
  const spreads: { date: ISODate; field: string; ours: number; theirs: number; bps: number }[] = [];
  for (const r of rows) {
    const o = byDate.get(r.date);
    if (!o) continue;
    for (const field of ['open', 'close'] as const) {
      const a = num(o[field]);
      const b = r[field] ?? null;
      if (a && b) {
        const bps = Math.round((Math.abs(b - a) / a) * 100_000) / 10;
        if (bps > config.alert_spread_bps) spreads.push({ date: r.date, field, ours: a, theirs: b, bps });
      }
    }
  }
  return { checked: res.updated ?? 0, spreads };
}

function formulaOf(market: Market): FormulaParams {
  const p = market.estimateParams;
  return {
    windowDays: p.windowDays,
    discountBps: p.discountBps,
    rounding: p.rounding,
    excludeBoardDay: p.excludeBoardDay,
    priceField: p.priceField,
  };
}

/** Recalcule au centime le prix des quadrimestres dont la date du CA est connue (EF-20, O5). */
async function refreshComputedPrices(db: Db, market: Market): Promise<number> {
  const index = indexSessions(market.sessions);
  const formula = formulaOf(market);
  let changed = 0;
  for (const q of market.quads) {
    let price: number | null = null;
    let missing: number | null = null;
    if (q.board_date) {
      const ev = evaluateWindow(index, market.calendar, q.board_date, formula);
      price = ev.price;
      missing = ev.missing.length;
    }
    if (price !== q.computed_price || missing !== q.computed_missing) {
      await must(
        db.from('quadrimesters')
          .update({ computed_price: price, computed_missing: missing, computed_at: new Date().toISOString() })
          .eq('code', q.code),
        'prix recalculé',
      );
      q.computed_price = price;
      q.computed_missing = missing;
      changed++;
    }
  }
  return changed;
}

function lastKnownPrice(market: Market, asOf: ISODate): { price: number; date: ISODate } | null {
  let best: { price: number; date: ISODate } | null = null;
  for (let i = market.sessions.length - 1; i >= 0; i--) {
    const s = market.sessions[i];
    if (s.date > asOf) continue;
    const v = s.close ?? s.open;
    if (v) {
      best = { price: v, date: s.date };
      break;
    }
  }
  if (market.quote) {
    const qDate = parisDateOf(Date.parse(market.quote.quote_time));
    if (qDate <= asOf && (!best || qDate >= best.date)) best = { price: Number(market.quote.price), date: qDate };
  }
  return best;
}

function referencePriceFor(market: Market, target: QuadRow, today: ISODate): number | null {
  const current = market.quads.find((q) => q.start_date <= today && q.end_date >= today);
  if (current?.official_price) return current.official_price;
  const previous = market.quads
    .filter((q) => q.start_date < target.start_date && q.official_price)
    .sort((a, b) => (a.start_date < b.start_date ? 1 : -1))[0];
  return previous?.official_price ?? null;
}

function estimateRow(
  code: string,
  kind: string,
  market: Market,
  r: EstimateResult,
  board: unknown,
  extra: Record<string, unknown> = {},
) {
  const probable = r.candidates.find((c) => c.date === r.mostProbableDate);
  const index = indexSessions(market.sessions);
  const windowDates = probable
    ? market.calendar.sessionsBetween(probable.windowStart, probable.windowEnd)
    : [];
  return {
    quadrimester_code: code,
    kind,
    as_of: r.asOf,
    last_price: r.lastPrice || null,
    last_price_date: r.lastPriceDate,
    params_id: market.params.id,
    seed: r.seed,
    n_sims: r.nSims,
    state: r.state,
    central: r.central,
    p05: r.p05,
    p25: r.p25,
    p75: r.p75,
    p95: r.p95,
    reliability: r.reliability,
    prob_below: r.probBelow,
    reference_price: r.referencePrice,
    known_sessions: r.knownMostProbable,
    known_min: r.knownMin,
    known_max: r.knownMax,
    most_probable_date: r.mostProbableDate,
    window_start: r.windowUnion.start,
    window_end: r.windowUnion.end,
    board: toJson(board),
    details: toJson({
      coreVersion: CORE_VERSION,
      candidates: r.candidates,
      warnings: r.warnings,
      sigmaDaily: r.sigmaDaily,
      returnsUsed: r.returnsUsed,
      simulated: r.simulatedSessions.length,
      deterministic: r.deterministic,
      window: windowDates.map((d) => {
        const v = d <= r.asOf ? index.get(d)?.[market.estimateParams.priceField] ?? null : null;
        return { date: d, value: v, known: d <= r.asOf && v !== null };
      }),
      ...extra,
    }),
  };
}

/** Estimation du prochain prix (ou d'un quadrimestre donné) et instantané en base. */
async function estimateAndStore(ctx: JobContext, market: Market, kind: 'scheduled' | 'manual', code?: string): Promise<JobResult> {
  const today = ctx.clock.date;
  const target = code
    ? market.quads.find((q) => q.code === code)
    : market.quads.filter((q) => q.start_date > today && q.official_price === null)[0];
  if (!target) {
    return { message: code ? `quadrimestre ${code} introuvable` : 'aucun quadrimestre à estimer (lancer la maintenance)' };
  }
  if (target.official_price !== null) {
    return { message: `${target.code} : prix officiel déjà connu (${fr(target.official_price)} €)` };
  }
  const board = boardSpecOf(target);
  const last = lastKnownPrice(market, today);
  if (!last) throw new Error('aucun cours en base : lancer d’abord la reprise de l’historique');
  const result = estimate({
    sessions: market.sessions,
    asOf: today,
    lastPrice: last.price,
    lastPriceDate: last.date,
    board,
    params: market.estimateParams,
    dividends: market.dividends,
    calendar: market.calendar,
    referencePrice: referencePriceFor(market, target, today),
    seed: randomSeed(),
  });
  const previous = (await must(
    ctx.db.from('estimates').select('state').eq('quadrimester_code', target.code).in('kind', ['scheduled', 'manual'])
      .order('computed_at', { ascending: false }).limit(1).maybeSingle(),
    'estimation précédente',
  )) as { state: string } | null;
  const row = await must(
    ctx.db.from('estimates').insert(estimateRow(target.code, kind, market, result, board)).select('id').single(),
    'enregistrement de l’estimation',
  );
  const summary: EstimateSummary = {
    estimateId: (row as { id: number }).id,
    code: target.code,
    state: result.state,
    central: result.central,
    p05: result.p05,
    p95: result.p95,
    reliability: result.reliability,
    known: result.knownMostProbable,
    windowDays: market.params.window_days,
  };
  await safely('phase', () => notifyEstimatePhase(ctx.db, previous?.state ?? null, summary));
  return {
    message: `${target.code} : ${fr(result.central)} € [${fr(result.p05)} – ${fr(result.p95)}], IF ${Math.round(result.reliability)}`,
    estimateId: summary.estimateId,
    summary,
    details: {
      code: target.code,
      state: result.state,
      central: result.central,
      p05: result.p05,
      p95: result.p95,
      reliability: result.reliability,
      known: result.knownMostProbable,
      warnings: result.warnings,
    },
  };
}

function missingSessions(market: Market, from: ISODate, to: ISODate): ISODate[] {
  const index = indexSessions(market.sessions);
  return market.calendar
    .sessionsBetween(from, to)
    .filter((d) => {
      const s = index.get(d);
      return !s || !s.open || !s.close;
    });
}

// ---------------------------------------------------------------------------
// Tâches
// ---------------------------------------------------------------------------

async function tradingGate(ctx: JobContext, from: number, until: number): Promise<string | null> {
  const { calendar } = await loadCalendar(ctx.db);
  if (!calendar.isTradingDay(ctx.clock.date)) return 'pas de séance aujourd’hui';
  if (ctx.clock.minutes < from || ctx.clock.minutes > until) {
    return `hors plage (${hhmm(ctx.clock.minutes)}, attendu ${hhmm(from)} – ${hhmm(until)})`;
  }
  return null;
}

const openTask: TaskDef = {
  cron: true,
  async gate(ctx) {
    const reason = await tradingGate(ctx, OPEN_FROM, OPEN_UNTIL);
    if (reason) return reason;
    const row = await sessionRow(ctx.db, ctx.clock.date);
    return row?.open ? 'ouverture du jour déjà en base' : null;
  },
  async run(ctx) {
    const config = await loadConfig(ctx.db);
    const chart = await fetchYahoo(config.yahoo_symbol, { range: '5d' });
    const today = chart.bars.find((b) => b.date === ctx.clock.date);
    await storeQuote(ctx.db, chart);
    await storeBars(ctx.db, completedBars(chart.bars, ctx.clock), 'yahoo', 'full');
    if (!today?.open) throw new Error('ouverture du jour pas encore publiée par Yahoo');
    await storeBars(ctx.db, [today], 'yahoo', 'open');
    const market = await loadMarket(ctx.db);
    await safely('ouverture', () => notifyAberrantOpen(ctx.db, market, ctx.clock.date));
    const est = await estimateAndStore(ctx, market, ctx.caller.trigger === 'cron' ? 'scheduled' : 'manual');
    return {
      message: `ouverture ${fr(today.open)} € ; ${est.message}`,
      details: { open: today.open, estimate: est.details },
    };
  },
};

const quoteTask: TaskDef = {
  cron: true,
  log: false,
  gate: (ctx) => tradingGate(ctx, QUOTE_FROM, QUOTE_UNTIL),
  async run(ctx) {
    const config = await loadConfig(ctx.db);
    const chart = await fetchYahoo(config.yahoo_symbol, { range: '5d' });
    const quote = await storeQuote(ctx.db, chart);
    // Filet de sécurité : ouverture du jour absente (tâche « open » en échec).
    const today = chart.bars.find((b) => b.date === ctx.clock.date);
    let estimateMessage: string | null = null;
    if (today?.open && ctx.clock.minutes >= OPEN_FROM) {
      const row = await sessionRow(ctx.db, ctx.clock.date);
      if (!row?.open) {
        await storeBars(ctx.db, [today], 'yahoo', 'open');
        const market = await loadMarket(ctx.db);
        estimateMessage = (await estimateAndStore(ctx, market, 'scheduled')).message;
      }
    }
    if (quote) await safely('alertes de cours', () => notifyPriceAlerts(ctx.db, quote));
    return {
      message: quote ? `cours ${fr(quote.price)} €` : 'cours indisponible',
      details: { quote, estimate: estimateMessage },
    };
  },
};

const sessionTask: TaskDef = {
  cron: true,
  async gate(ctx) {
    const reason = await tradingGate(ctx, SESSION_FROM, 23 * 60 + 59);
    if (reason) return reason;
    const row = await sessionRow(ctx.db, ctx.clock.date);
    if (row?.close && (await succeededToday(ctx, 'session'))) return 'séance du jour déjà complète';
    return null;
  },
  async run(ctx) {
    const config = await loadConfig(ctx.db);
    const warnings: string[] = [];
    let stored = 0;
    let dividends = 0;
    let quote: Awaited<ReturnType<typeof storeQuote>> = null;
    try {
      const chart = await fetchYahoo(config.yahoo_symbol, { range: '1mo' });
      stored = await storeBars(ctx.db, completedBars(chart.bars, ctx.clock), 'yahoo', 'full');
      dividends = await storeDividends(ctx.db, chart);
      quote = await storeQuote(ctx.db, chart);
    } catch (e) {
      warnings.push((e as Error).message);
      const rows = await fetchEuronext(config.euronext_code, addDays(ctx.clock.date, -30), ctx.clock.date, config.euronext_history_url);
      stored = await storeBars(ctx.db, completedBars(rows, ctx.clock), 'euronext', 'full');
      warnings.push(`repli sur Euronext : ${stored} séance(s)`);
      await safely('repli', () => notifyFallback(ctx.db, ctx.clock.date, errorMessage(e)));
    }
    const control = await controlWithEuronext(ctx.db, config, addDays(ctx.clock.date, -14), ctx.clock.date);
    if (control.error) warnings.push(`contrôle Euronext impossible : ${control.error}`);
    const market = await loadMarket(ctx.db);
    const todayRow = market.rows.find((r) => r.trade_date === ctx.clock.date);
    if (!todayRow?.close) throw new Error('clôture du jour absente des sources');
    const est = await estimateAndStore(ctx, market, ctx.caller.trigger === 'cron' ? 'scheduled' : 'manual');
    await refreshComputedPrices(ctx.db, market);
    await safely('séance', async () => {
      await notifySpreads(ctx.db, control.spreads);
      await notifyAberrantOpen(ctx.db, market, ctx.clock.date);
      if (est.summary) await notifyEstimateMove(ctx.db, est.summary as EstimateSummary);
      if (quote) await notifyPriceAlerts(ctx.db, quote);
    });
    const alert = control.spreads.length > 0 ? ` ; ÉCART de sources sur ${control.spreads.length} cours` : '';
    return {
      message: `séance du ${ctx.clock.date} : clôture ${fr(Number(todayRow.close))} €${alert} ; ${est.message}`,
      details: { stored, dividends, control, warnings, estimate: est.details },
    };
  },
};

const catchupTask: TaskDef = {
  cron: true,
  async gate(ctx) {
    if (ctx.clock.minutes < CATCHUP_FROM || ctx.clock.minutes > CATCHUP_UNTIL) {
      return `hors plage (${hhmm(ctx.clock.minutes)})`;
    }
    return (await succeededToday(ctx, 'catchup')) ? 'rattrapage déjà fait aujourd’hui' : null;
  },
  async run(ctx) {
    const config = await loadConfig(ctx.db);
    const days = Math.min(400, Math.max(5, Number(ctx.body.days ?? 30)));
    const from = addDays(ctx.clock.date, -days - 10);
    const warnings: string[] = [];
    let stored = 0;
    let dividends = 0;
    try {
      const chart = await fetchYahoo(config.yahoo_symbol, { from, to: ctx.clock.date });
      stored = await storeBars(ctx.db, completedBars(chart.bars, ctx.clock), 'yahoo', 'full');
      dividends = await storeDividends(ctx.db, chart);
      await storeQuote(ctx.db, chart);
    } catch (e) {
      warnings.push((e as Error).message);
      try {
        const rows = await fetchEuronext(config.euronext_code, from, ctx.clock.date, config.euronext_history_url);
        stored = await storeBars(ctx.db, completedBars(rows, ctx.clock), 'euronext', 'full');
        warnings.push(`repli sur Euronext : ${stored} séance(s)`);
      } catch (e2) {
        throw new Error(`aucune source disponible : ${warnings[0]} ; ${(e2 as Error).message}`);
      }
    }
    const control = await controlWithEuronext(ctx.db, config, from, ctx.clock.date);
    if (control.error) warnings.push(`contrôle Euronext impossible : ${control.error}`);
    const market = await loadMarket(ctx.db);
    const lastClosed = ctx.clock.minutes >= SESSION_FROM ? ctx.clock.date : addDays(ctx.clock.date, -1);
    const missing = missingSessions(market, addDays(ctx.clock.date, -days), lastClosed);
    await refreshComputedPrices(ctx.db, market);
    const est = await estimateAndStore(ctx, market, ctx.caller.trigger === 'cron' ? 'scheduled' : 'manual');
    await safely('rattrapage', async () => {
      await notifySpreads(ctx.db, control.spreads);
      await dailyChecks(ctx.db, market, ctx.clock.date, missing);
    });
    return {
      message: `${stored} séance(s) écrite(s), ${missing.length} manquante(s) sur ${days} jours ; ${est.message}`,
      details: { stored, dividends, missing, control, warnings },
    };
  },
};

const historyTask: TaskDef = {
  cron: true,
  async run(ctx) {
    const config = await loadConfig(ctx.db);
    const from = String(ctx.body.from ?? '2015-01-01');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new HttpError(400, 'date de début invalide');
    const chart = await fetchYahoo(config.yahoo_symbol, { from, to: ctx.clock.date });
    const bars = completedBars(chart.bars, ctx.clock);
    const stored = await storeBars(ctx.db, bars, 'yahoo', 'full');
    const dividends = await storeDividends(ctx.db, chart);
    await storeQuote(ctx.db, chart);
    const controlFrom = String(ctx.body.controlFrom ?? addDays(ctx.clock.date, -365));
    const control = await controlWithEuronext(ctx.db, config, controlFrom, ctx.clock.date);
    const market = await loadMarket(ctx.db);
    const recalculated = await refreshComputedPrices(ctx.db, market);
    return {
      message: `${stored} séance(s) depuis le ${from}, ${dividends} dividende(s) ajouté(s), ${recalculated} prix recalculé(s)`,
      details: {
        stored,
        first: bars[0]?.date ?? null,
        last: bars[bars.length - 1]?.date ?? null,
        dividends,
        control,
        missing: missingSessions(market, from, bars[bars.length - 1]?.date ?? from).slice(0, 200),
      },
    };
  },
};

const estimateTask: TaskDef = {
  cron: true,
  async run(ctx) {
    const market = await loadMarket(ctx.db);
    await refreshComputedPrices(ctx.db, market);
    const code = typeof ctx.body.code === 'string' ? ctx.body.code : undefined;
    return estimateAndStore(ctx, market, ctx.caller.trigger === 'cron' ? 'scheduled' : 'manual', code);
  },
};

function referencesOf(market: Market, statuses: QuadRow['board_status'][]): Reference[] {
  return market.quads
    .filter((q) => q.official_price && q.board_date && statuses.includes(q.board_status))
    .map((q) => ({ code: q.code, boardDate: q.board_date, officialPrice: q.official_price as number }));
}

const backtestTask: TaskDef = {
  cron: true,
  async run(ctx) {
    const market = await loadMarket(ctx.db);
    const references = referencesOf(market, ['known']);
    const report = runBacktest({
      sessions: market.sessions,
      references,
      calendar: market.calendar,
      base: formulaOf(market),
    });
    const active = variantKey(market.estimateParams);
    const summarize = (v: (typeof report.variants)[number]) => ({
      key: v.key,
      label: v.label,
      variant: v.variant,
      n: v.n,
      nExact: v.nExact,
      nMissing: v.nMissing,
      exactRate: v.exactRate,
      mae: v.mae,
      maxAbs: v.maxAbs,
      sigmaBps: v.sigmaBps,
    });
    const best = report.best;
    await must(
      ctx.db.from('backtests').insert({
        kind: 'formula',
        params: toJson({ references: references.length, windowDays: market.params.window_days, discountBps: market.params.discount_bps }),
        summary: toJson({
          active,
          best: best ? summarize(best) : null,
          exact: report.exact?.key ?? null,
          variants: report.variants.map(summarize),
        }),
        results: toJson({ variants: report.variants }),
        exact_rate: best?.exactRate ?? null,
        mae: best?.mae ?? null,
        run_by: ctx.caller.userId,
      }),
      'enregistrement du backtest',
    );
    await refreshComputedPrices(ctx.db, market);
    const message = references.length === 0
      ? 'aucun prix de référence avec date de CA connue'
      : report.exact
        ? `variante exacte : ${report.exact.label} (${report.exact.nExact}/${report.exact.n})${report.exact.key === active ? ', déjà active' : ''}`
        : `aucune variante exacte ; meilleure : ${best?.label ?? '—'} (${best?.nExact ?? 0}/${best?.n ?? 0}, écart moyen ${best?.mae === null || best?.mae === undefined ? '—' : fr(best.mae)} €)`;
    return { message, details: { references: references.length, active, exact: report.exact?.key ?? null } };
  },
};

function presumedDate(market: Market, q: QuadRow): ISODate {
  if (q.board_date) return q.board_date;
  const spec = q.board_slot_start && q.board_slot_end
    ? { mode: 'slot' as const, start: q.board_slot_start, end: q.board_slot_end }
    : { mode: 'slot' as const, ...defaultBoardSlot(q.code) };
  return mostProbable(candidateDates(market.calendar, spec)).date;
}

const inferTask: TaskDef = {
  cron: true,
  async run(ctx) {
    const market = await loadMarket(ctx.db);
    const apply = ctx.body.apply === true;
    const range = Math.min(120, Math.max(5, Number(ctx.body.rangeSessions ?? 60)));
    const targets = market.quads.filter((q) => q.official_price && q.board_status !== 'known');
    const formula = formulaOf(market);
    const results = targets.map((q) =>
      inferBoardDates({
        sessions: market.sessions,
        reference: { code: q.code, boardDate: null, officialPrice: q.official_price as number, presumedDate: presumedDate(market, q) },
        params: formula,
        calendar: market.calendar,
        rangeSessions: range,
      }),
    );
    let applied = 0;
    if (apply) {
      for (const r of results) {
        if (r.matches.length !== 1) continue;
        await must(
          ctx.db.from('quadrimesters').update({
            board_date: r.matches[0].date,
            board_status: 'inferred',
            board_source: `Inférence au centime (${ctx.clock.date})`,
          }).eq('code', r.code),
          'date inférée',
        );
        applied++;
      }
    }
    await must(
      ctx.db.from('backtests').insert({
        kind: 'inference',
        params: toJson({ rangeSessions: range, apply, formula }),
        summary: toJson({
          targets: results.length,
          unique: results.filter((r) => r.matches.length === 1).length,
          ambiguous: results.filter((r) => r.matches.length > 1).length,
          none: results.filter((r) => r.matches.length === 0).length,
          applied,
        }),
        results: toJson({ inferences: results }),
        run_by: ctx.caller.userId,
      }),
      'enregistrement de l’inférence',
    );
    if (applied > 0) await refreshComputedPrices(ctx.db, await loadMarket(ctx.db));
    await safely('inférence', () => notifyAmbiguousInference(ctx.db, results));
    return {
      message: results.length === 0
        ? 'aucun prix officiel sans date de CA connue'
        : `${results.filter((r) => r.matches.length === 1).length}/${results.length} date(s) retrouvée(s) sans ambiguïté${apply ? `, ${applied} appliquée(s)` : ''}`,
      details: { results: results.map((r) => ({ code: r.code, matches: r.matches.map((m) => m.date) })) },
    };
  },
};

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Budget de calcul du rejeu. Supabase Cloud coupe une fonction après 2 s de CPU par requête.
 * Coût mesuré d'un point rejoué : 0,9 ms fixes + 1,1 µs par tirage (24 quadrimestres × 60 jours × 1 000 tirages
 * = 2,8 s ; 720 points × 400 tirages = 0,95 s). On vise 0,6 s pour laisser la place au reste de la tâche.
 */
export const REPLAY_CPU_MS = 600;
const REPLAY_MIN_SIMS = 400;

export function replayCostMs(points: number, nSims: number): number {
  return points * (0.9 + nSims * 0.0011);
}

/** Ramène d'abord les tirages à 400, puis espace les jours rejoués, jusqu'à tenir dans le budget. */
export function fitReplayBudget(references: number, daysBefore: number, nSims: number, step: number) {
  const points = (s: number) => references * Math.ceil(daysBefore / s);
  let sims = nSims;
  let pace = step;
  if (replayCostMs(points(pace), sims) > REPLAY_CPU_MS) sims = Math.min(sims, REPLAY_MIN_SIMS);
  while (replayCostMs(points(pace), sims) > REPLAY_CPU_MS && pace < daysBefore) pace++;
  return { nSims: sims, step: pace, reduced: sims !== nSims || pace !== step };
}

const replayTask: TaskDef = {
  cron: true,
  async run(ctx) {
    const market = await loadMarket(ctx.db);
    const references = referencesOf(market, ['known', 'inferred']);
    const daysBefore = Math.min(120, Math.max(5, Number(ctx.body.daysBefore ?? 60)));
    const { nSims, step, reduced } = fitReplayBudget(
      references.length,
      daysBefore,
      Math.min(5000, Math.max(200, Number(ctx.body.nSims ?? 1000))),
      Math.min(10, Math.max(1, Number(ctx.body.step ?? 1))),
    );
    // RG-14 : couverture de l'intervalle à 90 %, de J−60 à J−1, date du CA connue.
    const report = replayEstimates({
      sessions: market.sessions,
      references,
      params: market.estimateParams,
      dividends: market.dividends,
      calendar: market.calendar,
      daysBefore,
      step,
      nSims,
      seed: 20_261_007,
    });
    await must(
      ctx.db.from('backtests').insert({
        kind: 'replay',
        params: toJson({ nSims, daysBefore, step }),
        summary: toJson({ coverage: report.coverage, n: report.n, buckets: report.buckets, skipped: report.skipped }),
        results: toJson({ points: report.points }),
        coverage: report.coverage,
        run_by: ctx.caller.userId,
      }),
      'enregistrement du rejeu',
    );
    // Historique : estimation telle qu'affichée à la fermeture des versements du quadrimestre
    // précédent, avec le créneau de CA par défaut (date inconnue à ce moment-là).
    const replayed: string[] = [];
    const skipped: string[] = [];
    for (const q of market.quads.filter((x) => x.official_price)) {
      const asOf = quadPeriod(prevQuad(q.code)).paymentClose;
      const last = lastKnownPrice({ ...market, quote: null }, asOf);
      if (!last || market.sessions.length === 0 || market.sessions[0].date > addDays(asOf, -400)) {
        skipped.push(`${q.code} : cours insuffisants avant le ${asOf}`);
        continue;
      }
      const slot = defaultBoardSlot(q.code);
      const board = { mode: 'slot' as const, start: slot.start, end: slot.end };
      try {
        const result = estimate({
          sessions: market.sessions,
          asOf,
          lastPrice: last.price,
          lastPriceDate: last.date,
          board,
          params: { ...market.estimateParams, nSims: Math.max(nSims, 2000) },
          dividends: market.dividends,
          calendar: market.calendar,
          referencePrice: market.quads.find((x) => x.code === prevQuad(q.code))?.official_price ?? null,
          seed: hashSeed(q.code),
        });
        await must(ctx.db.from('estimates').delete().eq('quadrimester_code', q.code).eq('kind', 'replay'), 'rejeu');
        await must(
          ctx.db.from('estimates').insert({
            ...estimateRow(q.code, 'replay', market, result, board, { replayOf: 'fermeture des versements précédents' }),
            computed_at: new Date().toISOString(),
          }),
          'rejeu',
        );
        replayed.push(q.code);
      } catch (e) {
        skipped.push(`${q.code} : ${(e as Error).message}`);
      }
    }
    const coverage = report.coverage === null ? '—' : `${fr(report.coverage * 100, 1)} %`;
    const pace = reduced ? ` (budget de calcul : ${nSims} tirages, un jour sur ${step})` : '';
    return {
      message: `couverture de l’intervalle à 90 % : ${coverage} sur ${report.n} points${pace} ; ${replayed.length} quadrimestre(s) rejoué(s)`,
      details: { coverage: report.coverage, buckets: report.buckets, replayed, skipped: [...report.skipped, ...skipped], nSims, step },
    };
  },
};

const maintenanceTask: TaskDef = {
  cron: true,
  async gate(ctx) {
    const at = await lastRun(ctx.db, 'maintenance');
    return at && parisDateOf(Date.parse(at)).slice(0, 7) === ctx.clock.date.slice(0, 7) ? 'maintenance déjà faite ce mois-ci' : null;
  },
  async run(ctx) {
    const year = Number(ctx.clock.date.slice(0, 4));
    const holidays = [year, year + 1].flatMap((y) =>
      euronextHolidays(y).map((h) => ({ day: h.date, label: h.label, half_day: false, source: 'standard' })),
    );
    const insertedHolidays = await must(
      ctx.db.from('market_holidays').upsert(holidays, { onConflict: 'day', ignoreDuplicates: true }).select('day'),
      'jours fériés',
    );
    const existing = new Set(
      ((await must(ctx.db.from('quadrimesters').select('code'), 'quadrimestres')) as { code: string }[]).map((q) => q.code),
    );
    const created: string[] = [];
    let code = quadrimesterOf(ctx.clock.date);
    for (let i = 0; i < 5; i++, code = nextQuad(code)) {
      if (existing.has(code)) continue;
      const p = quadPeriod(code);
      const slot = defaultBoardSlot(code);
      await must(
        ctx.db.from('quadrimesters').insert({
          code,
          start_date: p.start,
          end_date: p.end,
          payment_close_date: p.paymentClose,
          board_slot_start: slot.start,
          board_slot_end: slot.end,
          board_status: 'estimated',
          board_source: 'Créneau par défaut (maintenance)',
        }),
        'création de quadrimestre',
      );
      created.push(code);
    }
    const purgeBefore = new Date(ctx.now.getTime() - 180 * 86_400_000).toISOString();
    const purged = await must(
      ctx.db.from('job_runs').delete().lt('started_at', purgeBefore).neq('status', 'error').select('id'),
      'purge du journal',
    );
    const viewsBefore = new Date(ctx.now.getTime() - 400 * 86_400_000).toISOString();
    const purgedViews = await must(
      ctx.db.from('page_views').delete().lt('at', viewsBefore).select('id'),
      'purge de la fréquentation',
    );
    const purgedNotifications = await must(
      ctx.db.from('notification_events').delete()
        .lt('created_at', new Date(ctx.now.getTime() - 120 * 86_400_000).toISOString()).select('id'),
      'purge des notifications',
    );
    const market = await loadMarket(ctx.db);
    const recalculated = await refreshComputedPrices(ctx.db, market);
    return {
      message: `${created.length} quadrimestre(s) créé(s), ${(insertedHolidays as unknown[]).length} fermeture(s) ajoutée(s), ${(purged as unknown[]).length} entrée(s) de journal purgée(s)`,
      details: {
        created,
        recalculated,
        purgedPageViews: (purgedViews as unknown[]).length,
        purgedNotifications: (purgedNotifications as unknown[]).length,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Accès (invitations, rôles)
// ---------------------------------------------------------------------------

function requireRole(value: unknown): 'admin' | 'viewer' {
  if (value === 'admin' || value === 'viewer') return value;
  throw new HttpError(400, 'rôle attendu : admin ou viewer');
}

const usersTask: TaskDef = {
  cron: false,
  log: false,
  dispatch: false,
  async run(ctx) {
    const { data, error } = await ctx.db.auth.admin.listUsers({ page: 1, perPage: 500 });
    if (error) throw new Error(error.message);
    const roles = (await must(ctx.db.from('user_roles').select('user_id, role, created_at'), 'rôles')) as {
      user_id: string;
      role: string;
      created_at: string;
    }[];
    const byId = new Map(roles.map((r) => [r.user_id, r]));
    return {
      message: `${data.users.length} compte(s)`,
      users: data.users.map((u) => ({
        id: u.id,
        email: u.email,
        role: byId.get(u.id)?.role ?? null,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
        confirmed: Boolean(u.email_confirmed_at),
        mfa: (u.factors ?? []).some((f) => f.status === 'verified'),
      })),
    };
  },
};

const inviteTask: TaskDef = {
  cron: false,
  async run(ctx) {
    const email = String(ctx.body.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'adresse e-mail invalide');
    const role = requireRole(ctx.body.role ?? 'viewer');
    const config = await loadConfig(ctx.db);
    const redirectTo = config.site_url ?? undefined;
    let userId: string | null = null;
    let link: string | null = null;
    if (ctx.body.sendEmail === false) {
      const { data, error } = await ctx.db.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo } });
      if (error) {
        const retry = await ctx.db.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo } });
        if (retry.error) throw new Error(retry.error.message);
        userId = retry.data.user?.id ?? null;
        link = retry.data.properties?.action_link ?? null;
      } else {
        userId = data.user?.id ?? null;
        link = data.properties?.action_link ?? null;
      }
    } else {
      const { data, error } = await ctx.db.auth.admin.inviteUserByEmail(email, { redirectTo });
      if (error) throw new Error(`invitation impossible (${error.message}) : configurer le SMTP ou générer un lien`);
      userId = data.user?.id ?? null;
    }
    if (!userId) throw new Error('compte non créé');
    await must(
      ctx.db.from('user_roles').upsert({ user_id: userId, role, invited_by: ctx.caller.userId }, { onConflict: 'user_id' }),
      'rôle',
    );
    return { message: `${email} invité(e) comme ${role}`, userId, link, details: { email, role, link: Boolean(link) } };
  },
};

const setRoleTask: TaskDef = {
  cron: false,
  async run(ctx) {
    const userId = String(ctx.body.userId ?? '');
    if (!userId) throw new HttpError(400, 'utilisateur manquant');
    if (userId === ctx.caller.userId) throw new HttpError(400, 'impossible de modifier son propre rôle');
    if (ctx.body.role === null) {
      await must(ctx.db.from('user_roles').delete().eq('user_id', userId), 'retrait du rôle');
      return { message: 'accès retiré', details: { userId } };
    }
    const role = requireRole(ctx.body.role);
    await must(
      ctx.db.from('user_roles').upsert({ user_id: userId, role, invited_by: ctx.caller.userId }, { onConflict: 'user_id' }),
      'rôle',
    );
    return { message: `rôle ${role} attribué`, details: { userId, role } };
  },
};

const deleteUserTask: TaskDef = {
  cron: false,
  async run(ctx) {
    const userId = String(ctx.body.userId ?? '');
    if (!userId) throw new HttpError(400, 'utilisateur manquant');
    if (userId === ctx.caller.userId) throw new HttpError(400, 'impossible de supprimer son propre compte');
    const { error } = await ctx.db.auth.admin.deleteUser(userId);
    if (error) throw new Error(error.message);
    return { message: 'compte supprimé', details: { userId } };
  },
};

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const notifyTask: TaskDef = {
  cron: true,
  log: false,
  dispatch: false,
  async gate(ctx) {
    const due = await must(ctx.db.rpc('notification_due'), 'notifications en attente');
    return Number(due) > 0 ? null : 'aucune notification à envoyer';
  },
  async run(ctx) {
    const r = await dispatch(ctx.db);
    return {
      message: `${r.sent} envoyée(s), ${r.retried} à relancer, ${r.failed} en échec, ${r.skipped} sans destination`,
      details: { ...r },
    };
  },
};

const pushKeyTask: TaskDef = {
  cron: false,
  access: 'user',
  log: false,
  dispatch: false,
  async run(ctx) {
    const keys = await pushKeys(ctx.db);
    // Adresse de la PWA encore inconnue (installation Supabase Cloud sans script) : celle de la page qui s'abonne.
    // Elle sert d'identifiant VAPID et de base aux liens des webhooks.
    const origin = typeof ctx.body.origin === 'string' ? ctx.body.origin.replace(/\/+$/, '') : '';
    if (/^https:\/\/[^/\s]+$/.test(origin)) {
      await ctx.db.from('app_config').update({ site_url: origin }).eq('id', true).is('site_url', null);
    }
    return { message: 'clé publique VAPID', publicKey: keys.publicKey };
  },
};

function testEvent(title: string, body: string): EventPayload {
  return { id: 0, type: 'test', title, body, url: '/compte/notifications', urgent: false, data: {}, created_at: new Date().toISOString() };
}

const pushTestTask: TaskDef = {
  cron: false,
  access: 'user',
  log: false,
  dispatch: false,
  async run(ctx) {
    let q = ctx.db.from('push_subscriptions').select('id, user_id, endpoint, p256dh, auth').eq('user_id', ctx.caller.userId as string);
    if (typeof ctx.body.endpoint === 'string') q = q.eq('endpoint', ctx.body.endpoint);
    const subs = (await must(q, 'abonnements')) as { id: number; user_id: string; endpoint: string; p256dh: string; auth: string }[];
    if (subs.length === 0) throw new HttpError(400, 'aucun appareil abonné : activer d’abord les notifications sur cet appareil');
    const [keys, config] = await Promise.all([pushKeys(ctx.db), loadConfig(ctx.db)]);
    const ev = testEvent('Castor Tracker : notification de test', 'Les notifications arrivent bien sur cet appareil.');
    const r = await pushToUser(ctx.db, subs, pushMessage({ ...ev, id: Date.now() }), keys, config, false);
    const okCount = r.results.filter((x) => x.ok).length;
    return {
      message: okCount > 0
        ? `notification envoyée à ${okCount} appareil(s) sur ${r.results.length}`
        : `échec de l’envoi : ${r.results.map((x) => x.error).join(' ; ')}`,
      ok: okCount > 0,
      results: r.results,
    };
  },
};

const webhookTestTask: TaskDef = {
  cron: false,
  log: false,
  dispatch: false,
  async run(ctx) {
    let target = ctx.body.url
      ? {
        webhook_url: String(ctx.body.url),
        webhook_format: String(ctx.body.format ?? 'json'),
        webhook_secret: typeof ctx.body.secret === 'string' && ctx.body.secret ? ctx.body.secret : null,
      }
      : null;
    if (!target) {
      const saved = await must(
        ctx.db.from('notification_settings').select('webhook_url, webhook_format, webhook_secret').eq('user_id', ctx.caller.userId as string).maybeSingle(),
        'webhook',
      ) as { webhook_url: string | null; webhook_format: string; webhook_secret: string | null } | null;
      if (!saved?.webhook_url) throw new HttpError(400, 'aucun webhook enregistré');
      target = { webhook_url: saved.webhook_url, webhook_format: saved.webhook_format, webhook_secret: saved.webhook_secret };
    }
    if (!/^https?:\/\//.test(target.webhook_url)) throw new HttpError(400, 'URL de webhook invalide');
    if (!['json', 'ntfy', 'discord', 'slack'].includes(target.webhook_format)) throw new HttpError(400, 'format de webhook inconnu');
    const config = await loadConfig(ctx.db);
    const r = await sendWebhook(target, testEvent('Castor Tracker : test du webhook', 'Le webhook des administrateurs fonctionne.'), config);
    return { message: r.ok ? `webhook joint (HTTP ${r.status})` : `échec du webhook : ${r.error}`, ok: r.ok, status: r.status };
  },
};

export const TASKS: Record<string, TaskDef> = {
  open: openTask,
  quote: quoteTask,
  session: sessionTask,
  catchup: catchupTask,
  history: historyTask,
  estimate: estimateTask,
  backtest: backtestTask,
  infer: inferTask,
  replay: replayTask,
  maintenance: maintenanceTask,
  users: usersTask,
  invite: inviteTask,
  'set-role': setRoleTask,
  'delete-user': deleteUserTask,
  notify: notifyTask,
  'push-key': pushKeyTask,
  'push-test': pushTestTask,
  'webhook-test': webhookTestTask,
};
