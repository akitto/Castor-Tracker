import {
  htmlTableToCsv,
  parsePriceCsv,
  parseYahooChart,
  type ISODate,
  type PriceRow,
  type YahooChart,
} from '../_shared/core/index.ts';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 CastorTracker/1.0';

const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

function epoch(date: ISODate): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

/**
 * Source principale : API « chart » de Yahoo Finance (non officielle, sans clé).
 * `range` (ex. « 5d ») ou période [from, to] ; barres quotidiennes et dividendes.
 */
export async function fetchYahoo(
  symbol: string,
  opts: { range?: string; from?: ISODate; to?: ISODate },
): Promise<YahooChart> {
  const qs = new URLSearchParams({ interval: '1d', includePrePost: 'false', events: 'div' });
  if (opts.range) qs.set('range', opts.range);
  else {
    qs.set('period1', String(epoch(opts.from ?? '2015-01-01')));
    qs.set('period2', String(epoch(opts.to ?? new Date().toISOString().slice(0, 10)) + 2 * 86_400));
  }
  const errors: string[] = [];
  for (const host of YAHOO_HOSTS) {
    try {
      const res = await fetch(`${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        errors.push(`${new URL(host).hostname} : HTTP ${res.status}`);
        continue;
      }
      return parseYahooChart(await res.json());
    } catch (e) {
      errors.push(`${new URL(host).hostname} : ${(e as Error).message}`);
    }
  }
  throw new Error(`Yahoo indisponible (${errors.join(' ; ')})`);
}

const EURONEXT_DEFAULT =
  'https://live.euronext.com/en/ajax/AwlHistoricalPrice/getFullDownloadAjax/{code}?format=csv&decimal_separator=.&date_form=d/m/Y&op=&adjusted=N&base100=&startdate={from}&enddate={to}';
const EURONEXT_POPUP = 'https://live.euronext.com/en/ajax/getHistoricalPricePopup/{code}';

/**
 * Source de contrôle : historique Euronext Live (point d'accès web non documenté).
 * Essaie le téléchargement CSV, puis la fenêtre HTML « historique ».
 */
export async function fetchEuronext(
  code: string,
  from: ISODate,
  to: ISODate,
  template?: string | null,
): Promise<PriceRow[]> {
  const fill = (t: string) =>
    t.replaceAll('{code}', encodeURIComponent(code)).replaceAll('{from}', from).replaceAll('{to}', to);
  const errors: string[] = [];
  try {
    const res = await fetch(fill(template || EURONEXT_DEFAULT), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/csv,text/plain,*/*' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const parsed = parsePriceCsv(await res.text());
      if (parsed.rows.length > 0) return parsed.rows;
      errors.push(`CSV illisible (${parsed.errors[0] ?? 'aucune ligne'})`);
    } else errors.push(`CSV : HTTP ${res.status}`);
  } catch (e) {
    errors.push(`CSV : ${(e as Error).message}`);
  }
  try {
    const sessions = Math.min(400, Math.max(10, Math.ceil((Date.parse(to) - Date.parse(from)) / 86_400_000)));
    const res = await fetch(fill(EURONEXT_POPUP), {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams({ adjusted: 'N', startdate: from, enddate: to, nbSession: String(sessions) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const parsed = parsePriceCsv(htmlTableToCsv(await res.text()));
      if (parsed.rows.length > 0) return parsed.rows.filter((r) => r.date >= from && r.date <= to);
      errors.push('page historique illisible');
    } else errors.push(`page historique : HTTP ${res.status}`);
  } catch (e) {
    errors.push(`page historique : ${(e as Error).message}`);
  }
  throw new Error(`Euronext indisponible (${errors.join(' ; ')})`);
}
