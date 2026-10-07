import { isISODate, type ISODate } from './dates.ts';
import { isQuadCode } from './quadrimester.ts';
import type { Session } from './formula.ts';

/** Séance complète telle qu'importée (cours bruts, jamais ajustés). */
export interface PriceRow extends Session {
  volume?: number | null;
}

export interface CsvResult<T> {
  rows: T[];
  errors: string[];
  header: string[];
  delimiter: string;
}

function normalizeHeader(cell: string): string {
  return cell
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectDelimiter(lines: string[]): string {
  const sample = lines.slice(0, 20).join('\n');
  const counts = [';', '\t', ','].map((d) => ({ d, n: sample.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ',';
}

export function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Nombre au format français ou anglais : « 1 234,56 », « 1,234.56 », « 112.45 ». */
export function parseDecimal(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).replace(/[\s  "€]/g, '');
  if (s === '' || s === '-' || s.toLowerCase() === 'null' || s.toLowerCase() === 'n/a') return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    s = (s.match(/,/g) ?? []).length > 1 ? s.replace(/,/g, '') : s.replace(',', '.');
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/** Date « AAAA-MM-JJ », « JJ/MM/AAAA », « JJ.MM.AAAA » ou « JJ-MM-AAAA ». */
export function parseDateCell(raw: string | undefined | null): ISODate | null {
  if (!raw) return null;
  const s = raw.trim().replace(/"/g, '');
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) {
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    return isISODate(d) ? d : null;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  if (m) {
    const d = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return isISODate(d) ? d : null;
  }
  return null;
}

type PriceColumn = 'date' | 'open' | 'high' | 'low' | 'close' | 'vwap' | 'volume';

function priceColumn(h: string): PriceColumn | null {
  if (/adj/.test(h)) return null;
  if (['date', 'jour', 'seance', 'trade_date', 'trade date', 'date de seance'].includes(h)) return 'date';
  if (/^(open|ouverture|ouv\.?|opening|opening price|premier|premier cours|cours d'ouverture)$/.test(h)) return 'open';
  if (/^(high|haut|plus haut|\+ ?haut|highest)$/.test(h)) return 'high';
  if (/^(low|bas|plus bas|- ?bas|lowest)$/.test(h)) return 'low';
  if (/^(close|cloture|closing|closing price|dernier cours|cours de cloture)$/.test(h)) return 'close';
  if (h === 'vwap') return 'vwap';
  if (/^(volume|volumes|number of shares|nb titres|nombre de titres|quantite|volume \(titres\))$/.test(h)) return 'volume';
  return null;
}

/**
 * Import CSV de cours quotidiens (export Euronext, Yahoo, Boursorama…).
 * La colonne « Adj Close » est ignorée : le calcul n'utilise que des cours bruts.
 * À défaut de colonne « Close », la colonne « Last » est prise comme clôture.
 */
export function parsePriceCsv(text: string): CsvResult<PriceRow> {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const delimiter = detectDelimiter(lines);
  const errors: string[] = [];
  let headerIdx = -1;
  let columns: (PriceColumn | null)[] = [];
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const cells = splitCsvLine(lines[i], delimiter).map(normalizeHeader);
    const cols = cells.map(priceColumn);
    if (cols.includes('date') && (cols.includes('open') || cols.includes('close') || cells.includes('last'))) {
      headerIdx = i;
      columns = cols;
      if (!cols.includes('close')) {
        const lastIdx = cells.indexOf('last');
        if (lastIdx >= 0) columns[lastIdx] = 'close';
      }
      break;
    }
  }
  if (headerIdx < 0) {
    return { rows: [], errors: ['en-tête introuvable : il faut au moins une colonne Date et Open ou Close'], header: [], delimiter };
  }
  const header = splitCsvLine(lines[headerIdx], delimiter);
  const byDate = new Map<ISODate, PriceRow>();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delimiter);
    const row: PriceRow = { date: '' };
    columns.forEach((col, j) => {
      if (!col) return;
      if (col === 'date') row.date = parseDateCell(cells[j]) ?? '';
      else row[col] = parseDecimal(cells[j]);
    });
    if (!row.date) {
      errors.push(`ligne ${i + 1} : date illisible (${cells[columns.indexOf('date')] ?? ''})`);
      continue;
    }
    for (const k of ['open', 'high', 'low', 'close', 'vwap'] as const) {
      const v = row[k];
      if (v !== null && v !== undefined) {
        if (!(v > 0)) {
          errors.push(`ligne ${i + 1} : ${k} invalide`);
          row[k] = null;
        } else row[k] = round4(v);
      }
    }
    if (row.open == null && row.close == null) {
      errors.push(`ligne ${i + 1} : ni ouverture ni clôture`);
      continue;
    }
    if (byDate.has(row.date)) errors.push(`ligne ${i + 1} : date en double ${row.date}, la dernière ligne l'emporte`);
    byDate.set(row.date, row);
  }
  const rows = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return { rows, errors, header, delimiter };
}

export interface QuadrimesterImportRow {
  code: string;
  boardDate: ISODate | null;
  officialPrice: number | null;
  noticeUrl: string | null;
}

function quadColumn(h: string): keyof QuadrimesterImportRow | null {
  if (/^(code|quadrimestre|quad)$/.test(h)) return 'code';
  if (/^(board_date|date_ca|date du ca|ca|date ca|conseil)$/.test(h)) return 'boardDate';
  if (/^(official_price|prix|prix officiel|prix_officiel|price)$/.test(h)) return 'officialPrice';
  if (/^(notice_url|avis|source|url|lien)$/.test(h)) return 'noticeUrl';
  return null;
}

/** Import CSV du jeu de référence : code ; date du CA ; prix officiel ; lien vers l'avis. */
export function parseQuadrimesterCsv(text: string): CsvResult<QuadrimesterImportRow> {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const delimiter = detectDelimiter(lines);
  const errors: string[] = [];
  if (lines.length === 0) return { rows: [], errors: ['fichier vide'], header: [], delimiter };
  const header = splitCsvLine(lines[0], delimiter);
  const columns = header.map((h) => quadColumn(normalizeHeader(h)));
  if (!columns.includes('code')) {
    return { rows: [], errors: ['colonne « code » introuvable (ex. 2026/1)'], header, delimiter };
  }
  const rows: QuadrimesterImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delimiter);
    const row: QuadrimesterImportRow = { code: '', boardDate: null, officialPrice: null, noticeUrl: null };
    columns.forEach((col, j) => {
      const cell = cells[j] ?? '';
      if (col === 'code') row.code = cell.trim();
      else if (col === 'boardDate') row.boardDate = parseDateCell(cell);
      else if (col === 'officialPrice') row.officialPrice = parseDecimal(cell);
      else if (col === 'noticeUrl') row.noticeUrl = cell.trim() || null;
    });
    if (!isQuadCode(row.code)) {
      errors.push(`ligne ${i + 1} : code invalide « ${row.code} »`);
      continue;
    }
    if (row.officialPrice !== null && !(row.officialPrice > 0)) {
      errors.push(`ligne ${i + 1} : prix invalide`);
      continue;
    }
    rows.push(row);
  }
  return { rows, errors, header, delimiter };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Convertit le premier tableau HTML d'une page (ex. fenêtre « historique »
 * d'Euronext Live) en CSV séparé par des points-virgules, lisible par
 * `parsePriceCsv`.
 */
export function htmlTableToCsv(html: string): string {
  const table = /<table[\s\S]*?<\/table>/i.exec(html)?.[0] ?? html;
  const rows: string[] = [];
  for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) =>
      decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().replace(/;/g, ','),
    );
    if (cells.length > 0) rows.push(cells.join(';'));
  }
  return rows.join('\n');
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}
