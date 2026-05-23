/**
 * Yahoo Finance adapter for the quote poller (#22).
 *
 * Wraps `yahoo-finance2`'s `quote()` and `historical()` endpoints behind the
 * framework-free {@link QuoteSource} / {@link QuoteHistoryFetcher}
 * interfaces so the poller doesn't reach into any specific provider
 * directly.
 *
 * Schema-mirrors the existing {@link YahooClient} mapping in
 * `clients/index.ts` so a future migration to a shared `MarketDataClient`
 * doesn't change snapshot shapes on disk.
 */

import yahooFinance from 'yahoo-finance2';
import type { OHLCV, Quote } from '../../schemas/index.js';
import type { QuoteHistoryFetcher, QuoteSource } from './quote.js';

/** Build a Yahoo-backed {@link QuoteSource}. */
export function createYahooQuoteSource(): QuoteSource {
  return {
    name: 'yahoo',
    async quote(symbol: string): Promise<Quote> {
      const sym = symbol.toUpperCase();
      const q = await yahooFinance.quote(sym);
      return {
        symbol: sym,
        price: q.regularMarketPrice ?? 0,
        change: q.regularMarketChange ?? 0,
        changePercent: q.regularMarketChangePercent ?? 0,
        volume: q.regularMarketVolume ?? 0,
        marketCap: q.marketCap,
        asOf: new Date().toISOString(),
      };
    },
  };
}

/** Build a Yahoo-backed {@link QuoteHistoryFetcher}. */
export function createYahooHistoryFetcher(): QuoteHistoryFetcher {
  return {
    async history(symbol: string, days: number): Promise<OHLCV[]> {
      const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const rows = await yahooFinance.historical(symbol.toUpperCase(), {
        period1,
        interval: '1d',
      });
      return rows.map((r) => ({
        t: r.date.toISOString().slice(0, 10),
        o: r.open,
        h: r.high,
        l: r.low,
        c: r.close,
        v: r.volume,
      }));
    },
  };
}
