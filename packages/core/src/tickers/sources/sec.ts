/**
 * SEC EDGAR ticker source (issue #12).
 *
 * Data flow:
 *  1) Bootstrap issuer identity from `company_tickers.json` (cached 7 days)
 *     - https://www.sec.gov/files/company_tickers.json
 *  2) For fetch by symbol or CIK, enrich from submissions JSON
 *     - https://data.sec.gov/submissions/CIK{10-digit}.json
 *
 * Notes:
 *  - `PartialTickerProfile` now supports richer metadata (`cik`, `country`,
 *    `website`, etc.). This source still guarantees the core identity fields
 *    and may augment metadata over time without changing its external contract.
 *  - SEC asks clients to send a descriptive User-Agent with contact info. This
 *    source sends a SEC-specific User-Agent per request and also sets `From`.
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

export const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
export const SEC_SUBMISSIONS_BASE = 'https://data.sec.gov/submissions';

const DEFAULT_WEIGHT = 0.95;
const DEFAULT_TICKER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_OPERATOR_CONTACT = 'contact@example.invalid';
const CACHE_FILENAME = 'sec-company-tickers.v1.json';

export type SecEdgarSourceLogger = {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
};

export interface SecEdgarTickerSourceOptions {
  client: PoliteFetchClient;
  weight?: number;
  tickersUrl?: string;
  submissionsBase?: string;
  cacheDir?: string;
  tickerCacheTtlMs?: number;
  now?: () => Date;
  operatorContact?: string;
  logger?: SecEdgarSourceLogger;
}

export interface SecTickerDirectoryRow {
  symbol: string;
  name: string;
  cik: number;
  sourceUrl: string;
}

interface CachedTickerDirectory {
  fetchedAt: string;
  rows: SecTickerDirectoryRow[];
}

interface LoadedTickerDirectory {
  fetchedAtMs: number;
  rows: SecTickerDirectoryRow[];
  bySymbol: Map<string, SecTickerDirectoryRow>;
  byCik: Map<number, SecTickerDirectoryRow>;
}

interface ParsedSubmissionsProfile {
  symbol: string | null;
  name: string | null;
  cik: number | null;
  sicCode: string | null;
  sicDescription: string | null;
  exchange: string | null;
  country: string | null;
  website: string | null;
}

class SecEdgarTickerSource implements TickerSource {
  readonly name = 'sec-edgar';
  readonly weight: number;

  private memo: LoadedTickerDirectory | null = null;
  private readonly cacheDir: string;
  private readonly cacheTtlMs: number;
  private readonly now: () => Date;
  private readonly logger: SecEdgarSourceLogger;
  private readonly tickersUrl: string;
  private readonly submissionsBase: string;
  private readonly operatorContact: string;
  private readonly secUserAgent: string;

  constructor(private readonly opts: SecEdgarTickerSourceOptions) {
    const w = opts.weight ?? DEFAULT_WEIGHT;
    if (!Number.isFinite(w) || w < 0 || w > 1) {
      throw new Error(`SecEdgarTickerSource: weight must be in [0, 1]; got ${w}`);
    }
    this.weight = w;
    this.cacheDir = opts.cacheDir ?? join(configHome(), 'cache', 'symbols');
    this.cacheTtlMs = opts.tickerCacheTtlMs ?? DEFAULT_TICKER_CACHE_TTL_MS;
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger ?? { warn: () => {} };
    this.tickersUrl = opts.tickersUrl ?? SEC_TICKERS_URL;
    this.submissionsBase = opts.submissionsBase ?? SEC_SUBMISSIONS_BASE;
    this.operatorContact =
      normalizeContact(opts.operatorContact) ??
      normalizeContact(process.env.OPERATOR_CONTACT) ??
      DEFAULT_OPERATOR_CONTACT;
    this.secUserAgent = `RegardedTrader ${this.operatorContact}`;
  }

  async search(query: string): Promise<PartialTickerProfileT[]> {
    const q = query.trim();
    if (q.length === 0) return [];

    const directory = await this.loadDirectory();
    const qUpper = q.toUpperCase();
    const qLower = q.toLowerCase();

    const ranked = directory.rows
      .map((row) => ({ row, score: scorePrefixMatch(row, qUpper, qLower) }))
      .filter((item): item is { row: SecTickerDirectoryRow; score: number } => item.score !== null)
      .sort((a, b) => a.score - b.score || a.row.symbol.localeCompare(b.row.symbol))
      .slice(0, 25)
      .map((item) =>
        toDirectoryPartial(item.row, {
          tickersUrl: this.tickersUrl,
        }),
      );

    return ranked;
  }

  async fetch(symbolOrCik: string): Promise<PartialTickerProfileT | null> {
    const raw = symbolOrCik.trim();
    if (raw.length === 0) return null;

    const directory = await this.loadDirectory();
    const asCik = parsePossibleCik(raw);
    const asSymbol = normalizeSymbol(raw);

    let directoryRow: SecTickerDirectoryRow | undefined;
    let cik: number | null = null;

    if (asCik !== null) {
      cik = asCik;
      directoryRow = directory.byCik.get(asCik);
    } else if (asSymbol !== null) {
      directoryRow = directory.bySymbol.get(asSymbol);
      if (!directoryRow) return null;
      cik = directoryRow.cik;
    } else {
      return null;
    }

    if (cik === null) return null;

    const padded = padCik(cik);
    const submissionsUrl = `${this.submissionsBase}/CIK${padded}.json`;
    const submissionsJson = await this.fetchJson(submissionsUrl, { allow404: true });
    if (submissionsJson === null) return null;

    const parsed = parseSecSubmissionsProfile(submissionsJson, {
      sourceUrl: submissionsUrl,
      logger: this.logger,
    });

    const symbol =
      normalizeSymbol(directoryRow?.symbol) ??
      normalizeSymbol(parsed.symbol ?? undefined) ??
      normalizeSymbol(asSymbol ?? undefined);
    if (!symbol) {
      this.logger.warn('sec-edgar: submissions payload had no valid symbol', {
        input: symbolOrCik,
        cik,
      });
      return null;
    }

    const name =
      normalizeName(directoryRow?.name) ?? normalizeName(parsed.name ?? undefined) ?? symbol;

    const sicCode = parsed.sicCode;
    const sicDescription = parsed.sicDescription;
    const industry = formatIndustry(sicCode, sicDescription);
    const sector = mapSicToSector(sicCode);
    const exchange = normalizeExchange(parsed.exchange);
    const country = normalizeCountryCode(parsed.country);
    const website = normalizeUrl(parsed.website ?? undefined);

    const description = buildDescription({
      cik,
      sicCode,
      sicDescription,
      country,
      website,
    });

    const profile = PartialTickerProfile.safeParse({
      symbol,
      name,
      ...(exchange ? { exchange } : {}),
      ...(sector ? { sector } : {}),
      ...(industry ? { industry } : {}),
      ...(description ? { description } : {}),
      sourceUrls: uniqueUrls([
        this.tickersUrl,
        submissionsUrl,
      ]),
    });

    if (!profile.success) {
      this.logger.warn('sec-edgar: profile validation failed', {
        input: symbolOrCik,
        issues: profile.error.issues.map((i: { message: string }) => i.message),
      });
      return null;
    }

    return profile.data;
  }

  private cacheFilePath(): string {
    return join(this.cacheDir, CACHE_FILENAME);
  }

  private async loadDirectory(): Promise<LoadedTickerDirectory> {
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
      const json = await this.fetchJson(this.tickersUrl, { allow404: false });
      const rows = parseSecTickerDirectory(json, {
        sourceUrl: this.tickersUrl,
        logger: this.logger,
      });
      const fetchedAt = this.now().toISOString();
      const loaded = toLoadedDirectory({
        fetchedAt,
        rows,
      });
      await this.writeCache(loaded);
      this.memo = loaded;
      return loaded;
    } catch (err) {
      if (disk) {
        this.logger.warn('sec-edgar: refresh failed; using stale ticker directory cache', {
          error: err instanceof Error ? err.message : String(err),
          cacheFile: this.cacheFilePath(),
        });
        this.memo = disk;
        return disk;
      }
      throw err;
    }
  }

  private async fetchJson(url: string, opts: { allow404: boolean }): Promise<unknown | null> {
    const resp = await this.opts.client.fetch(url, {
      headers: {
        Accept: 'application/json',
        From: this.operatorContact,
      },
      userAgent: this.secUserAgent,
    });

    if (opts.allow404 && resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(`sec-edgar: HTTP ${resp.status} fetching ${url}`);
    }

    try {
      return await resp.json();
    } catch (err) {
      throw new Error(`sec-edgar: invalid JSON from ${url}: ${(err as Error).message}`);
    }
  }

  private async readCache(): Promise<LoadedTickerDirectory | null> {
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
      this.logger.warn('sec-edgar: cache JSON parse failed; ignoring cache', { file });
      return null;
    }

    const cached = parseCachedTickerDirectory(parsed);
    if (!cached) {
      this.logger.warn('sec-edgar: cache schema invalid; ignoring cache', { file });
      return null;
    }

    const fetchedAtMs = Date.parse(cached.fetchedAt);
    if (Number.isNaN(fetchedAtMs)) {
      this.logger.warn('sec-edgar: cache has invalid fetchedAt; ignoring cache', { file });
      return null;
    }

    return {
      fetchedAtMs,
      rows: cached.rows,
      bySymbol: new Map(cached.rows.map((row) => [row.symbol, row] as const)),
      byCik: new Map(cached.rows.map((row) => [row.cik, row] as const)),
    };
  }

  private async writeCache(directory: LoadedTickerDirectory): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });

    const payload: CachedTickerDirectory = {
      fetchedAt: new Date(directory.fetchedAtMs).toISOString(),
      rows: directory.rows,
    };

    const file = this.cacheFilePath();
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

export function createSecEdgarTickerSource(opts: SecEdgarTickerSourceOptions): TickerSource {
  return new SecEdgarTickerSource(opts);
}

export interface ParseSecTickerDirectoryOptions {
  sourceUrl?: string;
  logger?: SecEdgarSourceLogger;
}

/**
 * Parse SEC `company_tickers.json` into symbol/name/CIK rows.
 */
export function parseSecTickerDirectory(
  json: unknown,
  opts: ParseSecTickerDirectoryOptions = {},
): SecTickerDirectoryRow[] {
  const sourceUrl = opts.sourceUrl ?? SEC_TICKERS_URL;
  const logger = opts.logger ?? { warn: () => {} };

  if (!json || typeof json !== 'object') {
    logger.warn('sec-edgar: ticker directory payload is not an object', {
      sourceUrl,
    });
    return [];
  }

  const rows: SecTickerDirectoryRow[] = [];
  for (const entry of Object.values(json as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;

    const symbol = normalizeSymbol(typeof row.ticker === 'string' ? row.ticker : undefined);
    const name = normalizeName(typeof row.title === 'string' ? row.title : undefined);
    const cik = normalizeCik(
      typeof row.cik_str === 'number' || typeof row.cik_str === 'string'
        ? row.cik_str
        : undefined,
    );

    if (!symbol || !name || cik === null) continue;

    rows.push({
      symbol,
      name,
      cik,
      sourceUrl,
    });
  }

  rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return rows;
}

export interface ParseSecSubmissionsProfileOptions {
  sourceUrl?: string;
  logger?: SecEdgarSourceLogger;
}

/**
 * Parse SEC submissions JSON for issuer profile metadata.
 */
export function parseSecSubmissionsProfile(
  json: unknown,
  opts: ParseSecSubmissionsProfileOptions = {},
): ParsedSubmissionsProfile {
  const sourceUrl = opts.sourceUrl ?? SEC_SUBMISSIONS_BASE;
  const logger = opts.logger ?? { warn: () => {} };

  if (!json || typeof json !== 'object') {
    logger.warn('sec-edgar: submissions payload is not an object', {
      sourceUrl,
    });
    return {
      symbol: null,
      name: null,
      cik: null,
      sicCode: null,
      sicDescription: null,
      exchange: null,
      country: null,
      website: null,
    };
  }

  const root = json as Record<string, unknown>;
  const ticker = firstStringFromArray(root.tickers);
  const symbol = normalizeSymbol(ticker ?? undefined);
  const name = normalizeName(typeof root.name === 'string' ? root.name : undefined);
  const cik = normalizeCik(
    typeof root.cik === 'number' || typeof root.cik === 'string' ? root.cik : undefined,
  );

  const sicCode = normalizeSicCode(root.sic);
  const sicDescription = normalizeName(
    typeof root.sicDescription === 'string' ? root.sicDescription : undefined,
  );
  const exchange = firstStringFromArray(root.exchanges);

  const addresses =
    root.addresses && typeof root.addresses === 'object'
      ? (root.addresses as Record<string, unknown>)
      : null;
  const business =
    addresses?.business && typeof addresses.business === 'object'
      ? (addresses.business as Record<string, unknown>)
      : null;
  const mailing =
    addresses?.mailing && typeof addresses.mailing === 'object'
      ? (addresses.mailing as Record<string, unknown>)
      : null;

  const country =
    normalizeName(typeof business?.stateOrCountry === 'string' ? business.stateOrCountry : undefined) ??
    normalizeName(typeof mailing?.stateOrCountry === 'string' ? mailing.stateOrCountry : undefined);

  const website =
    normalizeUrl(typeof root.website === 'string' ? root.website : undefined) ??
    normalizeUrl(typeof root.investorWebsite === 'string' ? root.investorWebsite : undefined);

  return {
    symbol,
    name,
    cik,
    sicCode,
    sicDescription,
    exchange: exchange ?? null,
    country,
    website,
  };
}

/**
 * SEC CIKs must be represented as a 10-digit zero-padded string in the
 * submissions endpoint path.
 */
export function padCik(cik: number): string {
  if (!Number.isInteger(cik) || cik <= 0) {
    throw new Error(`sec-edgar: invalid CIK ${String(cik)}`);
  }
  return String(cik).padStart(10, '0');
}

/**
 * Map an SEC SIC code to a coarse sector bucket.
 */
export function mapSicToSector(sic: string | null): string | null {
  if (!sic) return null;
  const prefix = Number.parseInt(sic.slice(0, 2), 10);
  if (!Number.isFinite(prefix)) return null;

  if (prefix >= 1 && prefix <= 9) return 'Agriculture';
  if (prefix >= 10 && prefix <= 14) return 'Mining';
  if (prefix >= 15 && prefix <= 17) return 'Construction';
  if (prefix >= 20 && prefix <= 39) return 'Manufacturing';
  if (prefix >= 40 && prefix <= 49) return 'Transportation & Utilities';
  if (prefix >= 50 && prefix <= 51) return 'Wholesale Trade';
  if (prefix >= 52 && prefix <= 59) return 'Retail Trade';
  if (prefix >= 60 && prefix <= 67) return 'Finance';
  if (prefix >= 70 && prefix <= 89) return 'Services';
  if (prefix >= 91 && prefix <= 99) return 'Public Administration';
  return null;
}

function toLoadedDirectory(cache: CachedTickerDirectory): LoadedTickerDirectory {
  const fetchedAtMs = Date.parse(cache.fetchedAt);
  return {
    fetchedAtMs,
    rows: cache.rows,
    bySymbol: new Map(cache.rows.map((row) => [row.symbol, row] as const)),
    byCik: new Map(cache.rows.map((row) => [row.cik, row] as const)),
  };
}

function parseCachedTickerDirectory(payload: unknown): CachedTickerDirectory | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;

  const fetchedAt = typeof root.fetchedAt === 'string' ? root.fetchedAt : null;
  const rowsInput = Array.isArray(root.rows) ? root.rows : null;
  if (!fetchedAt || !rowsInput) return null;

  const rows: SecTickerDirectoryRow[] = [];
  for (const raw of rowsInput) {
    if (!raw || typeof raw !== 'object') return null;
    const row = raw as Record<string, unknown>;

    const symbol = normalizeSymbol(typeof row.symbol === 'string' ? row.symbol : undefined);
    const name = normalizeName(typeof row.name === 'string' ? row.name : undefined);
    const cik = normalizeCik(
      typeof row.cik === 'number' || typeof row.cik === 'string' ? row.cik : undefined,
    );
    const sourceUrl =
      typeof row.sourceUrl === 'string' && row.sourceUrl.trim().length > 0
        ? row.sourceUrl
        : null;

    if (!symbol || !name || cik === null || !sourceUrl) return null;

    rows.push({ symbol, name, cik, sourceUrl });
  }

  rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { fetchedAt, rows };
}

function toDirectoryPartial(
  row: SecTickerDirectoryRow,
  opts: { tickersUrl: string },
): PartialTickerProfileT {
  return PartialTickerProfile.parse({
    symbol: row.symbol,
    name: row.name,
    description: `SEC filer CIK ${padCik(row.cik)}.`,
    sourceUrls: uniqueUrls([opts.tickersUrl]),
  });
}

function normalizeSymbol(input: string | undefined): string | null {
  if (!input) return null;
  const sym = input.trim().toUpperCase();
  if (!/^[A-Z.\-]{1,10}$/.test(sym)) return null;
  return sym;
}

function normalizeName(input: string | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCik(input: number | string | undefined): number | null {
  if (input === undefined) return null;
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function normalizeSicCode(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return String(Math.trunc(raw)).padStart(4, '0');
  }
  if (typeof raw === 'string') {
    const digits = raw.trim().replace(/\D/g, '');
    if (digits.length === 0) return null;
    return digits.slice(0, 4).padStart(4, '0');
  }
  return null;
}

function normalizeCountryCode(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeExchange(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const key = trimmed.replace(/\s+/g, '').toUpperCase();
  const aliases: Record<string, string> = {
    NASDAQ: 'NASDAQ',
    NYSE: 'NYSE',
    NYSEARCA: 'NYSEARCA',
    NYSEMKT: 'NYSEAMERICAN',
    NYSEAMERICAN: 'NYSEAMERICAN',
  };
  return aliases[key] ?? key;
}

function normalizeUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizeContact(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePossibleCik(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d{1,10}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function firstStringFromArray(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) {
      return item.trim();
    }
  }
  return null;
}

function scorePrefixMatch(
  row: SecTickerDirectoryRow,
  queryUpper: string,
  queryLower: string,
): number | null {
  if (row.symbol === queryUpper) return 0;
  if (row.symbol.startsWith(queryUpper)) return 1;
  if (row.name.toLowerCase().startsWith(queryLower)) return 2;
  return null;
}

function formatIndustry(sicCode: string | null, sicDescription: string | null): string | null {
  if (!sicCode && !sicDescription) return null;
  if (sicCode && sicDescription) return `${sicCode} - ${sicDescription}`;
  return sicCode ?? sicDescription;
}

function buildDescription(opts: {
  cik: number;
  sicCode: string | null;
  sicDescription: string | null;
  country: string | null;
  website: string | null;
}): string {
  const bits: string[] = [`SEC filer CIK ${padCik(opts.cik)}.`];
  if (opts.sicCode) {
    bits.push(
      opts.sicDescription
        ? `SIC ${opts.sicCode}: ${opts.sicDescription}.`
        : `SIC ${opts.sicCode}.`,
    );
  }
  if (opts.country) bits.push(`Country: ${opts.country}.`);
  if (opts.website) bits.push(`Website: ${opts.website}.`);
  return bits.join(' ');
}

function uniqueUrls(urls: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}
