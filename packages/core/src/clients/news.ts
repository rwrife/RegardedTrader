import yahooFinance from 'yahoo-finance2';
import type { NewsItem } from '../schemas/index.js';
import type { MarketDataCache, MarketDataClient } from './index.js';

export interface NewsClient {
  headlines(symbol: string): Promise<NewsItem[]>;
}

/**
 * Default NewsClient adapter that reuses whichever market-data provider is
 * active in the server registry.
 */
export class MarketNewsClient implements NewsClient {
  constructor(private readonly market: MarketDataClient) {}
  headlines(symbol: string): Promise<NewsItem[]> {
    return this.market.news(symbol);
  }
}

/**
 * Pluggable yahoo-finance2 implementation for callers that want to bypass the
 * broader market-data client and fetch traditional headlines directly.
 */
export class YahooFinanceNewsClient implements NewsClient {
  constructor(private readonly cache?: MarketDataCache) {}

  async headlines(symbol: string): Promise<NewsItem[]> {
    const sym = symbol.toUpperCase();
    const hit = await this.cache?.get<NewsItem[]>('news', sym);
    if (hit) return hit;
    try {
      const search = await yahooFinance.search(symbol, { newsCount: 12 });
      const out = (search.news ?? []).map((n) => ({
        title: n.title,
        url: n.link,
        source: n.publisher ?? 'yahoo',
        publishedAt: new Date(Number(n.providerPublishTime ?? 0) * 1000).toISOString(),
      }));
      await this.cache?.set('news', sym, out);
      return out;
    } catch {
      return [];
    }
  }
}
