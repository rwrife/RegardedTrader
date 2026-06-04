/**
 * Pluggable market-data provider config (#91).
 *
 * Lets the user wire up a real-time quote source independently of the AI
 * provider config. Today we ship two implementations — `yahoo` (the
 * scrape-based fallback that's been getting rate-limited into oblivion) and
 * `finnhub` (free tier: 60 calls/min, no daily cap, real-time US equities).
 *
 * Adding a new provider in the future means:
 *   1. Add a new `z.object({ kind: z.literal('newthing'), ... })` here.
 *   2. Append it to the `MarketDataProviderConfig` discriminated union.
 *   3. Implement `MarketDataClient` for it in `clients/<newthing>.ts`.
 *   4. Wire it into `createMarketDataClient()` in `clients/registry.ts`.
 *
 * No route handler / UI changes required.
 */
import { z } from 'zod';

export const YahooProviderConfig = z.object({
  kind: z.literal('yahoo'),
  label: z.string().min(1).default('Yahoo Finance'),
});
export type YahooProviderConfig = z.infer<typeof YahooProviderConfig>;

export const FinnhubProviderConfig = z.object({
  kind: z.literal('finnhub'),
  label: z.string().min(1).default('Finnhub'),
  /** Free-tier API key from https://finnhub.io/register . Stored locally, never logged. */
  apiKey: z.string().min(1),
  /** Override base URL for testing / self-hosted proxies. */
  baseUrl: z.string().url().default('https://finnhub.io/api/v1'),
});
export type FinnhubProviderConfig = z.infer<typeof FinnhubProviderConfig>;

export const MarketDataProviderConfig = z.discriminatedUnion('kind', [
  YahooProviderConfig,
  FinnhubProviderConfig,
]);
export type MarketDataProviderConfig = z.infer<typeof MarketDataProviderConfig>;

/**
 * Raw shape of a single Yahoo Finance options-chain leg (call or put) as
 * returned by `yahoo-finance2`'s `options()` call.
 *
 * `yahoo-finance2` types these as `{ [key: string]: any }` (its `CallOrPut`
 * interface), which forces unjustified `: any` casts at the consumption
 * site (issue #100). This schema captures the subset of fields the
 * `YahooClient.optionsChain` mapper actually consumes, so we can validate
 * upstream rows once and pass through a typed value the rest of `core`
 * (OptionsStrategist, risk-graph #76) can trust.
 *
 * Optional / nullable fields mirror Yahoo's actual behaviour — bid/ask,
 * volume, open-interest and IV are routinely missing on thin chains.
 * `expiration` is accepted as Date, number (epoch seconds), or string
 * because Yahoo has shipped all three over the years; we coerce to a
 * `YYYY-MM-DD` ISO date in the mapper.
 */
export const YahooOptionContractRaw = z.object({
  contractSymbol: z.string().min(1),
  strike: z.number(),
  expiration: z.union([z.date(), z.number(), z.string()]),
  bid: z.number().nullish(),
  ask: z.number().nullish(),
  lastPrice: z.number().nullish(),
  volume: z.number().int().nonnegative().nullish(),
  openInterest: z.number().int().nonnegative().nullish(),
  impliedVolatility: z.number().nullish(),
});
export type YahooOptionContractRaw = z.infer<typeof YahooOptionContractRaw>;

export const MarketDataConfig = z
  .object({
    /** Map of provider id (user-chosen) -> config. */
    providers: z.record(MarketDataProviderConfig).default({}),
    /**
     * Active provider id used for live quotes. `null` = use the implicit
     * built-in Yahoo fallback (which is what we shipped before #91).
     */
    activeProvider: z.string().nullable().default(null),
  })
  .default({ providers: {}, activeProvider: null });
export type MarketDataConfig = z.infer<typeof MarketDataConfig>;
