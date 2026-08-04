import yahooFinance from 'yahoo-finance2';
import type { OHLCV, Quote, NewsItem, OptionContract } from '../schemas/index.js';
import { YahooOptionContractRaw } from '../schemas/marketData.js';

export * from './web-search.js';
export * from './finnhub.js';
export * from './registry.js';
export * from './news.js';

/**
 * Coerce Yahoo's `expiration` field (Date | epoch seconds | ISO-ish string)
 * into a `YYYY-MM-DD` ET-naive date string. We treat the epoch as seconds
 * (yahoo-finance2 normalizes this) and fall back to `Date.parse` for
 * strings; on total failure we return an empty string so the caller can
 * decide whether to drop the leg.
 */
function normalizeYahooExpiry(raw: Date | number | string): string {
  let d: Date;
  if (raw instanceof Date) {
    d = raw;
  } else if (typeof raw === 'number') {
    // Yahoo emits epoch seconds; multiply if it looks like seconds.
    d = new Date(raw < 1e12 ? raw * 1000 : raw);
  } else {
    d = new Date(raw);
  }
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Map a single validated Yahoo options-chain leg into our internal
 * `OptionContract` shape. Exported so the test suite can exercise the
 * mapper without spinning up a `YahooClient`.
 */
export function mapYahooOptionContract(
  raw: YahooOptionContractRaw,
  underlying: string,
  type: 'call' | 'put',
): OptionContract {
  return {
    symbol: raw.contractSymbol,
    underlying,
    expiry: normalizeYahooExpiry(raw.expiration),
    strike: raw.strike,
    type,
    bid: raw.bid ?? null,
    ask: raw.ask ?? null,
    last: raw.lastPrice ?? null,
    volume: raw.volume ?? null,
    openInterest: raw.openInterest ?? null,
    iv: raw.impliedVolatility ?? null,
  };
}

export interface MarketDataClient {
  quote(symbol: string): Promise<Quote>;
  history(symbol: string, days: number): Promise<OHLCV[]>;
  news(symbol: string): Promise<NewsItem[]>;
  optionsChain(symbol: string, expiry?: string): Promise<OptionContract[]>;
}

export interface MarketDataCache {
  get<T>(namespace: string, key: string): Promise<T | undefined>;
  set<T>(namespace: string, key: string, value: T, opts?: { ttlMs?: number }): Promise<void>;
}

export class YahooClient implements MarketDataClient {
  constructor(private readonly cache?: MarketDataCache) {}

  async quote(symbol: string): Promise<Quote> {
    const sym = symbol.toUpperCase();
    const cacheKey = sym;
    const hit = await this.cache?.get<Quote>('quotes', cacheKey);
    if (hit) return hit;
    const q = await yahooFinance.quote(symbol);
    const out: Quote = {
      symbol: sym,
      price: q.regularMarketPrice ?? 0,
      change: q.regularMarketChange ?? 0,
      changePercent: q.regularMarketChangePercent ?? 0,
      volume: q.regularMarketVolume ?? 0,
      marketCap: q.marketCap,
      asOf: new Date().toISOString(),
    };
    await this.cache?.set('quotes', cacheKey, out);
    return out;
  }

  async history(symbol: string, days: number): Promise<OHLCV[]> {
    const sym = symbol.toUpperCase();
    const cacheKey = `${sym}:${days}`;
    const hit = await this.cache?.get<OHLCV[]>('history', cacheKey);
    if (hit) return hit;
    const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await yahooFinance.historical(symbol, { period1, interval: '1d' });
    const out = rows.map((r) => ({
      t: r.date.toISOString().slice(0, 10),
      o: r.open,
      h: r.high,
      l: r.low,
      c: r.close,
      v: r.volume,
    }));
    await this.cache?.set('history', cacheKey, out);
    return out;
  }

  async news(symbol: string): Promise<NewsItem[]> {
    const sym = symbol.toUpperCase();
    const cacheKey = sym;
    const hit = await this.cache?.get<NewsItem[]>('news', cacheKey);
    if (hit) return hit;
    try {
      const search = await yahooFinance.search(symbol, { newsCount: 10 });
      const out = (search.news ?? []).map((n) => ({
        title: n.title,
        url: n.link,
        source: n.publisher ?? 'unknown',
        publishedAt: new Date(Number(n.providerPublishTime ?? 0) * 1000).toISOString(),
      }));
      await this.cache?.set('news', cacheKey, out);
      return out;
    } catch {
      return [];
    }
  }

  async optionsChain(symbol: string, expiry?: string): Promise<OptionContract[]> {
    const sym = symbol.toUpperCase();
    const cacheKey = `${sym}:${expiry ?? 'next'}`;
    const hit = await this.cache?.get<OptionContract[]>('chain', cacheKey);
    if (hit) return hit;
    try {
      const opts = await yahooFinance.options(symbol, expiry ? { date: new Date(expiry) } : {});
      const chain = opts.options?.[0];
      if (!chain) return [];
      const validate = (legs: unknown[]): YahooOptionContractRaw[] => {
        const out: YahooOptionContractRaw[] = [];
        for (const leg of legs) {
          const parsed = YahooOptionContractRaw.safeParse(leg);
          if (parsed.success) out.push(parsed.data);
        }
        return out;
      };
      const calls = validate(chain.calls ?? []).map((leg) =>
        mapYahooOptionContract(leg, symbol, 'call'),
      );
      const puts = validate(chain.puts ?? []).map((leg) =>
        mapYahooOptionContract(leg, symbol, 'put'),
      );
      const out = [...calls, ...puts];
      await this.cache?.set('chain', cacheKey, out);
      return out;
    } catch {
      return [];
    }
  }
}
