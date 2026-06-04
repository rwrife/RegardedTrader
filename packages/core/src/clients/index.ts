import yahooFinance from 'yahoo-finance2';
import type { OHLCV, Quote, NewsItem, OptionContract } from '../schemas/index.js';
import { YahooOptionContractRaw } from '../schemas/marketData.js';

export * from './web-search.js';
export * from './finnhub.js';
export * from './registry.js';

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

export class YahooClient implements MarketDataClient {
  async quote(symbol: string): Promise<Quote> {
    const q = await yahooFinance.quote(symbol);
    return {
      symbol,
      price: q.regularMarketPrice ?? 0,
      change: q.regularMarketChange ?? 0,
      changePercent: q.regularMarketChangePercent ?? 0,
      volume: q.regularMarketVolume ?? 0,
      marketCap: q.marketCap,
      asOf: new Date().toISOString(),
    };
  }

  async history(symbol: string, days: number): Promise<OHLCV[]> {
    const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await yahooFinance.historical(symbol, { period1, interval: '1d' });
    return rows.map((r) => ({
      t: r.date.toISOString().slice(0, 10),
      o: r.open,
      h: r.high,
      l: r.low,
      c: r.close,
      v: r.volume,
    }));
  }

  async news(symbol: string): Promise<NewsItem[]> {
    try {
      const search = await yahooFinance.search(symbol, { newsCount: 10 });
      return (search.news ?? []).map((n) => ({
        title: n.title,
        url: n.link,
        source: n.publisher ?? 'unknown',
        publishedAt: new Date(Number(n.providerPublishTime ?? 0) * 1000).toISOString(),
      }));
    } catch {
      return [];
    }
  }

  async optionsChain(symbol: string, expiry?: string): Promise<OptionContract[]> {
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
      return [...calls, ...puts];
    } catch {
      return [];
    }
  }
}
