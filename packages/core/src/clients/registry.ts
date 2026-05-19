/**
 * Market-data provider registry (#91).
 *
 * Glue layer between `AppConfig.marketData` (user-facing config) and the
 * actual `MarketDataClient` instances used by the server / orchestrator.
 *
 * Capability-aware fallback chain:
 *   - Live quote: active provider → built-in Yahoo fallback.
 *   - History / options / news: active provider, but if it throws
 *     `FinnhubCapabilityError` we transparently fall through to Yahoo so the
 *     dashboard still works on a free Finnhub key.
 *
 * Tests can supply `buildClient` to inject mocks without monkey-patching.
 */
import type { MarketDataConfig, MarketDataProviderConfig } from '../schemas/marketData.js';
import type { MarketDataClient } from './index.js';
import { YahooClient } from './index.js';
import { FinnhubClient, FinnhubCapabilityError } from './finnhub.js';

export interface MarketDataRegistryOptions {
  /**
   * Optional override that builds a client from a provider config. Used by
   * tests to substitute mocks; production uses the default factory.
   */
  buildClient?: (cfg: MarketDataProviderConfig) => MarketDataClient;
  /**
   * Fallback used when the active provider doesn't support a capability or
   * when no active provider is configured. Defaults to a fresh `YahooClient`.
   */
  fallback?: MarketDataClient;
}

export interface MarketDataRegistry {
  /** The provider used for `MarketDataClient.quote()` and friends. */
  readonly client: MarketDataClient;
  /**
   * The provider used for the dashboard's live-quote polling. Returns the
   * Yahoo-shaped `YahooQuoteLike` payload that `liveQuote.ts` normalizes.
   * `null` if no active provider can serve quotes (caller should fall back
   * to the built-in Yahoo source).
   */
  readonly liveQuoteSource: ((symbol: string) => Promise<unknown>) | null;
  /** ID of the active provider, for telemetry and UI banners. */
  readonly activeId: string | null;
}

function defaultBuildClient(cfg: MarketDataProviderConfig): MarketDataClient {
  switch (cfg.kind) {
    case 'yahoo':
      return new YahooClient();
    case 'finnhub':
      return new FinnhubClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  }
}

/**
 * Wraps a primary client so that capability errors (e.g. Finnhub's free tier
 * not supporting history) transparently fall through to a fallback. Quote
 * calls do *not* fall through — if the user picked a primary provider, we
 * want real errors to surface so they know to fix their config.
 */
function withFallback(primary: MarketDataClient, fallback: MarketDataClient): MarketDataClient {
  const tryWithFallback = async <T>(
    op: (c: MarketDataClient) => Promise<T>,
  ): Promise<T> => {
    try {
      return await op(primary);
    } catch (e) {
      if (e instanceof FinnhubCapabilityError) {
        return op(fallback);
      }
      throw e;
    }
  };
  return {
    quote: (s) => primary.quote(s),
    history: (s, d) => tryWithFallback((c) => c.history(s, d)),
    news: (s) => tryWithFallback((c) => c.news(s)),
    optionsChain: (s, e) => tryWithFallback((c) => c.optionsChain(s, e)),
  };
}

export function createMarketDataRegistry(
  cfg: MarketDataConfig,
  opts: MarketDataRegistryOptions = {},
): MarketDataRegistry {
  const build = opts.buildClient ?? defaultBuildClient;
  const fallback = opts.fallback ?? new YahooClient();

  const activeId = cfg.activeProvider;
  const activeCfg = activeId ? cfg.providers[activeId] : undefined;

  if (!activeCfg) {
    // No active provider — everything goes through the fallback.
    return {
      client: fallback,
      liveQuoteSource: null,
      activeId: null,
    };
  }

  const primary = build(activeCfg);
  const client = withFallback(primary, fallback);

  let liveQuoteSource: ((symbol: string) => Promise<unknown>) | null = null;
  if (activeCfg.kind === 'finnhub' && primary instanceof FinnhubClient) {
    liveQuoteSource = (symbol) => primary.liveQuoteSource(symbol);
  }
  // Yahoo active-provider keeps the existing built-in source (caller handles).

  return { client, liveQuoteSource, activeId };
}
