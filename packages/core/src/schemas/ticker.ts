import { z } from 'zod';
import { Ticker } from './index.js';

/**
 * Per-source citation attached to resolved ticker profiles.
 *
 * `confidence` is a normalized contribution score in [0, 1] derived from the
 * source's configured resolver weight.
 */
export const TickerSourceAttribution = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type TickerSourceAttribution = z.infer<typeof TickerSourceAttribution>;

/**
 * Legacy source-tag format previously produced by `tickers/reconcile`:
 * `<source-name>:<source-url>`.
 */
const LegacySourceTag = z.string().min(1);

function parseLegacySourceTag(raw: string): TickerSourceAttribution {
  const trimmed = raw.trim();
  const splitAt = trimmed.indexOf(':');

  if (splitAt > 0) {
    const name = trimmed.slice(0, splitAt).trim();
    const maybeUrl = trimmed.slice(splitAt + 1).trim();
    if (maybeUrl.length > 0) {
      return {
        name: name.length > 0 ? name : 'legacy',
        url: maybeUrl,
        confidence: 0.5,
      };
    }
  }

  return {
    name: 'legacy',
    url: trimmed,
    confidence: 0.5,
  };
}

const TickerSources = z
  .array(z.union([TickerSourceAttribution, LegacySourceTag]))
  .transform((items): TickerSourceAttribution[] =>
    items.map((item) => (typeof item === 'string' ? parseLegacySourceTag(item) : item)),
  );

const NullableString = z.string().min(1).nullable().optional().default(null);
const NullableUrlString = z.string().url().nullable().optional().default(null);
const NullableDescription = z.string().max(600).nullable().optional().default(null);

/**
 * A validated ticker profile, produced by aggregating one or more
 * `TickerSource`s and reconciling their partial results.
 *
 * This extends the original M1 shape with richer metadata required by the
 * ticker-resolution epic (#7) while preserving compatibility fields
 * (`sourceUrls`, `validatedAt`) used by existing callers.
 */
export const TickerProfile = z.object({
  symbol: Ticker,
  name: z.string().min(1),
  exchange: z.string().min(1),

  /** Instrument metadata (nullable when sources do not provide a value). */
  type: NullableString,
  currency: NullableString,
  country: NullableString,
  sector: NullableString,
  industry: NullableString,
  cik: NullableString,
  isin: NullableString,
  cusip: NullableString,
  website: NullableUrlString,
  description: NullableDescription,
  logoUrl: NullableUrlString,

  /** Backward-compat source URL list retained for older consumers. */
  sourceUrls: z.array(z.string().url()),

  /**
   * `validatedAt` is kept for compatibility. New resolver output should also
   * populate `resolvedAt` with the same ISO timestamp.
   */
  validatedAt: z.string(),
  resolvedAt: z.string().optional(),

  /** Confidence in the reconciled profile in [0, 1]. */
  confidence: z.number().min(0).max(1),

  /** Structured source attributions with per-source confidence. */
  sources: TickerSources,

  /** Reconciliation notes (field disputes, tie-break rationale, etc.). */
  notes: z.array(z.string()).default([]),
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
