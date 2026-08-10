/**
 * Nasdaq Trader ticker source (issue #11).
 *
 * Uses the public Symbol Directory files:
 *  - https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt
 *  - https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt
 *
 * Responsibilities:
 *  - parse both files into a single symbol table,
 *  - cache the parsed table for 24h on disk under ~/.regardedtrader/cache/symbols,
 *  - support exact fetch() and prefix search() by symbol/company name.
 *
 * Note on "type": `TickerProfile`/`PartialTickerProfile` now expose an
 * optional `type` field. This source still emits listing type via description
 * text until explicit type mapping is added.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configHome } from '../../config/index.js';
import {
  PartialTickerProfile,
  type PartialTickerProfile as PartialTickerProfileT,
} from '../../schemas/ticker.js';
import type { PoliteFetchClient } from '../http.js';
import type { TickerSource } from '../source.js';

export const NASDAQ_TRADER_BASE_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir';
export const NASDAQ_LISTED_URL = `${NASDAQ_TRADER_BASE_URL}/nasdaqlisted.txt`;
export const OTHER_LISTED_URL = `${NASDAQ_TRADER_BASE_URL}/otherlisted.txt`;

const DEFAULT_WEIGHT = 0.85;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILENAME = 'nasdaq-trader-symbols.v1.json';

export type NasdaqTraderSourceLogger = {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
};

export interface NasdaqTraderTickerSourceOptions {
  client: PoliteFetchClient;
  weight?: number;
  listedUrl?: string;
  otherListedUrl?: string;
  cacheDir?: string;
  cacheTtlMs?: number;
  now?: () => Date;
  logger?: NasdaqTraderSourceLogger;
}

type SecurityType = 'Common Stock' | 'ETF';

export interface NasdaqTickerRow {
  symbol: string;
  name: string;
  exchange: string;
  securityType: SecurityType;
  sourceUrl: string;
}

interface ParsedTable {
  fetchedAt: string;
  rows: NasdaqTickerRow[];
}

interface LoadedTable {
  fetchedAtMs: number;
  rows: NasdaqTickerRow[];
  bySymbol: Map<string, NasdaqTickerRow>;
}

const EXCHANGE_CODE_MAP: Record<string, string> = {
  N: 'NYSE',
  A: 'NYSEAMERICAN',
  P: 'NYSEARCA',
  Z: 'BATS',
  V: 'IEX',
};

class NasdaqTraderTickerSource implements TickerSource {
  readonly name = 'nasdaq-trader';
  readonly weight: number;

  private memo: LoadedTable | null = null;
  private readonly cacheDir: string;
  private readonly cacheTtlMs: number;
  private readonly now: () => Date;
  private readonly logger: NasdaqTraderSourceLogger;

  constructor(private readonly opts: NasdaqTraderTickerSourceOptions) {
    const w = opts.weight ?? DEFAULT_WEIGHT;
    if (!Number.isFinite(w) || w < 0 || w > 1) {
      throw new Error(`NasdaqTraderTickerSource: weight must be in [0, 1]; got ${w}`);
    }
    this.weight = w;
    this.cacheDir = opts.cacheDir ?? join(configHome(), 'cache', 'symbols');
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger ?? { warn: () => {} };
  }

  async search(query: string): Promise<PartialTickerProfileT[]> {
    const q = query.trim();
    if (q.length === 0) return [];

    const table = await this.loadTable();
    const qUpper = q.toUpperCase();
    const qLower = q.toLowerCase();

    const ranked = table.rows
      .map((row) => ({ row, score: scorePrefixMatch(row, qUpper, qLower) }))
      .filter((x): x is { row: NasdaqTickerRow; score: number } => x.score !== null)
      .sort((a, b) => a.score - b.score || a.row.symbol.localeCompare(b.row.symbol))
      .slice(0, 25)
      .map((x) => toPartialProfile(x.row));

    return ranked;
  }

  async fetch(symbol: string): Promise<PartialTickerProfileT | null> {
    const sym = normalizeSymbol(symbol);
    if (!sym) return null;

    const table = await this.loadTable();
    const row = table.bySymbol.get(sym);
    if (!row) return null;
    return toPartialProfile(row);
  }

  private async loadTable(): Promise<LoadedTable> {
    const nowMs = this.now().getTime();

    if (this.memo && nowMs - this.memo.fetchedAtMs < this.cacheTtlMs) {
      return this.memo;
    }

    const disk = await this.readCache();
    const diskFresh = disk && nowMs - disk.fetchedAtMs < this.cacheTtlMs;
    if (diskFresh) {
      this.memo = disk;
      return disk;
    }

    try {
      const fetched = await this.fetchAndParse();
      await this.writeCache(fetched);
      this.memo = fetched;
      return fetched;
    } catch (err) {
      if (disk) {
        this.logger.warn('nasdaq-trader: network refresh failed; using stale cache', {
          error: err instanceof Error ? err.message : String(err),
          cacheFile: this.cacheFilePath(),
        });
        this.memo = disk;
        return disk;
      }
      throw err;
    }
  }

  private async fetchAndParse(): Promise<LoadedTable> {
    const listedUrl = this.opts.listedUrl ?? NASDAQ_LISTED_URL;
    const otherUrl = this.opts.otherListedUrl ?? OTHER_LISTED_URL;

    const [listedText, otherText] = await Promise.all([
      this.fetchText(listedUrl),
      this.fetchText(otherUrl),
    ]);

    const listedRows = parseNasdaqListedText(listedText, listedUrl, this.logger);
    const otherRows = parseOtherListedText(otherText, otherUrl, this.logger);

    const merged = new Map<string, NasdaqTickerRow>();
    for (const row of listedRows) {
      merged.set(row.symbol, row);
    }
    for (const row of otherRows) {
      if (!merged.has(row.symbol)) {
        merged.set(row.symbol, row);
      }
    }

    const rows = Array.from(merged.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
    const fetchedAt = this.now().toISOString();
    return {
      fetchedAtMs: Date.parse(fetchedAt),
      rows,
      bySymbol: new Map(rows.map((row) => [row.symbol, row] as const)),
    };
  }

  private async fetchText(url: string): Promise<string> {
    const resp = await this.opts.client.fetch(url, {
      headers: { Accept: 'text/plain, text/csv;q=0.9, */*;q=0.1' },
    });
    if (!resp.ok) {
      throw new Error(`nasdaq-trader: HTTP ${resp.status} fetching ${url}`);
    }
    return resp.text();
  }

  private cacheFilePath(): string {
    return join(this.cacheDir, CACHE_FILENAME);
  }

  private async readCache(): Promise<LoadedTable | null> {
    const file = this.cacheFilePath();
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn('nasdaq-trader: cache JSON parse failed; ignoring cache', { file });
      return null;
    }

    const payload = parseCachedTable(parsed);
    if (!payload) {
      this.logger.warn('nasdaq-trader: cache schema invalid; ignoring cache', { file });
      return null;
    }

    const fetchedAtMs = Date.parse(payload.fetchedAt);
    if (Number.isNaN(fetchedAtMs)) {
      this.logger.warn('nasdaq-trader: cache has invalid fetchedAt; ignoring cache', { file });
      return null;
    }

    return {
      fetchedAtMs,
      rows: payload.rows,
      bySymbol: new Map(payload.rows.map((row) => [row.symbol, row] as const)),
    };
  }

  private async writeCache(table: LoadedTable): Promise<void> {
    const file = this.cacheFilePath();
    await mkdir(this.cacheDir, { recursive: true });

    const payload: ParsedTable = {
      fetchedAt: new Date(table.fetchedAtMs).toISOString(),
      rows: table.rows,
    };

    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await rename(tmp, file);
    try {
      await chmod(file, 0o600);
    } catch {
      /* ignore */
    }
  }
}

export function createNasdaqTraderTickerSource(
  opts: NasdaqTraderTickerSourceOptions,
): TickerSource {
  return new NasdaqTraderTickerSource(opts);
}

export function parseNasdaqListedText(
  text: string,
  sourceUrl = NASDAQ_LISTED_URL,
  logger: NasdaqTraderSourceLogger = { warn: () => {} },
): NasdaqTickerRow[] {
  const rows = parsePipeTable(text);
  const out: NasdaqTickerRow[] = [];

  for (const row of rows) {
    const symbol = normalizeSymbol(row['Symbol']);
    const name = normalizeName(row['Security Name']);
    const testIssue = normalizeFlag(row['Test Issue']);
    const etf = normalizeFlag(row.ETF);

    if (!symbol || !name) continue;
    if (testIssue === 'Y') continue;

    out.push({
      symbol,
      name,
      exchange: 'NASDAQ',
      securityType: etf === 'Y' ? 'ETF' : 'Common Stock',
      sourceUrl,
    });
  }

  if (out.length === 0) {
    logger.warn('nasdaq-trader: nasdaqlisted parse produced no rows', { sourceUrl });
  }
  return out;
}

export function parseOtherListedText(
  text: string,
  sourceUrl = OTHER_LISTED_URL,
  logger: NasdaqTraderSourceLogger = { warn: () => {} },
): NasdaqTickerRow[] {
  const rows = parsePipeTable(text);
  const out: NasdaqTickerRow[] = [];

  for (const row of rows) {
    const symbol = normalizeSymbol(row['ACT Symbol']);
    const name = normalizeName(row['Security Name']);
    const exchange = mapOtherListedExchange(row.Exchange);
    const testIssue = normalizeFlag(row['Test Issue']);
    const etf = normalizeFlag(row.ETF);

    if (!symbol || !name || !exchange) continue;
    if (testIssue === 'Y') continue;

    out.push({
      symbol,
      name,
      exchange,
      securityType: etf === 'Y' ? 'ETF' : 'Common Stock',
      sourceUrl,
    });
  }

  if (out.length === 0) {
    logger.warn('nasdaq-trader: otherlisted parse produced no rows', { sourceUrl });
  }
  return out;
}

function toPartialProfile(row: NasdaqTickerRow): PartialTickerProfileT {
  return PartialTickerProfile.parse({
    symbol: row.symbol,
    name: row.name,
    exchange: row.exchange,
    description: `${row.securityType} listing from Nasdaq Trader symbol directory.`,
    sourceUrls: [row.sourceUrl],
  });
}

function scorePrefixMatch(
  row: NasdaqTickerRow,
  queryUpper: string,
  queryLower: string,
): number | null {
  if (row.symbol === queryUpper) return 0;
  if (row.symbol.startsWith(queryUpper)) return 1;
  if (row.name.toLowerCase().startsWith(queryLower)) return 2;
  return null;
}

function parsePipeTable(text: string): Array<Record<string, string>> {
  const lines = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return [];
  const headerLine = lines[0];
  if (!headerLine) return [];

  const headers = headerLine.split('|').map((h) => h.trim());
  if (headers.length === 0) return [];

  const out: Array<Record<string, string>> = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('File Creation Time')) break;
    const cols = line.split('|');
    if (cols.length < headers.length) continue;

    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i += 1) {
      const key = headers[i];
      if (!key) continue;
      row[key] = (cols[i] ?? '').trim();
    }
    out.push(row);
  }
  return out;
}

function normalizeName(input: string | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

function normalizeFlag(input: string | undefined): 'Y' | 'N' | null {
  if (typeof input !== 'string') return null;
  const v = input.trim().toUpperCase();
  if (v === 'Y' || v === 'N') return v;
  return null;
}

function normalizeSymbol(input: string | undefined): string | null {
  if (typeof input !== 'string') return null;
  const sym = input.trim().toUpperCase();
  if (!/^[A-Z.\-]{1,10}$/.test(sym)) return null;
  return sym;
}

function mapOtherListedExchange(input: string | undefined): string | null {
  if (typeof input !== 'string') return null;
  const key = input.trim().toUpperCase();
  if (key.length === 0) return null;
  const mapped = EXCHANGE_CODE_MAP[key];
  if (mapped) return mapped;
  if (/^[A-Z0-9]{1,16}$/.test(key)) return key;
  return null;
}

function parseCachedTable(payload: unknown): ParsedTable | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;

  const fetchedAt = typeof root.fetchedAt === 'string' ? root.fetchedAt : null;
  const rows = Array.isArray(root.rows) ? root.rows : null;
  if (!fetchedAt || !rows) return null;

  const parsedRows: NasdaqTickerRow[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') return null;
    const row = raw as Record<string, unknown>;
    const symbol = normalizeSymbol(typeof row.symbol === 'string' ? row.symbol : undefined);
    const name = normalizeName(typeof row.name === 'string' ? row.name : undefined);
    const exchange =
      typeof row.exchange === 'string' && row.exchange.trim().length > 0
        ? row.exchange.trim().toUpperCase()
        : null;
    const securityType = row.securityType;
    const sourceUrl = typeof row.sourceUrl === 'string' ? row.sourceUrl : null;

    if (!symbol || !name || !exchange || !sourceUrl) return null;
    if (securityType !== 'Common Stock' && securityType !== 'ETF') return null;

    parsedRows.push({
      symbol,
      name,
      exchange,
      securityType,
      sourceUrl,
    });
  }

  return { fetchedAt, rows: parsedRows };
}
