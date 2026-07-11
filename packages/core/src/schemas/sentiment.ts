import { z } from 'zod';
import { Ticker } from './index.js';

/**
 * Sources we currently poll for ticker mentions. Kept open-ended via an enum
 * so adding a new poller (#33, #34, #35, #36) only requires extending this
 * list. The store dedupes mentions by `(source, sourceId)`.
 */
export const SentimentSource = z.enum([
  'reddit',
  'stocktwits',
  'hn',
  'cnn',
  'google-news',
]);
export type SentimentSource = z.infer<typeof SentimentSource>;

export const SentimentLabel = z.enum(['bearish', 'neutral', 'bullish']);
export type SentimentLabel = z.infer<typeof SentimentLabel>;

/**
 * A raw mention of a ticker harvested from a public source.
 *
 * Privacy: we deliberately do **not** persist authors / usernames /
 * subreddits-as-handles. The store enforces this at the schema level — there
 * is simply no field for it. `text` is the short excerpt or title used by the
 * scorer; if you want to drop a long body, truncate at the poller.
 */
export const MentionItem = z.object({
  source: SentimentSource,
  /**
   * Stable per-source id used for dedup. e.g. Reddit post id, StockTwits
   * message id, HN story id, news article url-hash. Required.
   */
  sourceId: z.string().min(1),
  symbol: Ticker,
  url: z.string().url().optional(),
  title: z.string().optional(),
  /** Short excerpt or body used by the scorer. No author / username. */
  text: z.string(),
  /** ISO timestamp from the upstream source. */
  publishedAt: z.string(),
  /** ISO timestamp when the poller ingested the item. */
  fetchedAt: z.string(),
  /**
   * Optional per-source metadata that the AI sentiment scorer can use as a
   * prior. Kept strictly non-PII: no authors, usernames, or handles. Pollers
   * may populate `sentimentLabel` when the upstream surface self-declares a
   * bullish / bearish / neutral tag (e.g. StockTwits messages).
   */
  meta: z
    .object({
      sentimentLabel: SentimentLabel.optional(),
    })
    .partial()
    .optional(),
});
export type MentionItem = z.infer<typeof MentionItem>;

/**
 * A mention plus the AI sentiment scorer's verdict. `score` is signed and
 * unitless — negative is bearish, positive is bullish. `confidence` is the
 * model's reported confidence in `[0, 1]`.
 */
export const ScoredMention = MentionItem.extend({
  sentiment: z.object({
    score: z.number().min(-1).max(1),
    confidence: z.number().min(0).max(1),
    label: SentimentLabel,
    /**
     * Short human-readable justification from the scorer, capped at 240
     * chars so it fits alongside the mention text in the dashboard
     * mention rail (#40) without pushing it around. Optional so
     * pre-#37 fixtures and non-LLM scorers keep validating.
     */
    rationale: z.string().max(240).optional(),
  }),
  scoredAt: z.string(),
  /**
   * Provenance for the sentiment verdict (issue #37). Records which
   * scorer produced the sentiment so we can recompute when the prompt,
   * model, or provider changes. `version` is a monotonically-bumped tag
   * owned by the scorer implementation (e.g. `ai-sentiment-scorer@1`).
   * Optional so pre-#37 fixtures and future non-LLM scorers (FinBERT,
   * etc.) that don't need provider/model can omit them.
   */
  scorer: z
    .object({
      provider: z.string().min(1),
      model: z.string().min(1),
      version: z.string().min(1),
    })
    .optional(),
});
export type ScoredMention = z.infer<typeof ScoredMention>;

/**
 * Per-source aggregate inside a `SentimentSnapshot`. Volume is the raw count
 * of scored mentions used to compute the weighted average.
 */
export const SentimentBySource = z.object({
  score: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  volume: z.number().int().nonnegative(),
});
export type SentimentBySource = z.infer<typeof SentimentBySource>;

/**
 * Aggregate sentiment for a symbol over a defined window. Emitted by the
 * aggregator job (#38) and consumed by the dashboard surfaces (#40) and the
 * recommender context (#42, #46).
 */
export const SentimentSnapshot = z.object({
  symbol: Ticker,
  /** ISO timestamp when the aggregate was computed. */
  asOf: z.string(),
  /** Aggregate signed score in [-1, 1] (confidence-weighted mean). */
  score: z.number().min(-1).max(1),
  /** Mean confidence across contributing mentions in [0, 1]. */
  confidence: z.number().min(0).max(1),
  /** Total scored mentions that contributed. */
  volume: z.number().int().nonnegative(),
  /** Per-source breakdown. Missing sources mean "no contribution". */
  bySource: z.record(SentimentSource, SentimentBySource).default({}),
});
export type SentimentSnapshot = z.infer<typeof SentimentSnapshot>;
