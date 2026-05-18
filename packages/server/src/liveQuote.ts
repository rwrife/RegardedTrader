/**
 * Live-quote service: thin wrapper over yahoo-finance2's `quote()` that
 * coerces the upstream payload into our `QuoteSchema` shape. Kept separate
 * from the route handler so it's trivial to unit-test with a mocked source.
 */
import type { LiveQuote } from '@regardedtrader/core';

/**
 * Subset of yahoo-finance2's `Quote` we actually read. Declared structurally
 * so tests don't have to import the upstream type just to mock it.
 */
export interface YahooQuoteLike {
  symbol?: string;
  regularMarketPrice?: number | null;
  regularMarketChange?: number | null;
  regularMarketChangePercent?: number | null;
  currency?: string | null;
  marketState?: string | null;
  regularMarketTime?: Date | number | null;
}

export interface LiveQuoteSource {
  (symbol: string): Promise<YahooQuoteLike>;
}

const VALID_STATES = new Set([
  'REGULAR',
  'PRE',
  'POST',
  'CLOSED',
  'PREPRE',
  'POSTPOST',
]);

function normalizeMarketState(s: string | null | undefined): LiveQuote['marketState'] {
  if (s && VALID_STATES.has(s)) {
    return s as LiveQuote['marketState'];
  }
  return 'CLOSED';
}

function toIso(t: Date | number | null | undefined): string {
  if (t instanceof Date) return t.toISOString();
  if (typeof t === 'number') {
    // yahoo-finance2 returns seconds-since-epoch for some fields; assume ms if
    // the value is large enough to look like a millisecond timestamp.
    const ms = t > 1e12 ? t : t * 1000;
    return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

/**
 * Fetch a live quote for `symbol` via the provided source and project it into
 * the shape the web client expects. Schema validation is done by the caller.
 */
export async function liveQuote(source: LiveQuoteSource, symbol: string): Promise<LiveQuote> {
  const q = await source(symbol);
  return {
    symbol,
    price: q.regularMarketPrice ?? 0,
    change: q.regularMarketChange ?? 0,
    changePercent: q.regularMarketChangePercent ?? 0,
    currency: q.currency ?? 'USD',
    marketState: normalizeMarketState(q.marketState),
    asOf: toIso(q.regularMarketTime ?? null),
  };
}
