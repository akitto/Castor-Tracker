// Notifications : création des événements (producteurs appelés par les tâches) et envoi
// (Web Push pour tous les comptes abonnés, webhook pour les administrateurs).
import { addDays, diffDays, parisDateOf, weekday, type ISODate } from '../_shared/core/index.ts';
import { loadConfig, must, num, toJson, type AppConfig, type Db, type Market, type QuadRow } from './db.ts';
import { errorMessage } from './http.ts';
import { generateVapidKeys, sendPush, type VapidKeys } from './webpush.ts';

// ---------------------------------------------------------------------------
// Mise en forme
// ---------------------------------------------------------------------------

const frNum = (v: number, digits = 2) =>
  v.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/ | /g, ' ');
export const euro = (v: number) => `${frNum(v)} €`;
const signed = (v: number, digits = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${frNum(Math.abs(v), digits)}`;
const dateFr = (d: ISODate) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const dayMonth = (d: ISODate) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

// ---------------------------------------------------------------------------
// Création des événements
// ---------------------------------------------------------------------------

export interface NotifyEvent {
  type: string;
  title: string;
  body: string;
  /** Chemin dans la PWA ouvert au clic. */
  url?: string | null;
  /** Clé de déduplication : un même événement n'est jamais notifié deux fois. */
  dedup?: string | null;
  data?: Record<string, unknown>;
  /** Alerte personnelle (seuil propre à un compte). */
  target?: string | null;
}

/** Enregistre un événement ; ne lève jamais d'exception (une notification ne doit pas faire échouer une tâche). */
export async function emit(db: Db, ev: NotifyEvent): Promise<boolean> {
  try {
    const id = await must(
      db.rpc('notification_emit', {
        p_type: ev.type,
        p_title: ev.title,
        p_body: ev.body,
        p_url: ev.url ?? undefined,
        p_dedup: ev.dedup ?? undefined,
        p_data: toJson(ev.data ?? {}),
        p_target: ev.target ?? undefined,
        p_kick: false,
      }),
      'notification',
    );
    return id !== null;
  } catch (e) {
    console.error(`notification ${ev.type} :`, errorMessage(e));
    return false;
  }
}

interface Recipient {
  user_id: string;
  role: string;
  params: Record<string, unknown>;
  quiet_hours: boolean;
}

async function recipients(db: Db, type: string): Promise<Recipient[]> {
  return (await must(db.rpc('notification_recipients', { p_type: type }), 'destinataires')) as unknown as Recipient[];
}

async function loadStates(db: Db, type: string, users: string[]): Promise<Map<string, Record<string, unknown>>> {
  if (users.length === 0) return new Map();
  const rows = (await must(
    db.from('notification_state').select('user_id, state').eq('type', type).in('user_id', users),
    'mémoire des alertes',
  )) as { user_id: string; state: Record<string, unknown> }[];
  return new Map(rows.map((r) => [r.user_id, r.state ?? {}]));
}

async function saveState(db: Db, type: string, userId: string, state: Record<string, unknown>): Promise<void> {
  await must(
    db.from('notification_state').upsert({ user_id: userId, type, state: toJson(state), updated_at: new Date().toISOString() }),
    'mémoire des alertes',
  );
}

/** Exécute un producteur sans laisser une erreur remonter à la tâche. */
export async function safely(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`notifications (${label}) :`, errorMessage(e));
  }
}

// ---------------------------------------------------------------------------
// Producteurs : estimation
// ---------------------------------------------------------------------------

export interface EstimateSummary {
  estimateId: number;
  code: string;
  state: string;
  central: number;
  p05: number;
  p95: number;
  reliability: number;
  known: number;
  windowDays: number;
}

const interval = (e: Pick<EstimateSummary, 'p05' | 'p95' | 'reliability'>) =>
  `[${frNum(e.p05)} – ${frNum(e.p95)}], IF ${Math.round(e.reliability)}`;

/** Changement de phase : début de la fenêtre des 20 séances, puis prix figé. */
export async function notifyEstimatePhase(db: Db, prevState: string | null, e: EstimateSummary): Promise<void> {
  if (!prevState || prevState === e.state) return;
  const fixed = (s: string) => s === 'frozen' || s === 'computed';
  if (e.state === 'window' && prevState === 'projection') {
    await emit(db, {
      type: 'estimate_phase',
      title: `Fenêtre de calcul ouverte pour ${e.code}`,
      body: `La première des ${e.windowDays} séances qui fixent le prix est connue. Estimation : ${euro(e.central)} ${interval(e)}.`,
      url: '/',
      dedup: `phase:${e.code}:window`,
      data: { code: e.code, state: e.state },
    });
  } else if (fixed(e.state) && !fixed(prevState)) {
    await emit(db, {
      type: 'estimate_phase',
      title: e.state === 'computed' ? `Prix ${e.code} figé : ${euro(e.central)}` : `Prix ${e.code} quasi figé`,
      body: e.state === 'computed'
        ? `Les ${e.windowDays} séances sont connues et la date du CA aussi : le prix calculé est ${euro(e.central)}, en attendant l’avis officiel.`
        : `Toutes les séances des dates de CA possibles sont connues. Estimation : ${euro(e.central)} ${interval(e)}.`,
      url: '/',
      dedup: `phase:${e.code}:fixed`,
      data: { code: e.code, state: e.state },
    });
  }
}

/** Variation de l'estimation depuis la dernière alerte de chaque compte (seuil en euros, 0,50 € par défaut). */
export async function notifyEstimateMove(db: Db, e: EstimateSummary): Promise<number> {
  const list = await recipients(db, 'estimate_move');
  const states = await loadStates(db, 'estimate_move', list.map((r) => r.user_id));
  let sent = 0;
  for (const r of list) {
    const threshold = Math.max(0.01, num(r.params.threshold) ?? 0.5);
    const st = states.get(r.user_id) ?? {};
    const last = num(st.central);
    if (st.code !== e.code || last === null) {
      // Première estimation suivie pour ce quadrimestre : référence, sans alerte.
      await saveState(db, 'estimate_move', r.user_id, { code: e.code, central: e.central, at: new Date().toISOString() });
      continue;
    }
    const delta = Math.round((e.central - last) * 100) / 100;
    if (Math.abs(delta) + 1e-9 < threshold) continue;
    const ok = await emit(db, {
      type: 'estimate_move',
      target: r.user_id,
      title: `Estimation ${e.code} : ${euro(e.central)} (${signed(delta)} €)`,
      body: `Intervalle à 90 % ${interval(e)}. Précédente alerte : ${euro(last)}${typeof st.at === 'string' ? ` le ${dayMonth(parisDateOf(Date.parse(st.at)))}` : ''}.`,
      url: '/',
      dedup: `move:${e.code}:${r.user_id}:${e.estimateId}`,
      data: { code: e.code, central: e.central, previous: last, delta },
    });
    if (ok) sent++;
    await saveState(db, 'estimate_move', r.user_id, { code: e.code, central: e.central, at: new Date().toISOString() });
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Producteur : alerte de cours
// ---------------------------------------------------------------------------

/** Franchissement des seuils de cours de chaque compte ; réarmé quand le cours repasse de 0,5 % sous (ou au-dessus) du seuil. */
export async function notifyPriceAlerts(
  db: Db,
  quote: { price: number; prevClose: number | null; time: string },
): Promise<number> {
  const list = await recipients(db, 'price_alert');
  const active = list.filter((r) => num(r.params.above) !== null || num(r.params.below) !== null);
  if (active.length === 0) return 0;
  const states = await loadStates(db, 'price_alert', active.map((r) => r.user_id));
  const change = quote.prevClose ? ` (${signed((quote.price / quote.prevClose - 1) * 100, 1)} % sur la veille)` : '';
  let sent = 0;
  for (const r of active) {
    const above = num(r.params.above);
    const below = num(r.params.below);
    const st = { ...(states.get(r.user_id) ?? {}) } as { above?: number | null; below?: number | null };
    let changed = false;
    // État mémorisé : seuil pour lequel l'alerte est partie (un nouveau seuil réarme l'alerte).
    if (above !== null) {
      if (st.above !== above && quote.price >= above) {
        if (await emit(db, {
          type: 'price_alert',
          target: r.user_id,
          title: `VINCI au-dessus de ${euro(above)}`,
          body: `Cours ${euro(quote.price)}${change}, différé de 15 min.`,
          url: '/graphique',
          dedup: `price:${r.user_id}:above:${above}:${quote.time}`,
          data: { price: quote.price, threshold: above, side: 'above' },
        })) sent++;
        st.above = above;
        changed = true;
      } else if (st.above != null && quote.price < (st.above as number) * 0.995) {
        st.above = null;
        changed = true;
      }
    }
    if (below !== null) {
      if (st.below !== below && quote.price <= below) {
        if (await emit(db, {
          type: 'price_alert',
          target: r.user_id,
          title: `VINCI en dessous de ${euro(below)}`,
          body: `Cours ${euro(quote.price)}${change}, différé de 15 min.`,
          url: '/graphique',
          dedup: `price:${r.user_id}:below:${below}:${quote.time}`,
          data: { price: quote.price, threshold: below, side: 'below' },
        })) sent++;
        st.below = below;
        changed = true;
      } else if (st.below != null && quote.price > (st.below as number) * 1.005) {
        st.below = null;
        changed = true;
      }
    }
    if (changed) await saveState(db, 'price_alert', r.user_id, st);
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Producteurs : contrôles quotidiens (rattrapage du matin)
// ---------------------------------------------------------------------------

async function latestEstimate(db: Db, code: string) {
  return (await must(
    db.from('estimates').select('id, central, p05, p95, reliability, state')
      .eq('quadrimester_code', code).in('kind', ['scheduled', 'manual'])
      .order('computed_at', { ascending: false }).limit(1).maybeSingle(),
    'dernière estimation',
  )) as { id: number; central: number; p05: number; p95: number; reliability: number; state: string } | null;
}

function boardText(q: QuadRow): string {
  if (q.board_date) return `CA le ${dateFr(q.board_date)}`;
  if (q.board_slot_start && q.board_slot_end) return `CA attendu entre le ${dayMonth(q.board_slot_start)} et le ${dateFr(q.board_slot_end)}`;
  return 'date du CA inconnue';
}

/** Rappels utilisateurs (clôture des versements, résumé du lundi) et contrôles admin, une fois par jour. */
export async function dailyChecks(db: Db, market: Market, today: ISODate, missing: ISODate[]): Promise<void> {
  const current = market.quads.find((q) => q.start_date <= today && q.end_date >= today) ?? null;
  const next = market.quads.filter((q) => q.start_date > today && q.official_price === null)[0] ?? null;
  const est = next ? await latestEstimate(db, next.code) : null;
  const estText = next && est ? `Prix ${next.code} estimé : ${euro(Number(est.central))} ${interval({ p05: Number(est.p05), p95: Number(est.p95), reliability: Number(est.reliability) })}.` : '';

  // Clôture des versements : J−3 puis le dernier jour.
  if (current) {
    const days = diffDays(current.payment_close_date, today);
    if (days >= 0 && days <= 3) {
      await emit(db, {
        type: 'payment_deadline',
        title: days === 0
          ? `Dernier jour de versement Castor (${current.code})`
          : `Versements Castor : clôture le ${dateFr(current.payment_close_date)}`,
        body: `${days === 0 ? 'Les versements ferment ce soir.' : `Plus que ${plural(days, 'jour', 'jours')}.`}${estText ? ` ${estText}` : ''}`,
        url: '/',
        dedup: `deadline:${current.code}:${days === 0 ? 'J0' : 'J-3'}`,
        data: { code: current.code, days },
      });
    }
  }

  // Résumé hebdomadaire (lundi).
  if (weekday(today) === 1 && next) {
    const last = market.rows[market.rows.length - 1];
    const close = num(last?.close) ?? num(last?.open);
    await emit(db, {
      type: 'weekly_digest',
      title: est ? `Castor ${next.code} : ${euro(Number(est.central))}` : `Castor ${next.code} : semaine du ${dayMonth(today)}`,
      body: [
        est ? `Intervalle à 90 % ${interval({ p05: Number(est.p05), p95: Number(est.p95), reliability: Number(est.reliability) })}.` : 'Pas encore d’estimation.',
        `${boardText(next)}.`,
        close !== null && last ? `Clôture VINCI du ${dayMonth(last.trade_date)} : ${euro(close)}.` : '',
      ].filter(Boolean).join(' '),
      url: '/',
      dedup: `digest:${today}`,
    });
  }

  // Admin : tâche du soir non aboutie sur la dernière séance (seulement une fois l'exploitation lancée).
  const prevSession = market.calendar.previousSession(today);
  const recent = (await must(
    db.from('job_runs').select('started_at').eq('job', 'session').eq('status', 'success')
      .gte('started_at', `${addDays(today, -12)}T00:00:00Z`).order('started_at', { ascending: false }),
    'journal',
  )) as { started_at: string }[];
  if (recent.length > 0 && !recent.some((r) => parisDateOf(Date.parse(r.started_at)) === prevSession)) {
    const row = market.rows.find((r) => r.trade_date === prevSession);
    await emit(db, {
      type: 'job_missed',
      title: `Séance du ${dateFr(prevSession)} non collectée le soir`,
      body: row?.close
        ? 'La tâche de 18 h n’a pas abouti ; le rattrapage de ce matin a récupéré la séance. Vérifier pg_cron et le journal.'
        : 'La tâche de 18 h n’a pas abouti et la séance manque toujours : relancer la collecte ou importer un CSV.',
      url: '/admin/journal',
      dedup: `missed:${prevSession}`,
    });
  }

  if (missing.length > 0) {
    await emit(db, {
      type: 'data_anomaly',
      title: `${plural(missing.length, 'séance manquante', 'séances manquantes')} dans les cours`,
      body: `${missing.slice(0, 5).map(dateFr).join(', ')}${missing.length > 5 ? '…' : ''} : ouverture ou clôture absente des sources. Corriger ou importer un CSV.`,
      url: '/admin/cours',
      dedup: `missing:${missing.join(',')}`,
    });
  }

  // Admin : saisies attendues sur le prochain quadrimestre.
  if (next) {
    if (next.board_status === 'estimated' && next.board_slot_start && diffDays(next.board_slot_start, today) <= 7) {
      await emit(db, {
        type: 'data_entry',
        title: `Date du CA à saisir pour ${next.code}`,
        body: `${boardText(next)}. Saisir la date dès sa publication : l’estimation se resserre aussitôt.`,
        url: `/admin/quadrimestres/${next.code.replace('/', '-')}`,
        dedup: `entry:board:${next.code}`,
      });
    }
    const after = [next.board_date ?? next.board_slot_end, current?.payment_close_date ?? null]
      .filter((d): d is ISODate => Boolean(d)).sort().pop();
    if (after && diffDays(today, after) >= 3) {
      await emit(db, {
        type: 'data_entry',
        title: `Prix officiel ${next.code} non saisi`,
        body: `Le CA et la clôture des versements sont passés depuis le ${dateFr(after)} : saisir le prix de l’avis VINCI (Admin › Quadrimestres).`,
        url: `/admin/quadrimestres/${next.code.replace('/', '-')}`,
        dedup: `entry:price:${next.code}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Producteurs : anomalies de données (admin)
// ---------------------------------------------------------------------------

export interface Spread {
  date: ISODate;
  field: string;
  ours: number;
  theirs: number;
  bps: number;
}

export async function notifySpreads(db: Db, spreads: Spread[]): Promise<void> {
  if (spreads.length === 0) return;
  const label = (f: string) => (f === 'open' ? 'ouverture' : 'clôture');
  await emit(db, {
    type: 'data_anomaly',
    title: `Écart Yahoo / Euronext sur ${plural(spreads.length, 'cours', 'cours')}`,
    body: `${spreads.slice(0, 3).map((s) => `${dayMonth(s.date)} ${label(s.field)} ${frNum(s.ours)} / ${frNum(s.theirs)} (${frNum(s.bps / 100, 1)} %)`).join(' ; ')}${spreads.length > 3 ? ' ; …' : ''}. Vérifier la séance (Admin › Données de cours).`,
    url: '/admin/cours',
    dedup: `spread:${spreads.map((s) => `${s.date}${s.field[0]}`).join(',')}`,
  });
}

export async function notifyFallback(db: Db, date: ISODate, reason: string): Promise<void> {
  await emit(db, {
    type: 'data_anomaly',
    title: 'Repli sur Euronext',
    body: `Yahoo indisponible (${reason.slice(0, 160)}) : cours du ${dateFr(date)} pris chez Euronext.`,
    url: '/admin/journal',
    dedup: `fallback:${date}`,
  });
}

/** Ouverture aberrante : plus de 8 % d'écart avec la clôture précédente, sans détachement de dividende. */
export async function notifyAberrantOpen(db: Db, market: Market, date: ISODate): Promise<void> {
  const i = market.rows.findIndex((r) => r.trade_date === date);
  if (i <= 0) return;
  const open = num(market.rows[i].open);
  const prev = num(market.rows[i - 1].close);
  if (open === null || prev === null) return;
  const move = open / prev - 1;
  if (Math.abs(move) <= 0.08 || market.dividends.some((d) => d.exDate === date)) return;
  await emit(db, {
    type: 'data_anomaly',
    title: `Ouverture du ${dateFr(date)} suspecte`,
    body: `Ouverture ${euro(open)}, ${signed(move * 100, 1)} % sur la clôture précédente (${euro(prev)}), sans dividende ce jour-là. Elle entre dans la moyenne des 20 séances : vérifier.`,
    url: '/admin/cours',
    dedup: `aberrant:${date}`,
  });
}

export async function notifyAmbiguousInference(db: Db, results: { code: string; matches: { date: ISODate }[] }[]): Promise<void> {
  for (const r of results.filter((x) => x.matches.length > 1)) {
    const dates = r.matches.map((m) => m.date);
    await emit(db, {
      type: 'inference',
      title: `Date du CA ambiguë pour ${r.code}`,
      body: `${dates.length} dates donnent le prix officiel au centime : ${dates.slice(0, 5).map(dateFr).join(', ')}. Aucune n’est appliquée ; saisir la date de l’avis.`,
      url: `/admin/quadrimestres/${r.code.replace('/', '-')}`,
      dedup: `infer:${r.code}:${dates.join(',')}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Envoi
// ---------------------------------------------------------------------------

/** Clés VAPID de l'instance, créées au premier besoin (privée dans Vault, publique dans app_config). */
export async function pushKeys(db: Db): Promise<VapidKeys> {
  type Keys = { public: string | null; private: string | null };
  let keys = (await must(db.rpc('castor_push_keys'), 'clés VAPID')) as unknown as Keys;
  if (!keys?.public || !keys?.private) {
    const gen = await generateVapidKeys();
    keys = (await must(
      db.rpc('castor_push_keys_init', { p_public: gen.publicKey, p_private: JSON.stringify(gen.privateJwk) }),
      'clés VAPID',
    )) as unknown as Keys;
    if (!keys?.public || !keys?.private) throw new Error('clés VAPID non enregistrées : Vault est-il disponible ?');
  }
  return { publicKey: keys.public, privateJwk: JSON.parse(keys.private) };
}

function vapidSubject(config: AppConfig): string {
  const site = config.site_url ?? '';
  return /^https:\/\//.test(site) ? site.replace(/\/$/, '') : 'mailto:notifications@castor-tracker.invalid';
}

function absoluteUrl(config: AppConfig, path: string | null | undefined): string | null {
  if (!path) return config.site_url ?? null;
  if (/^https?:\/\//.test(path)) return path;
  return config.site_url ? `${config.site_url.replace(/\/$/, '')}${path}` : null;
}

export interface EventPayload {
  id: number;
  type: string;
  title: string;
  body: string;
  url: string | null;
  urgent: boolean;
  data: Record<string, unknown>;
  created_at: string;
}

/** Remplace sur l'appareil la notification précédente du même sujet (estimation, cours). */
function tagOf(ev: Pick<EventPayload, 'id' | 'type' | 'data'>): string {
  const replaceable = ['estimate_move', 'estimate_phase', 'price_alert', 'weekly_digest', 'payment_deadline'];
  return replaceable.includes(ev.type) ? `castor-${ev.type}` : `castor-${ev.type}-${ev.id}`;
}

export function pushMessage(ev: EventPayload) {
  return { title: ev.title, body: ev.body, url: ev.url ?? '/', tag: tagOf(ev), urgent: ev.urgent, type: ev.type, ts: ev.created_at };
}

export interface WebhookTarget {
  webhook_url: string;
  webhook_format: 'json' | 'ntfy' | 'discord' | 'slack' | string;
  webhook_secret: string | null;
}

export interface SendResult {
  ok: boolean;
  status: number;
  error?: string;
}

/** Envoie un événement à un webhook selon son format (JSON générique, ntfy, Discord, Slack et compatibles). */
export async function sendWebhook(target: WebhookTarget, ev: EventPayload, config: AppConfig): Promise<SendResult> {
  const link = absoluteUrl(config, ev.url);
  let url = target.webhook_url;
  let body: unknown;
  switch (target.webhook_format) {
    case 'ntfy': {
      // Publication JSON à la racine du serveur ntfy (titres accentués acceptés), sujet tiré de l'URL.
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      const topic = parts.pop();
      if (!topic) throw new Error('URL ntfy sans sujet (attendu : https://ntfy.sh/mon-sujet)');
      url = `${u.origin}/${parts.join('/')}`;
      body = {
        topic,
        title: ev.title,
        message: ev.body,
        priority: ev.urgent ? 5 : 3,
        tags: [ev.urgent ? 'rotating_light' : 'chart_with_upwards_trend'],
        ...(link ? { click: link } : {}),
      };
      break;
    }
    case 'discord':
      body = {
        username: 'Castor Tracker',
        embeds: [{
          title: ev.title,
          description: ev.body,
          ...(link ? { url: link } : {}),
          color: ev.urgent ? 0xb42318 : 0x0b5e7e,
          timestamp: ev.created_at,
        }],
      };
      break;
    case 'slack':
      body = { text: `*${ev.title}*\n${ev.body}${link ? `\n<${link}|Ouvrir Castor Tracker>` : ''}` };
      break;
    default:
      body = {
        source: 'castor-tracker',
        id: ev.id,
        type: ev.type,
        title: ev.title,
        body: ev.body,
        url: link ?? ev.url,
        urgent: ev.urgent,
        created_at: ev.created_at,
        data: ev.data,
      };
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'castor-tracker' };
  if (target.webhook_secret) headers.Authorization = target.webhook_secret;
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 300);
    if (res.ok) await res.body?.cancel().catch(() => {});
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}${text ? ` : ${text}` : ''}` };
  } catch (e) {
    return { ok: false, status: 0, error: errorMessage(e) };
  }
}

interface Claimed {
  id: number;
  channel: 'push' | 'webhook';
  user_id: string;
  attempts: number;
  event: EventPayload;
}

interface SubscriptionRow {
  id: number;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface DispatchReport {
  fannedOut: number;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}

const MAX_ATTEMPTS = 3;

/** Envoie les abonnements push d'un compte ; supprime ceux que le service déclare expirés. */
export async function pushToUser(
  db: Db,
  subs: SubscriptionRow[],
  message: unknown,
  keys: VapidKeys,
  config: AppConfig,
  urgent: boolean,
): Promise<{ ok: boolean; results: { id: number; ok: boolean; status: number; error?: string }[] }> {
  const results = await Promise.all(subs.map(async (s) => {
    const r = await sendPush(s, message, keys, {
      subject: vapidSubject(config),
      urgency: urgent ? 'high' : 'normal',
      ttl: urgent ? 6 * 3600 : 24 * 3600,
    });
    if (r.gone) {
      await db.from('push_subscriptions').delete().eq('id', s.id);
    } else if (r.ok) {
      await db.from('push_subscriptions').update({ last_success_at: new Date().toISOString(), failures: 0, last_error: null }).eq('id', s.id);
    } else {
      const cur = await db.from('push_subscriptions').select('failures').eq('id', s.id).maybeSingle();
      await db.from('push_subscriptions')
        .update({ failures: ((cur.data as { failures: number } | null)?.failures ?? 0) + 1, last_error: r.error ?? null })
        .eq('id', s.id);
    }
    return { id: s.id, ok: r.ok, status: r.status, error: r.gone ? 'abonnement expiré (supprimé)' : r.error };
  }));
  return { ok: results.some((r) => r.ok), results };
}

/** Répartit les nouveaux événements, puis envoie ce qui est dû (heures calmes respectées, 3 essais). */
export async function dispatch(db: Db): Promise<DispatchReport> {
  const report: DispatchReport = { fannedOut: 0, claimed: 0, sent: 0, retried: 0, failed: 0, skipped: 0 };
  report.fannedOut = Number(await must(db.rpc('notification_fanout'), 'répartition des notifications')) || 0;
  const claimed = (await must(db.rpc('notification_claim', { p_limit: 200 }), 'envois dus')) as unknown as Claimed[];
  report.claimed = claimed.length;
  if (claimed.length === 0) return report;

  const config = await loadConfig(db);
  const pushUsers = [...new Set(claimed.filter((c) => c.channel === 'push').map((c) => c.user_id))];
  const hookUsers = [...new Set(claimed.filter((c) => c.channel === 'webhook').map((c) => c.user_id))];
  const subs = pushUsers.length
    ? ((await must(db.from('push_subscriptions').select('id, user_id, endpoint, p256dh, auth').in('user_id', pushUsers), 'abonnements')) as SubscriptionRow[])
    : [];
  const hooks = hookUsers.length
    ? ((await must(
      db.from('notification_settings').select('user_id, webhook_url, webhook_format, webhook_secret, webhook_enabled').in('user_id', hookUsers),
      'webhooks',
    )) as (WebhookTarget & { user_id: string; webhook_enabled: boolean })[])
    : [];
  let keys: VapidKeys | null = null;
  if (subs.length > 0) {
    try {
      keys = await pushKeys(db);
    } catch (e) {
      console.error('clés VAPID :', errorMessage(e));
    }
  }

  const finish = async (c: Claimed, outcome: 'sent' | 'skipped' | 'error', error?: string) => {
    if (outcome === 'sent') {
      report.sent++;
      await db.from('notification_deliveries').update({ status: 'sent', sent_at: new Date().toISOString(), error: null }).eq('id', c.id);
    } else if (outcome === 'skipped') {
      report.skipped++;
      await db.from('notification_deliveries').update({ status: 'skipped', error: error ?? null }).eq('id', c.id);
    } else if (c.attempts >= MAX_ATTEMPTS) {
      report.failed++;
      await db.from('notification_deliveries').update({ status: 'failed', error: error ?? null }).eq('id', c.id);
    } else {
      report.retried++;
      const retryAt = new Date(Date.now() + 15 * 60_000 * c.attempts).toISOString();
      await db.from('notification_deliveries').update({ status: 'pending', not_before: retryAt, error: error ?? null }).eq('id', c.id);
    }
  };

  const work = claimed.map((c) => async () => {
    try {
      if (c.channel === 'push') {
        const mine = subs.filter((s) => s.user_id === c.user_id);
        if (mine.length === 0) return finish(c, 'skipped', 'aucun appareil abonné');
        if (!keys) return finish(c, 'error', 'clés VAPID indisponibles');
        const r = await pushToUser(db, mine, pushMessage(c.event), keys, config, c.event.urgent);
        if (r.ok) return finish(c, 'sent');
        if (r.results.every((x) => x.error === 'abonnement expiré (supprimé)')) return finish(c, 'skipped', 'abonnements expirés');
        return finish(c, 'error', r.results.map((x) => x.error).filter(Boolean).join(' ; ').slice(0, 500));
      }
      const hook = hooks.find((h) => h.user_id === c.user_id);
      if (!hook?.webhook_enabled || !hook.webhook_url) return finish(c, 'skipped', 'webhook désactivé');
      const r = await sendWebhook(hook, c.event, config);
      return r.ok ? finish(c, 'sent') : finish(c, 'error', r.error);
    } catch (e) {
      return finish(c, 'error', errorMessage(e));
    }
  });
  // 8 envois en parallèle au plus
  for (let i = 0; i < work.length; i += 8) await Promise.all(work.slice(i, i + 8).map((w) => w()));
  return report;
}

/** Battement du moniteur externe (Uptime Kuma, healthchecks.io) : preuve que pg_cron, pg_net et la fonction tournent. */
export async function heartbeat(db: Db): Promise<void> {
  const row = await db.from('admin_config').select('heartbeat_url').maybeSingle();
  const url = (row.data as { heartbeat_url: string | null } | null)?.heartbeat_url;
  if (!url) return;
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5_000) });
    await res.body?.cancel().catch(() => {});
  } catch (e) {
    console.error('battement du moniteur :', errorMessage(e));
  }
}
