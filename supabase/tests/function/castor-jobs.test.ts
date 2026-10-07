// Test de bout en bout de castor-jobs : vraie base (migrations), doublure PostgREST/GoTrue
// (fake-supabase.mjs), sources de cours simulées. Lancé par scripts/test-db.sh (RUN_FUNCTIONS=1).
import {
  addDays,
  evaluateWindow,
  indexSessions,
  mulberry32,
  normal,
  parisClock,
  TradingCalendar,
  DEFAULT_FORMULA,
  type ISODate,
  type Session,
} from '../../functions/_shared/core/index.ts';
import { handle } from '../../functions/castor-jobs/handler.ts';
import { serviceClient } from '../../functions/castor-jobs/db.ts';
import { TASKS, type JobContext } from '../../functions/castor-jobs/tasks.ts';

const ADMIN = '00000000-0000-0000-0000-00000000000a';
const VIEWER = '00000000-0000-0000-0000-00000000000b';
const CRON_SECRET = Deno.env.get('CASTOR_TEST_CRON_SECRET') ?? '';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ÉCHEC : ${message}`);
}

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}.signature`;
}

// --- Données simulées --------------------------------------------------------
const calendar = new TradingCalendar();
const today = parisClock().date;
const lastSession = calendar.isTradingDay(today) ? today : calendar.previousSession(today);
const rand = mulberry32(2026);
let price = 52;
const sessions: (Session & { volume: number })[] = calendar.sessionsBetween('2015-01-02', lastSession).map((date) => {
  const open = Math.round(price * Math.exp(0.006 * normal(rand)) * 100) / 100;
  const close = Math.round(open * Math.exp(0.01 * normal(rand)) * 100) / 100;
  price = close;
  return { date, open, close, high: Math.max(open, close) + 0.3, low: Math.min(open, close) - 0.3, volume: 500_000 };
});
const byDate = indexSessions(sessions);

function yahooChart(from: ISODate, to: ISODate) {
  const bars = sessions.filter((s) => s.date >= from && s.date <= to);
  const ts = (d: ISODate) => Date.parse(`${d}T07:00:00Z`) / 1000;
  const last = bars[bars.length - 1];
  const dividends: Record<string, { amount: number; date: number }> = {};
  for (let y = 2015; y <= 2026; y++) {
    for (const [d, amount] of [[`${y}-04-23`, 2.5], [`${y}-11-12`, 1.0]] as const) {
      if (d >= from && d <= to && calendar.isTradingDay(d)) dividends[String(ts(d))] = { amount, date: ts(d) };
    }
  }
  return {
    chart: {
      error: null,
      result: [{
        meta: {
          symbol: 'DG.PA',
          currency: 'EUR',
          exchangeTimezoneName: 'Europe/Paris',
          regularMarketPrice: last?.close,
          regularMarketTime: Math.floor(Date.now() / 1000),
        },
        timestamp: bars.map((b) => ts(b.date)),
        indicators: {
          quote: [{
            open: bars.map((b) => b.open),
            high: bars.map((b) => b.high),
            low: bars.map((b) => b.low),
            close: bars.map((b) => b.close),
            volume: bars.map((b) => b.volume),
          }],
        },
        events: { dividends },
      }],
    },
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname.endsWith('finance.yahoo.com')) {
    const range = url.searchParams.get('range');
    const from = range
      ? calendar.sessionsBefore(addDays(lastSession, 1), range === '5d' ? 5 : 22)[0]
      : new Date(Number(url.searchParams.get('period1')) * 1000).toISOString().slice(0, 10);
    const to = range ? lastSession : new Date(Number(url.searchParams.get('period2')) * 1000).toISOString().slice(0, 10);
    return Promise.resolve(Response.json(yahooChart(from, to)));
  }
  if (url.hostname === 'live.euronext.com') {
    const from = url.searchParams.get('startdate') ?? '2015-01-01';
    const to = url.searchParams.get('enddate') ?? lastSession;
    const lines = ['"Historical Data"', 'Date;Open;High;Low;Last;Close;Number of Shares;Number of Trades;Turnover;VWAP'];
    for (const s of sessions.filter((x) => x.date >= from && x.date <= to)) {
      // une ouverture divergente de 1 % pour vérifier l'alerte d'écart
      const open = s.date === calendar.previousSession(lastSession) ? (s.open as number) * 1.01 : s.open;
      const [y, m, d] = s.date.split('-');
      lines.push(`${d}/${m}/${y};${open};${s.high};${s.low};${s.close};${s.close};${s.volume};1000;0;${s.close}`);
    }
    return Promise.resolve(new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/csv' } }));
  }
  return realFetch(input, init);
};

// --- Outils --------------------------------------------------------------------
async function call(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await handle(
    new Request('http://localhost/castor-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

const adminHeaders = { Authorization: `Bearer ${jwt({ sub: ADMIN, role: 'authenticated', aal: 'aal2' })}` };
const db = serviceClient();

function ctxAt(date: ISODate, minutes: number, body: Record<string, unknown> = {}): JobContext {
  return { db, caller: { trigger: 'admin', userId: ADMIN }, body, clock: { date, minutes }, now: new Date() };
}

// --- Tests ---------------------------------------------------------------------
Deno.test('authentification et routage', async () => {
  assert((await call({ task: 'estimate' })).status === 401, 'sans jeton : 401');
  assert((await call({ task: 'inconnue' }, adminHeaders)).status === 400, 'tâche inconnue : 400');
  const viewer = await call({ task: 'estimate' }, { Authorization: `Bearer ${jwt({ sub: VIEWER, role: 'authenticated', aal: 'aal2' })}` });
  assert(viewer.status === 403, 'viewer : 403');
  const aal1 = await call({ task: 'estimate' }, { Authorization: `Bearer ${jwt({ sub: ADMIN, role: 'authenticated', aal: 'aal1' })}` });
  assert(aal1.status === 403 && String(aal1.body.error).includes('TOTP'), 'admin sans TOTP : 403');
  assert((await call({ task: 'open' }, { 'x-castor-cron': 'mauvais-secret-de-trente-caracteres' })).status === 401, 'secret faux : 401');
  const cronInvite = await call({ task: 'invite', email: 'x@example.org' }, { 'x-castor-cron': CRON_SECRET });
  assert(cronInvite.status === 403, 'gestion des accès refusée au secret système');
  const health = await handle(new Request('http://localhost/castor-jobs'));
  assert(health.status === 200, 'GET : santé');
  const options = await handle(new Request('http://localhost/castor-jobs', { method: 'OPTIONS' }));
  assert(options.headers.get('Access-Control-Allow-Origin') === '*', 'CORS');
});

Deno.test('reprise de l’historique, recalcul et estimation', async () => {
  const history = await call({ task: 'history', from: '2015-01-01' }, adminHeaders);
  assert(history.status === 200, `historique : ${JSON.stringify(history.body)}`);
  const { count } = await db.from('stock_prices').select('trade_date', { count: 'exact', head: true });
  assert((count ?? 0) >= sessions.length - 1, `séances en base : ${count}`);
  const divs = await db.from('dividends').select('ex_date');
  assert((divs.data?.length ?? 0) > 10, 'dividendes Yahoo enregistrés');
  assert(history.body.details.control.checked > 0, 'contrôle Euronext');

  // Prix « officiels » fabriqués avec la formule des avis sur les cours simulés.
  for (const [code, board] of [['2022/1', '2021-10-20'], ['2024/3', '2024-06-13'], ['2026/1', '2025-10-15'], ['2026/2', '2026-02-05'], ['2026/3', '2026-06-23']]) {
    const p = evaluateWindow(byDate, calendar, board, DEFAULT_FORMULA).price;
    await db.from('quadrimesters').update({ official_price: p }).eq('code', code);
  }
  const est = await call({ task: 'estimate' }, adminHeaders);
  assert(est.status === 200 && est.body.message.startsWith('2027/1'), `estimation : ${JSON.stringify(est.body)}`);
  const row = await db.from('estimates').select('*').eq('quadrimester_code', '2027/1').order('computed_at', { ascending: false }).limit(1).single();
  assert(row.data && row.data.p05 <= row.data.central && row.data.central <= row.data.p95, 'estimation cohérente');
  assert(row.data.kind === 'manual' && row.data.params_id !== null && row.data.seed !== null, 'traçabilité (ENF-06)');
  const computed = await db.from('quadrimesters').select('code, computed_price, official_price').eq('code', '2026/1').single();
  assert(computed.data?.computed_price === computed.data?.official_price, 'prix recalculé = prix officiel');
});

Deno.test('backtest, inférence et rejeu', async () => {
  const bt = await call({ task: 'backtest' }, adminHeaders);
  assert(bt.status === 200 && bt.body.message.includes('variante exacte : ouverture, centime au plus proche, jour du CA exclu (5/5)'),
    `backtest : ${bt.body.message}`);
  await db.from('quadrimesters').update({ board_date: null, board_status: 'estimated' }).eq('code', '2024/3');
  // ±60 séances : avec ces cours simulés, deux dates donnent le même prix → rien n'est appliqué.
  const wide = await call({ task: 'infer', apply: true }, adminHeaders);
  assert(wide.status === 200 && wide.body.details.results[0].matches.includes('2024-06-13'), `inférence large : ${JSON.stringify(wide.body)}`);
  const ambiguous = wide.body.details.results[0].matches.length > 1;
  const still = await db.from('quadrimesters').select('board_date').eq('code', '2024/3').single();
  assert(!ambiguous || still.data?.board_date === null, 'date ambiguë non appliquée');
  const inf = await call({ task: 'infer', apply: true, rangeSessions: 10 }, adminHeaders);
  assert(inf.status === 200, `inférence : ${JSON.stringify(inf.body)}`);
  const q = await db.from('quadrimesters').select('board_date, board_status').eq('code', '2024/3').single();
  assert(q.data?.board_date === '2024-06-13' && q.data?.board_status === 'inferred', `date inférée : ${JSON.stringify(q.data)}`);
  const rp = await call({ task: 'replay', nSims: 300, daysBefore: 30, step: 5 }, adminHeaders);
  assert(rp.status === 200 && rp.body.details.replayed.length === 5, `rejeu : ${JSON.stringify(rp.body)}`);
  assert(rp.body.details.coverage > 0.5, `couverture : ${rp.body.details.coverage}`);
  const hist = await db.from('estimates').select('quadrimester_code, state').eq('kind', 'replay');
  assert(hist.data?.length === 5 && hist.data.every((h) => h.state === 'frozen'), 'historique rejoué à la fermeture des versements');
});

Deno.test('ouverture, séance, rattrapage avec une horloge simulée', async () => {
  await db.from('stock_prices').delete().eq('trade_date', lastSession);
  const gateBefore = await TASKS.open.gate!(ctxAt(lastSession, 8 * 60 + 20));
  assert(gateBefore?.includes('hors plage'), `porte avant 9 h 10 : ${gateBefore}`);
  assert((await TASKS.open.gate!(ctxAt(lastSession, 9 * 60 + 20))) === null, 'porte ouverte à 9 h 20');
  const open = await TASKS.open.run(ctxAt(lastSession, 9 * 60 + 20));
  assert(open.message.startsWith('ouverture'), `ouverture : ${open.message}`);
  const row = await db.from('stock_prices').select('open, close').eq('trade_date', lastSession).single();
  assert(row.data?.open === byDate.get(lastSession)?.open && row.data?.close === null, 'ouverture seule en base');
  assert((await TASKS.open.gate!(ctxAt(lastSession, 9 * 60 + 40))) === 'ouverture du jour déjà en base', 'relance de 9 h 40 inutile');
  const session = await TASKS.session.run(ctxAt(lastSession, 18 * 60));
  assert(session.message.includes('ÉCART de sources'), `alerte d’écart : ${session.message}`);
  const full = await db.from('stock_prices').select('close, check_open').eq('trade_date', lastSession).single();
  assert(full.data?.close === byDate.get(lastSession)?.close && full.data?.check_open !== null, 'séance complète et contrôlée');
  const quote = await db.from('quote_live').select('price').single();
  assert(quote.data?.price === byDate.get(lastSession)?.close, 'cours en séance');
  const holiday = await TASKS.open.gate!(ctxAt('2026-12-25', 9 * 60 + 20));
  assert(holiday === 'pas de séance aujourd’hui', 'jour férié');
  const catchup = await TASKS.catchup.run(ctxAt(lastSession, 7 * 60 + 30, { days: 30 }));
  assert(catchup.message.includes('0 manquante'), `rattrapage : ${catchup.message}`);
});

Deno.test('appels planifiés et maintenance', async () => {
  const cronEstimate = await call({ task: 'estimate' }, { 'x-castor-cron': CRON_SECRET });
  assert(cronEstimate.status === 200, `estimation planifiée : ${JSON.stringify(cronEstimate.body)}`);
  const kind = await db.from('estimates').select('kind').order('computed_at', { ascending: false }).limit(1).single();
  assert(kind.data?.kind === 'scheduled', 'estimation planifiée marquée « scheduled »');
  const cronOpen = await call({ task: 'open' }, { 'x-castor-cron': CRON_SECRET });
  assert(cronOpen.status === 200, `ouverture planifiée : ${JSON.stringify(cronOpen.body)}`);
  const maint = await call({ task: 'maintenance' }, adminHeaders);
  assert(maint.status === 200, `maintenance : ${JSON.stringify(maint.body)}`);
  const quads = await db.from('quadrimesters').select('code');
  assert(quads.data?.some((q) => q.code === '2028/1'), 'quadrimestres suivants créés');
  const runs = await db.from('job_runs').select('job, status');
  assert(runs.data?.every((r) => r.status !== 'running'), 'aucune tâche restée « running »');
  assert(runs.data?.some((r) => r.job === 'history' && r.status === 'success'), 'journal des tâches');
});

Deno.test('accès : invitation, rôles, suppression', async () => {
  const invite = await call({ task: 'invite', email: 'Nouveau@Example.org', role: 'viewer', sendEmail: false }, adminHeaders);
  assert(invite.status === 200 && invite.body.link, `invitation : ${JSON.stringify(invite.body)}`);
  const users = await call({ task: 'users' }, adminHeaders);
  const created = users.body.users.find((u: { email: string }) => u.email === 'nouveau@example.org');
  assert(created?.role === 'viewer', 'invité listé avec son rôle');
  const promote = await call({ task: 'set-role', userId: created.id, role: 'admin' }, adminHeaders);
  assert(promote.status === 200, 'rôle modifié');
  const self = await call({ task: 'set-role', userId: ADMIN, role: 'viewer' }, adminHeaders);
  assert(self.status === 400, 'pas de modification de son propre rôle');
  const del = await call({ task: 'delete-user', userId: created.id }, adminHeaders);
  assert(del.status === 200, 'compte supprimé');
  const after = await db.from('user_roles').select('user_id').eq('user_id', created.id);
  assert(after.data?.length === 0, 'rôle supprimé avec le compte');
});
