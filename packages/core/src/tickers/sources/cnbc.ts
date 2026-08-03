/**
 * CNBC ticker source (issue #13).
 *
 * Active CNBC quote lookup endpoint (JSON):
 *   https://quote.cnbc.com/quote-html-webservice/quote.htm?symbols=<SYM>&output=json
 *
 * This is the current public endpoint backing CNBC quote data. It replaced
 * older `ts-api.cnbc.com/harmony/app/bond-and-stock/...` paths referenced in
 * the issue body. Endpoint verification date: 2026-08-02.
 *
 * Notes:
 * - The source contract (`PartialTickerProfile`) does not currently expose
 *   dedicated `type` or `country` fields. We preserve these in `description`.
 * - CNBC sometimes uses feed suffixes like `.O` (NASDAQ) that are not part of
 *   canonical symbols elsewhere in the app. Known venue suffixes are stripped
 *   (e.g. `AAPL.O` -> `AAPL`) while class-share symbols like `BRK.B` are kept.
 */

import {
  PartialTickerProfile,
  type PartialTickerProfile as PartialTickerProfileT,
} from '../../schemas/ticker.js';
import type { PoliteFetchClient } from '../http.js';
import type { TickerSource } from '../source.js';

export const CNBC_QUOTE_LOOKUP_URL =
  'https://quote.cnbc.com/quote-html-webservice/quote.htm';
export const CNBC_QUOTE_PAGE_BASE = 'https://www.cnbc.com/quotes';

const DEFAULT_WEIGHT = 0.6;

const FEED_SUFFIXES = new Set(['O', 'OQ', 'N', 'A', 'P', 'PK']);

const EXCHANGE_ALIASES: Record<string, string> = {
  NASDAQ: 'NASDAQ',
  NASDAQGS: 'NASDAQ',
  NASDAQGM: 'NASDAQ',
  NASDAQCM: 'NASDAQ',
  NYSE: 'NYSE',
  'NYSE ARCA': 'NYSEARCA',
  NYSEARCA: 'NYSEARCA',
  'NYSE AMERICAN': 'NYSEAMERICAN',
  NYSEAMERICAN: 'NYSEAMERICAN',
  AMEX: 'NYSEAMERICAN',
  BATS: 'BATS',
  IEX: 'IEX',
  OTC: 'OTC',
};

export type CnbcSourceLogger = {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
};

export interface CnbcTickerSourceOptions {
  client: PoliteFetchClient;
  weight?: number;
  quoteLookupUrl?: string;
  quotePageBase?: string;
  logger?: CnbcSourceLogger;
}

export interface ParseCnbcQuoteResponseOptions {
  sourceUrl: string;
  requestedSymbol: string;
  logger?: CnbcSourceLogger;
}

interface ParsedCnbcQuoteRow {
  symbol: string;
  name: string;
  exchange: string;
  assetType: string | null;
  assetSubType: string | null;
  countryCode: string | null;
}

class CnbcTickerSource implements TickerSource {
  readonly name = 'cnbc';
  readonly weight: number;

  private readonly lookupUrl: string;
  private readonly quotePageBase: string;
  private readonly logger: CnbcSourceLogger;

  constructor(private readonly opts: CnbcTickerSourceOptions) {
    const w = opts.weight ?? DEFAULT_WEIGHT;
    if (!Number.isFinite(w) || w < 0 || w > 1) {
      throw new Error(`CnbcTickerSource: weight must be in [0, 1]; got ${w}`);
    }
    this.weight = w;
    this.lookupUrl = opts.quoteLookupUrl ?? CNBC_QUOTE_LOOKUP_URL;
    this.quotePageBase = opts.quotePageBase ?? CNBC_QUOTE_PAGE_BASE;
    this.logger = opts.logger ?? { warn: () => {} };
  }

  async search(query: string): Promise<PartialTickerProfileT[]> {
    const q = query.trim();
    if (q.length === 0) return [];

    const candidates = buildSearchCandidates(q);
    if (candidates.length === 0) return [];

    const out: PartialTickerProfileT[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
      const profile = await this.lookup(candidate);
      if (!profile) continue;
      if (seen.has(profile.symbol)) continue;
      seen.add(profile.symbol);
      out.push(profile);
    }

    const qUpper = q.toUpperCase();
    const qLower = q.toLowerCase();
    out.sort((a, b) => scoreSearchResult(a, qUpper, qLower) - scoreSearchResult(b, qUpper, qLower));

    return out.slice(0, 10);
  }

  async fetch(symbol: string): Promise<PartialTickerProfileT | null> {
    const normalized = normalizeLookupSymbol(symbol);
    if (!normalized) return null;
    return this.lookup(normalized);
  }

  private async lookup(symbol: string): Promise<PartialTickerProfileT | null> {
    const viaJson = await this.lookupViaJson(symbol);
    if (viaJson) return viaJson;
    return this.lookupViaQuotePage(symbol);
  }

  private async lookupViaJson(symbol: string): Promise<PartialTickerProfileT | null> {
    const url = buildQuoteLookupUrl(this.lookupUrl, symbol);
    const resp = await this.opts.client.fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (!resp.ok) {
      throw new Error(`cnbc-ticker: HTTP ${resp.status} fetching ${url}`);
    }

    let json: unknown;
    try {
      json = await resp.json();
    } catch (err) {
      throw new Error(
        `cnbc-ticker: invalid JSON from quote lookup for ${symbol}: ${(err as Error).message}`,
      );
    }

    const parsed = parseCnbcQuoteResponse(json, {
      sourceUrl: url,
      requestedSymbol: symbol,
      logger: this.logger,
    });
    if (!parsed) return null;
    return toPartialProfile(parsed, url);
  }

  private async lookupViaQuotePage(symbol: string): Promise<PartialTickerProfileT | null> {
    const url = `${this.quotePageBase.replace(/\/$/, '')}/${encodeURIComponent(symbol)}`;
    const resp = await this.opts.client.fetch(url, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });

    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(`cnbc-ticker: HTTP ${resp.status} fetching ${url}`);
    }

    const html = await resp.text();
    const parsed = parseCnbcQuotePageHtml(html, {
      sourceUrl: url,
      requestedSymbol: symbol,
      logger: this.logger,
    });
    if (!parsed) return null;
    return toPartialProfile(parsed, url);
  }
}

export function createCnbcTickerSource(opts: CnbcTickerSourceOptions): TickerSource {
  return new CnbcTickerSource(opts);
}

/**
 * Parse CNBC quote JSON from `quote.htm?symbols=<...>&output=json`.
 */
export function parseCnbcQuoteResponse(
  json: unknown,
  opts: ParseCnbcQuoteResponseOptions,
): ParsedCnbcQuoteRow | null {
  const logger = opts.logger ?? { warn: () => {} };
  if (!json || typeof json !== 'object') {
    logger.warn('cnbc-ticker: quote response is not an object', {
      requestedSymbol: opts.requestedSymbol,
      sourceUrl: opts.sourceUrl,
    });
    return null;
  }

  const root = json as Record<string, unknown>;
  const quickResult =
    root.QuickQuoteResult && typeof root.QuickQuoteResult === 'object'
      ? (root.QuickQuoteResult as Record<string, unknown>)
      : null;
  if (!quickResult) {
    logger.warn('cnbc-ticker: quote response missing QuickQuoteResult', {
      requestedSymbol: opts.requestedSymbol,
      sourceUrl: opts.sourceUrl,
    });
    return null;
  }

  const quickQuoteRaw = quickResult.QuickQuote;
  const first =
    Array.isArray(quickQuoteRaw) && quickQuoteRaw.length > 0
      ? quickQuoteRaw[0]
      : quickQuoteRaw;

  if (!first || typeof first !== 'object') {
    logger.warn('cnbc-ticker: quote response has no usable quote rows', {
      requestedSymbol: opts.requestedSymbol,
      sourceUrl: opts.sourceUrl,
    });
    return null;
  }

  const row = first as Record<string, unknown>;
  const code = parseRowCode(row.code);
  if (code !== null && code !== 0) return null;

  const symbol = normalizeReturnedSymbol(
    readString(row.symbol) ?? opts.requestedSymbol,
  );
  const name =
    readString(row.name) ?? readString(row.altName) ?? readString(row.shortName);
  const exchange = mapExchange(readString(row.exchange));

  if (!symbol || !name || !exchange) {
    logger.warn('cnbc-ticker: quote row missing required fields', {
      requestedSymbol: opts.requestedSymbol,
      sourceUrl: opts.sourceUrl,
      symbol,
      hasName: Boolean(name),
      exchange,
    });
    return null;
  }

  return {
    symbol,
    name,
    exchange,
    assetType: readString(row.assetType) ?? null,
    assetSubType: readString(row.assetSubType) ?? null,
    countryCode: normalizeCountryCode(readString(row.countryCode)) ?? null,
  };
}

export interface ParseCnbcQuotePageHtmlOptions {
  sourceUrl: string;
  requestedSymbol: string;
  logger?: CnbcSourceLogger;
}

/**
 * Fallback parser for CNBC quote pages when API responses are unavailable.
 */
export function parseCnbcQuotePageHtml(
  html: string,
  opts: ParseCnbcQuotePageHtmlOptions,
): ParsedCnbcQuoteRow | null {
  const logger = opts.logger ?? { warn: () => {} };
  const candidates = [
    opts.requestedSymbol.toUpperCase(),
    opts.requestedSymbol.toUpperCase().replace(/-/g, '.'),
    opts.requestedSymbol.toUpperCase().replace(/\./g, '-'),
  ];

  for (const candidate of candidates) {
    const token = `"symbol":"${escapeJsonString(candidate)}"`;
    const idx = html.indexOf(token);
    if (idx === -1) continue;

    const window = html.slice(idx, idx + 5000);
    const code = readJsonNumberField(window, 'code');
    if (code !== null && code !== 0) continue;

    const symbol = normalizeReturnedSymbol(readJsonStringField(window, 'symbol') ?? candidate);
    const name = readJsonStringField(window, 'name') ?? readJsonStringField(window, 'altName');
    const exchange = mapExchange(readJsonStringField(window, 'exchange'));

    if (!symbol || !name || !exchange) continue;

    return {
      symbol,
      name,
      exchange,
      assetType: readJsonStringField(window, 'assetType') ?? null,
      assetSubType: readJsonStringField(window, 'assetSubType') ?? null,
      countryCode: normalizeCountryCode(readJsonStringField(window, 'countryCode')) ?? null,
    };
  }

  logger.warn('cnbc-ticker: quote-page fallback parse failed', {
    requestedSymbol: opts.requestedSymbol,
    sourceUrl: opts.sourceUrl,
  });
  return null;
}

function toPartialProfile(
  row: ParsedCnbcQuoteRow,
  sourceUrl: string,
): PartialTickerProfileT {
  const details: string[] = [];
  if (row.assetSubType) details.push(row.assetSubType);
  else if (row.assetType) details.push(row.assetType);
  if (row.countryCode) details.push(`country ${row.countryCode}`);

  const description =
    details.length > 0
      ? `${details.join(', ')} from CNBC quote lookup.`
      : 'Profile from CNBC quote lookup.';

  return PartialTickerProfile.parse({
    symbol: row.symbol,
    name: row.name,
    exchange: row.exchange,
    description,
    sourceUrls: [sourceUrl],
  });
}

function scoreSearchResult(
  profile: PartialTickerProfileT,
  queryUpper: string,
  queryLower: string,
): number {
  const symbol = profile.symbol.toUpperCase();
  const name = (profile.name ?? '').toLowerCase();
  if (symbol === queryUpper) return 0;
  if (symbol.startsWith(queryUpper)) return 1;
  if (name.startsWith(queryLower)) return 2;
  if (name.includes(queryLower)) return 3;
  return 4;
}

function buildSearchCandidates(query: string): string[] {
  const upper = query.trim().toUpperCase().replace(/^\$/, '');
  if (!upper) return [];

  const raw = new Set<string>();
  raw.add(upper);
  raw.add(upper.replace(/\s+/g, ''));
  const firstToken = upper.split(/\s+/)[0];
  if (firstToken) raw.add(firstToken);

  for (const token of Array.from(raw)) {
    if (token.includes('-')) raw.add(token.replace(/-/g, '.'));
    if (token.includes('.')) raw.add(token.replace(/\./g, '-'));
  }

  const out: string[] = [];
  for (const candidate of Array.from(raw)) {
    const normalized = normalizeLookupSymbol(candidate);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function normalizeLookupSymbol(input: string): string | null {
  const trimmed = input.trim().toUpperCase();
  if (!trimmed) return null;
  if (!/^[A-Z.\-]{1,12}$/.test(trimmed)) return null;
  return trimmed;
}

function normalizeReturnedSymbol(input: string): string | null {
  const upper = input.trim().toUpperCase();
  if (!/^[A-Z.\-]{1,12}$/.test(upper)) return null;

  const parts = upper.split('.');
  if (parts.length === 2) {
    const base = parts[0] ?? '';
    const suffix = parts[1] ?? '';
    if (base.length > 0 && FEED_SUFFIXES.has(suffix)) {
      if (/^[A-Z.\-]{1,10}$/.test(base)) return base;
    }
  }

  if (!/^[A-Z.\-]{1,10}$/.test(upper)) return null;
  return upper;
}

function mapExchange(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  if (!cleaned) return null;

  const key = cleaned.replace(/\s+/g, ' ').toUpperCase();
  const mapped = EXCHANGE_ALIASES[key];
  if (mapped) return mapped;

  const compact = key.replace(/\s+/g, '');
  if (/^[A-Z0-9]{2,16}$/.test(compact)) return compact;
  return null;
}

function normalizeCountryCode(raw: string | undefined): string | null {
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return code;
}

function buildQuoteLookupUrl(base: string, symbol: string): string {
  const root = base.includes('?') ? base : `${base}?`;
  const sep = root.endsWith('?') || root.endsWith('&') ? '' : '&';
  return `${root}${sep}symbols=${encodeURIComponent(symbol)}&output=json`;
}

function readString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseRowCode(code: unknown): number | null {
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && code.trim().length > 0) {
    const n = Number.parseInt(code.trim(), 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function readJsonStringField(snippet: string, field: string): string | undefined {
  const re = new RegExp(`"${escapeRegExp(field)}":"([^"]*)"`);
  const m = re.exec(snippet);
  if (!m?.[1]) return undefined;
  return decodeJsonString(m[1]);
}

function readJsonNumberField(snippet: string, field: string): number | null {
  const re = new RegExp(`"${escapeRegExp(field)}":(?:"(-?\\d+)"|(-?\\d+))`);
  const m = re.exec(snippet);
  const raw = m?.[1] ?? m?.[2];
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function decodeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeJsonString(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
