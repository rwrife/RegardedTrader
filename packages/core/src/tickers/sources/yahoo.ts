/**
 * Yahoo Finance ticker source (issue #10).
 *
 * Implements `TickerSource` on top of Yahoo's public JSON endpoints:
 *
 *   search(q)     → https://query2.finance.yahoo.com/v1/finance/search
 *                    ?q=<q>&quotesCount=10&newsCount=0
 *   fetch(sym)    → https://query2.finance.yahoo.com/v10/finance/quoteSummary/<sym>
 *                    ?modules=assetProfile,summaryDetail,price
 *
 * Extracts symbol, canonical name (longName → shortName → search "shortname"),
 * exchange (mapped from `fullExchangeName`/`exchange`), sector, industry, and
 * description (`longBusinessSummary`). Malformed rows are logged and dropped,
 * matching the "logs+drops malformed entries instead of throwing" rule from
 * the acceptance criteria.
 *
 * Network is injected via `PoliteFetchClient` (same as the other Yahoo
 * consumers in this package) so tests never touch real HTTP.
 *
 * Default weight: 0.9 — Yahoo is a broad, generally-authoritative source for
 * US equity metadata; SEC EDGAR (#12) will outrank it for name normalisation
 * once it lands.
 *
 * Note: the resolver's `PartialTickerProfile` schema only accepts symbol,
 * name, exchange, sector, industry, description, and sourceUrls. Fields
 * mentioned in the original acceptance (currency, country, website,
 * `type` enum) are not part of the current profile schema; extending the
 * schema is intentionally out of scope for this issue to avoid churning the
 * resolver contract on unrelated fields.
 *
 * Endpoints last verified: 2026-07-05.
 */

import type { PoliteFetchClient } from '../http.js';
import type { TickerSource } from '../source.js';
import type { PartialTickerProfile } from '../../schemas/ticker.js';
import { PartialTickerProfile as PartialTickerProfileSchema } from '../../schemas/ticker.js';

export const YAHOO_SEARCH_URL = 'https://query2.finance.yahoo.com/v1/finance/search';
export const YAHOO_QUOTE_SUMMARY_BASE =
  'https://query2.finance.yahoo.com/v10/finance/quoteSummary';

const YAHOO_QUOTE_SUMMARY_MODULES = 'assetProfile,summaryDetail,price';
const YAHOO_SEARCH_QUOTES_COUNT = 10;

/**
 * Reasonable set of exchange labels the resolver expects; Yahoo returns a mix
 * of `fullExchangeName` strings ("NasdaqGS", "NYSE", "NYSEArca") and shorter
 * `exchange` codes ("NMS", "NYQ", "PCX"). Normalise both into a small set.
 */
const EXCHANGE_ALIASES: Record<string, string> = {
  // fullExchangeName
  NASDAQGS: 'NASDAQ',
  NASDAQGM: 'NASDAQ',
  NASDAQCM: 'NASDAQ',
  NASDAQ: 'NASDAQ',
  NYSE: 'NYSE',
  NYSEARCA: 'NYSEARCA',
  NYSEAMERICAN: 'NYSEAMERICAN',
  BATS: 'BATS',
  OTCMARKETS: 'OTC',
  OTC: 'OTC',
  // short `exchange` codes
  NMS: 'NASDAQ',
  NGM: 'NASDAQ',
  NCM: 'NASDAQ',
  NAS: 'NASDAQ',
  NYQ: 'NYSE',
  PCX: 'NYSEARCA',
  ASE: 'NYSEAMERICAN',
  BTS: 'BATS',
  PNK: 'OTC',
};

export type YahooSourceLogger = {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
};

export interface YahooTickerSourceOptions {
  client: PoliteFetchClient;
  /** Optional weight override; default 0.9 per acceptance. */
  weight?: number;
  /** Optional endpoint overrides (used by tests). */
  searchUrl?: string;
  quoteSummaryBase?: string;
  /** Optional logger; defaults to a no-op. */
  logger?: YahooSourceLogger;
}

const DEFAULT_WEIGHT = 0.9;

class YahooTickerSource implements TickerSource {
  readonly name = 'yahoo';
  readonly weight: number;

  constructor(private readonly opts: YahooTickerSourceOptions) {
    const w = opts.weight ?? DEFAULT_WEIGHT;
    if (!Number.isFinite(w) || w < 0 || w > 1) {
      throw new Error(`YahooTickerSource: weight must be in [0, 1]; got ${w}`);
    }
    this.weight = w;
  }

  async search(query: string): Promise<PartialTickerProfile[]> {
    const q = query.trim();
    if (q.length === 0) return [];
    const base = this.opts.searchUrl ?? YAHOO_SEARCH_URL;
    const url = `${base}?q=${encodeURIComponent(q)}&quotesCount=${YAHOO_SEARCH_QUOTES_COUNT}&newsCount=0`;
    const logger = this.opts.logger ?? { warn: () => {} };

    const resp = await this.opts.client.fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      throw new Error(`yahoo-ticker: HTTP ${resp.status} fetching ${url}`);
    }
    let json: unknown;
    try {
      json = await resp.json();
    } catch (err) {
      throw new Error(
        `yahoo-ticker: invalid JSON from search for "${q}": ${(err as Error).message}`,
      );
    }
    return parseYahooSearch(json, { query: q, logger });
  }

  async fetch(symbol: string): Promise<PartialTickerProfile | null> {
    const sym = symbol.trim().toUpperCase();
    if (sym.length === 0) return null;
    const base = this.opts.quoteSummaryBase ?? YAHOO_QUOTE_SUMMARY_BASE;
    const url = `${base}/${encodeURIComponent(sym)}?modules=${YAHOO_QUOTE_SUMMARY_MODULES}`;
    const logger = this.opts.logger ?? { warn: () => {} };

    const resp = await this.opts.client.fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(`yahoo-ticker: HTTP ${resp.status} fetching ${url}`);
    }
    let json: unknown;
    try {
      json = await resp.json();
    } catch (err) {
      throw new Error(
        `yahoo-ticker: invalid JSON from quoteSummary for ${sym}: ${(err as Error).message}`,
      );
    }
    return parseYahooQuoteSummary(json, { symbol: sym, logger });
  }
}

/** Factory. Prefer this over `new YahooTickerSource(...)` — keeps the class private. */
export function createYahooTickerSource(opts: YahooTickerSourceOptions): TickerSource {
  return new YahooTickerSource(opts);
}

// ---------------------------------------------------------------------------
// Parsers (pure, exported for tests)
// ---------------------------------------------------------------------------

export interface YahooSearchParseOptions {
  query: string;
  logger?: YahooSourceLogger;
}

/**
 * Parse the response body of `/v1/finance/search`. Drops entries that are not
 * equities or that lack a usable symbol/name. Never throws on a single bad row.
 */
export function parseYahooSearch(
  json: unknown,
  opts: YahooSearchParseOptions,
): PartialTickerProfile[] {
  const logger = opts.logger ?? { warn: () => {} };
  const out: PartialTickerProfile[] = [];
  if (!json || typeof json !== 'object') {
    logger.warn('yahoo-ticker: search response is not an object', { query: opts.query });
    return out;
  }
  const root = json as Record<string, unknown>;
  const quotes = Array.isArray(root.quotes) ? root.quotes : null;
  if (!quotes) {
    logger.warn('yahoo-ticker: search response missing quotes[]', { query: opts.query });
    return out;
  }

  for (const raw of quotes) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const quoteType = readString(row.quoteType);
    if (!isEquityQuoteType(quoteType)) continue;

    const symbol = normaliseSymbol(readString(row.symbol));
    if (!symbol) continue;
    const name = readString(row.longname) ?? readString(row.shortname);
    if (!name) continue;

    const exchange =
      mapExchange(readString(row.exchDisp)) ??
      mapExchange(readString(row.exchange)) ??
      null;
    if (!exchange) continue;

    const industry = readString(row.industry) ?? null;
    const sector = readString(row.sector) ?? null;

    const partial: PartialTickerProfile = {
      symbol,
      name,
      exchange,
      ...(sector ? { sector } : {}),
      ...(industry ? { industry } : {}),
      sourceUrls: [buildSearchUrl(opts.query)],
    };
    const parsed = PartialTickerProfileSchema.safeParse(partial);
    if (!parsed.success) {
      logger.warn('yahoo-ticker: search row failed validation', {
        query: opts.query,
        symbol,
        issues: parsed.error.issues.map((i) => i.message),
      });
      continue;
    }
    out.push(parsed.data);
  }
  return out;
}

export interface YahooQuoteSummaryParseOptions {
  symbol: string;
  logger?: YahooSourceLogger;
}

/**
 * Parse the response body of `/v10/finance/quoteSummary/{SYM}`. Returns
 * `null` when the upstream reports an error, when no `result[0]` is present,
 * or when the row cannot yield the required fields (symbol + name +
 * exchange). Never throws.
 */
export function parseYahooQuoteSummary(
  json: unknown,
  opts: YahooQuoteSummaryParseOptions,
): PartialTickerProfile | null {
  const logger = opts.logger ?? { warn: () => {} };
  const sym = opts.symbol.trim().toUpperCase();
  if (!json || typeof json !== 'object') {
    logger.warn('yahoo-ticker: quoteSummary response is not an object', { symbol: sym });
    return null;
  }
  const root = json as Record<string, unknown>;
  const summary = root.quoteSummary as Record<string, unknown> | undefined;
  if (!summary) {
    logger.warn('yahoo-ticker: quoteSummary missing envelope', { symbol: sym });
    return null;
  }
  if (summary.error) {
    logger.warn('yahoo-ticker: quoteSummary upstream error', {
      symbol: sym,
      error: summary.error,
    });
    return null;
  }
  const results = Array.isArray(summary.result) ? summary.result : [];
  const first = results[0] as Record<string, unknown> | undefined;
  if (!first) return null;

  const price = first.price as Record<string, unknown> | undefined;
  const assetProfile = first.assetProfile as Record<string, unknown> | undefined;

  const symbol = normaliseSymbol(readString(price?.symbol) ?? sym);
  if (!symbol) return null;

  const name = readString(price?.longName) ?? readString(price?.shortName);
  if (!name) {
    logger.warn('yahoo-ticker: quoteSummary missing name', { symbol: sym });
    return null;
  }

  const quoteType = readString(price?.quoteType);
  if (quoteType && !isEquityQuoteType(quoteType)) {
    logger.warn('yahoo-ticker: quoteSummary is not an equity', {
      symbol: sym,
      quoteType,
    });
    return null;
  }

  const exchange =
    mapExchange(readString(price?.fullExchangeName)) ??
    mapExchange(readString(price?.exchangeName)) ??
    mapExchange(readString(price?.exchange));
  if (!exchange) {
    logger.warn('yahoo-ticker: quoteSummary missing recognisable exchange', {
      symbol: sym,
    });
    return null;
  }

  const sector = readString(assetProfile?.sector) ?? null;
  const industry = readString(assetProfile?.industry) ?? null;
  const description = readString(assetProfile?.longBusinessSummary) ?? null;

  const partial: PartialTickerProfile = {
    symbol,
    name,
    exchange,
    ...(sector ? { sector } : {}),
    ...(industry ? { industry } : {}),
    ...(description ? { description } : {}),
    sourceUrls: [buildQuoteSummaryUrl(symbol)],
  };
  const parsed = PartialTickerProfileSchema.safeParse(partial);
  if (!parsed.success) {
    logger.warn('yahoo-ticker: quoteSummary failed validation', {
      symbol: sym,
      issues: parsed.error.issues.map((i) => i.message),
    });
    return null;
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Yahoo returns equities with `quoteType` `EQUITY`. Every other value (ETF,
 * MUTUALFUND, INDEX, CRYPTOCURRENCY, CURRENCY, FUTURE, OPTION) is dropped —
 * this source is only responsible for tickers as defined by the M1 goal.
 */
function isEquityQuoteType(qt: string | undefined): boolean {
  return typeof qt === 'string' && qt.toUpperCase() === 'EQUITY';
}

function normaliseSymbol(sym: string | undefined): string | null {
  if (!sym) return null;
  const upper = sym.trim().toUpperCase();
  if (upper.length === 0 || upper.length > 10) return null;
  // Resolver `Ticker` regex: /^[A-Z.\-]{1,10}$/
  if (!/^[A-Z.\-]+$/.test(upper)) return null;
  return upper;
}

function mapExchange(raw: string | undefined): string | null {
  if (!raw) return null;
  const key = raw.replace(/\s+/g, '').toUpperCase();
  const mapped = EXCHANGE_ALIASES[key];
  if (mapped) return mapped;
  // Pass-through anything that already looks like an exchange label (letters
  // + optional digits), so we don't silently drop rows for less-common
  // exchanges (e.g. TSX). Callers can filter downstream if needed.
  if (/^[A-Z0-9]{2,15}$/.test(key)) return key;
  return null;
}

function buildSearchUrl(query: string): string {
  return `${YAHOO_SEARCH_URL}?q=${encodeURIComponent(query)}&quotesCount=${YAHOO_SEARCH_QUOTES_COUNT}&newsCount=0`;
}

function buildQuoteSummaryUrl(symbol: string): string {
  return `${YAHOO_QUOTE_SUMMARY_BASE}/${encodeURIComponent(symbol)}?modules=${YAHOO_QUOTE_SUMMARY_MODULES}`;
}
