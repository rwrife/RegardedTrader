/**
 * Market-data provider registry (#91).
 *
 * Glue layer between `AppConfig.marketData` (user-facing config) and the
 * actual `MarketDataClient` instances used by the server / orchestrator.
 *
 * Single-provider model: when an active provider is configured, ALL market
 * data (quotes, history, options, news) goes through it. We deliberately do
 * NOT fall back to Yahoo on capability errors — Yahoo's endpoints are
 * unreliable (HTTP 429 rate-limiting hits us constantly) and silently
 * routing around the user's chosen provider hides real configuration
 * problems. If Finnhub's free tier doesn't expose history/options, that
 * should surface as a clear error in the UI, not a secret hit to a
 * different vendor.
 *
 * The `fallback` option is only used when NO active provider is configured;
 * it gives the server something to call so endpoints don't 500 before the
 * user has had a chance to set up Settings → Market Data.
 *
 * Tests can supply `buildClient` to inject mocks without monkey-patching.
 */
import type { MarketDataConfig, MarketDataProviderConfig } from '../schemas/marketData.js';
import type { MarketDataClient } from './index.js';
import { YahooClient } from './index.js';
import { FinnhubClient } from './finnhub.js';

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
 *
 * NOTE: Currently unused. The registry no longer chains providers — the
 * active provider is the only provider. Kept here intentionally so we can
 * revisit a user-opt-in "secondary fallback" feature later without
 * re-deriving the wrapper. Do not re-enable without an explicit config
 * surface that lets the user pick the fallback target.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _withFallback(_primary: MarketDataClient, _fallback: MarketDataClient): MarketDataClient {
  throw new Error('withFallback is disabled; see registry.ts header');
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
    // No active provider — everything goes through the fallback so the
    // server stays alive long enough for the user to configure one.
    return {
      client: fallback,
      liveQuoteSource: null,
      activeId: null,
    };
  }

  const primary = build(activeCfg);

  let liveQuoteSource: ((symbol: string) => Promise<unknown>) | null = null;
  if (activeCfg.kind === 'finnhub' && primary instanceof FinnhubClient) {
    liveQuoteSource = (symbol) => primary.liveQuoteSource(symbol);
  }
  // Yahoo active-provider keeps the existing built-in source (caller handles).

  // Use the active provider directly for everything. Capability errors (e.g.
  // Finnhub free-tier history) propagate to the route handler, which surfaces
  // them in the UI rather than silently routing to a different vendor.
  return { client: primary, liveQuoteSource, activeId };
}
