/**
 * Finnhub market-data client (#91).
 *
 * Implements `MarketDataClient` against https://finnhub.io . The free tier
 * gives us:
 *   - `/quote` (real-time-ish US equities, 60 calls/min, no daily cap)
 *   - `/company-news`
 * History (`/stock/candle`) and options chains are paid-only as of 2024, so
 * we surface a clear error there and let the registry fall back to Yahoo.
 *
 * Why a hand-rolled `fetch` instead of `finnhub-ts` or similar: the official
 * client drags axios + a big surface area, and we only need three endpoints.
 */
import type { OHLCV, Quote, NewsItem, OptionContract } from '../schemas/index.js';
import type { MarketDataClient } from './index.js';

export interface FinnhubClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for asOf timestamps in tests. */
  now?: () => number;
}

/** Shape of Finnhub's /quote response. Field names are theirs, not ours. */
export interface FinnhubQuoteResponse {
  /** Current price */
  c: number;
  /** Change */
  d: number | null;
  /** Percent change */
  dp: number | null;
  /** High of the day */
  h: number;
  /** Low of the day */
  l: number;
  /** Open of the day */
  o: number;
  /** Previous close */
  pc: number;
  /** Unix timestamp (seconds) */
  t: number;
}

interface FinnhubNewsItem {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  image: string;
  related: string;
  source: string;
  summary: string;
  url: string;
}

/**
 * Error thrown when a paid Finnhub endpoint is requested on the free tier.
 * The registry catches this and falls back to a secondary provider.
 */
export class FinnhubCapabilityError extends Error {
  readonly capability: 'history' | 'options';
  constructor(capability: 'history' | 'options') {
    super(`Finnhub free tier does not include ${capability}; configure a fallback provider.`);
    this.name = 'FinnhubCapabilityError';
    this.capability = capability;
  }
}

export class FinnhubClient implements MarketDataClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: FinnhubClientOptions) {
    if (!opts.apiKey) throw new Error('FinnhubClient: apiKey is required');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://finnhub.io/api/v1').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams({ ...params, token: this.apiKey }).toString();
    const url = `${this.baseUrl}${path}?${qs}`;
    const res = await this.fetchImpl(url);
    if (res.status === 429) {
      throw new Error(`Finnhub rate-limited (HTTP 429) on ${path}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Finnhub authentication failed (HTTP ${res.status}) on ${path}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Finnhub HTTP ${res.status} on ${path}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async quote(symbol: string): Promise<Quote> {
    const q = await this.get<FinnhubQuoteResponse>('/quote', { symbol });
    // Finnhub returns all zeros for unknown symbols rather than 404-ing.
    if (q.c === 0 && q.pc === 0 && q.t === 0) {
      throw new Error(`Finnhub: unknown symbol "${symbol}"`);
    }
    const asOf = q.t > 0 ? new Date(q.t * 1000).toISOString() : new Date(this.now()).toISOString();
    return {
      symbol,
      price: q.c,
      change: q.d ?? 0,
      changePercent: q.dp ?? 0,
      // Finnhub /quote doesn't include volume — leave it as 0 rather than
      // making one up. Downstream consumers should treat 0 as "unknown".
      volume: 0,
      asOf,
    };
  }

  async history(_symbol: string, _days: number): Promise<OHLCV[]> {
    throw new FinnhubCapabilityError('history');
  }

  async news(symbol: string): Promise<NewsItem[]> {
    // /company-news requires a from/to date range. Pull the last 14 days,
    // which is what the existing Yahoo-backed news call effectively returns.
    const to = new Date(this.now());
    const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date): string => d.toISOString().slice(0, 10);
    const items = await this.get<FinnhubNewsItem[]>('/company-news', {
      symbol,
      from: fmt(from),
      to: fmt(to),
    });
    return items.slice(0, 10).map((n) => ({
      title: n.headline,
      url: n.url,
      source: n.source || 'finnhub',
      publishedAt: new Date(n.datetime * 1000).toISOString(),
    }));
  }

  async optionsChain(_symbol: string, _expiry?: string): Promise<OptionContract[]> {
    throw new FinnhubCapabilityError('options');
  }

  /**
   * Live-quote source adapter for the server's `liveQuoteSource` hook.
   * Returns the Yahoo-shaped `YahooQuoteLike` shape that `liveQuote.ts`
   * already knows how to project into our `LiveQuote` schema — keeps the
   * surface area small and lets us drop the adapter once we refactor
   * `liveQuote.ts` to take a `Quote` directly.
   */
  async liveQuoteSource(symbol: string): Promise<{
    symbol: string;
    regularMarketPrice: number;
    regularMarketChange: number;
    regularMarketChangePercent: number;
    currency: string;
    marketState: string;
    regularMarketTime: Date;
    regularMarketVolume: number | null;
    averageDailyVolume10Day: number | null;
  }> {
    const q = await this.get<FinnhubQuoteResponse>('/quote', { symbol });
    if (q.c === 0 && q.pc === 0 && q.t === 0) {
      throw new Error(`Finnhub: unknown symbol "${symbol}"`);
    }
    // Finnhub doesn't return a market-state enum; infer a reasonable value
    // from the timestamp freshness. `liveQuote.ts` normalizes unknown values
    // to 'CLOSED' anyway, so it's fine to leave it 'REGULAR' here and let
    // the client's `isUsMarketOpen()` heuristic override the polling cadence.
    return {
      symbol,
      regularMarketPrice: q.c,
      regularMarketChange: q.d ?? 0,
      regularMarketChangePercent: q.dp ?? 0,
      currency: 'USD',
      marketState: 'REGULAR',
      regularMarketTime: q.t > 0 ? new Date(q.t * 1000) : new Date(this.now()),
      regularMarketVolume: null,
      averageDailyVolume10Day: null,
    };
  }
}
