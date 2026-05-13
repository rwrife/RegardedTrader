import yahooFinance from 'yahoo-finance2';
import type { OHLCV, Quote, NewsItem, OptionContract } from '../schemas/index.js';

export * from './web-search.js';

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
      const map = (c: any, type: 'call' | 'put'): OptionContract => ({
        symbol: c.contractSymbol,
        underlying: symbol,
        expiry: new Date(c.expiration).toISOString().slice(0, 10),
        strike: c.strike,
        type,
        bid: c.bid ?? null,
        ask: c.ask ?? null,
        last: c.lastPrice ?? null,
        volume: c.volume ?? null,
        openInterest: c.openInterest ?? null,
        iv: c.impliedVolatility ?? null,
      });
      return [
        ...(chain.calls ?? []).map((c: any) => map(c, 'call')),
        ...(chain.puts ?? []).map((c: any) => map(c, 'put')),
      ];
    } catch {
      return [];
    }
  }
}
