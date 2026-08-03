import yahooFinance from 'yahoo-finance2';
import type { NewsItem } from '../schemas/index.js';
import type { MarketDataClient } from './index.js';

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
  async headlines(symbol: string): Promise<NewsItem[]> {
    try {
      const search = await yahooFinance.search(symbol, { newsCount: 12 });
      return (search.news ?? []).map((n) => ({
        title: n.title,
        url: n.link,
        source: n.publisher ?? 'yahoo',
        publishedAt: new Date(Number(n.providerPublishTime ?? 0) * 1000).toISOString(),
      }));
    } catch {
      return [];
    }
  }
}

