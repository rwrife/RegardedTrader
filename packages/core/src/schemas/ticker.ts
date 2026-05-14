import { z } from 'zod';
import { Ticker } from './index.js';

/**
 * A validated ticker profile, produced by aggregating one or more `TickerSource`s
 * and reconciling their partial results.
 *
 * Per the M1 epic (#1): canonical symbol, company name, exchange, sector,
 * industry, a 1-2 sentence description, source URLs, and a `validatedAt`
 * timestamp.
 */
export const TickerProfile = z.object({
  symbol: Ticker,
  name: z.string().min(1),
  exchange: z.string().min(1),
  sector: z.string().nullable(),
  industry: z.string().nullable(),
  description: z.string().nullable(),
  sourceUrls: z.array(z.string().url()),
  validatedAt: z.string(), // ISO timestamp
  /** Confidence in the reconciled profile in [0, 1]. */
  confidence: z.number().min(0).max(1),
  /** Names of the sources that contributed to this profile. */
  sources: z.array(z.string()),
});
export type TickerProfile = z.infer<typeof TickerProfile>;

/**
 * A partial profile, as returned by individual sources before reconciliation.
 * Every field is optional except `symbol` which is required for any non-empty
 * partial (sources that cannot determine a symbol should return `null` from
 * `fetch` or omit results from `search`).
 */
export const PartialTickerProfile = TickerProfile.partial().extend({
  symbol: Ticker,
});
export type PartialTickerProfile = z.infer<typeof PartialTickerProfile>;
