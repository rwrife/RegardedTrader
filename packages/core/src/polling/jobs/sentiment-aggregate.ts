/**
 * Sentiment aggregator job (#38, parent #30).
 *
 * Reads the last `windowMs` of `ScoredMention` records out of the
 * `MentionStore` for a given symbol, computes a confidence- and
 * source-weighted aggregate, persists a `SentimentSnapshot`, and emits a
 * `sentiment.update` event for the in-process event bus / SSE bridge.
 *
 * Weight per mention (per the issue spec):
 *
 *     weight = confidence × log1p(engagement) × sourceWeight
 *
 * Where:
 *   - `confidence` is the scorer's reported `[0, 1]` confidence.
 *   - `engagement` is `upvotes + comments` when the upstream poller surfaces
 *     either count via `mention.meta.engagement` (optional). When neither is
 *     available the factor degrades to `log1p(1) = ln(2) ≈ 0.69` so a
 *     low-engagement (or unknown-engagement) source still contributes
 *     proportionally to its confidence × sourceWeight without going to zero.
 *   - `sourceWeight` comes from {@link SentimentAggregatorWeights} with sane
 *     defaults (see {@link DEFAULT_SOURCE_WEIGHTS}).
 *
 * Cadence (when used via the {@link Scheduler}):
 *   - `rth`   → every 5 min
 *   - `pre` / `post` → every 15 min
 *   - `closed` / `holiday` → every 1 h
 *
 * Window defaults:
 *   - `rth` → last 30 min
 *   - everything else → last 4 h
 *
 * No-mentions handling: when the lookback window yields zero scored mentions,
 * the aggregator returns `null` (and emits `null` on the bus) so the
 * dashboard can distinguish "no data" from "neutral / score 0".
 *
 * Framework-free: callers inject the `MentionStore`, the clock, and the
 * (optional) event sink. No network, no disk outside the store.
 */

import { z } from 'zod';
import type { MentionStore } from '../mention-store.js';
import {
  SentimentSnapshot,
  type ScoredMention,
  type SentimentBySource,
  SentimentSource,
} from '../../schemas/sentiment.js';
import type { MarketState } from '../market-clock.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Default source weights. Tuned per the issue spec (#38). */
export const DEFAULT_SOURCE_WEIGHTS = Object.freeze({
  reddit: 1.0,
  stocktwits: 0.7,
  hn: 0.4,
  cnn: 1.2,
  'google-news': 1.1,
}) satisfies Record<SentimentSource, number>;

/** Lookback window (ms) per market state. Defaults per the issue spec. */
export const DEFAULT_WINDOW_MS: Record<MarketState, number> = Object.freeze({
  rth: 30 * 60 * 1000,
  pre: 4 * 60 * 60 * 1000,
  post: 4 * 60 * 60 * 1000,
  closed: 4 * 60 * 60 * 1000,
  holiday: 4 * 60 * 60 * 1000,
});

/** Cadence (ms) per market state. Defaults per the issue spec. */
export const DEFAULT_CADENCE_MS: Record<MarketState, number> = Object.freeze({
  rth: 5 * 60 * 1000,
  pre: 15 * 60 * 1000,
  post: 15 * 60 * 1000,
  closed: 60 * 60 * 1000,
  holiday: 60 * 60 * 1000,
});

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Per-source weight overrides. Any source omitted falls back to
 * {@link DEFAULT_SOURCE_WEIGHTS}.
 */
export const SentimentAggregatorWeights = z
  .object({
    reddit: z.number().nonnegative(),
    stocktwits: z.number().nonnegative(),
    hn: z.number().nonnegative(),
    cnn: z.number().nonnegative(),
    'google-news': z.number().nonnegative(),
  })
  .partial();
export type SentimentAggregatorWeights = z.infer<typeof SentimentAggregatorWeights>;

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Event payload emitted via `onEvent` for each aggregate computed (or the
 * "no data" sentinel). Mirrors the bus channel name from the parent epic.
 */
export interface SentimentUpdateEvent {
  readonly type: 'sentiment.update';
  readonly symbol: string;
  /** `null` when the lookback window contained zero scored mentions. */
  readonly snapshot: SentimentSnapshot | null;
}

export interface AggregateSentimentOptions {
  readonly symbol: string;
  readonly store: MentionStore;
  /**
   * Per-market-state lookback window in ms. Any state omitted falls back to
   * {@link DEFAULT_WINDOW_MS}.
   */
  readonly windowMs?: Partial<Record<MarketState, number>>;
  /**
   * Per-source weights. Any source omitted falls back to
   * {@link DEFAULT_SOURCE_WEIGHTS}.
   */
  readonly sourceWeights?: SentimentAggregatorWeights;
  /** Market state to pick the window for. Defaults to `'rth'`. */
  readonly marketState?: MarketState;
  /** Optional event sink for `sentiment.update`. */
  readonly onEvent?: (e: SentimentUpdateEvent) => void;
  /** Injectable clock (tests). Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export interface AggregateSentimentResult {
  readonly symbol: string;
  /** `null` when the lookback window yielded zero scored mentions. */
  readonly snapshot: SentimentSnapshot | null;
  /** Count of `ScoredMention` rows that contributed to the aggregate. */
  readonly contributing: number;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function resolveWeights(
  overrides: SentimentAggregatorWeights | undefined,
): Record<SentimentSource, number> {
  return { ...DEFAULT_SOURCE_WEIGHTS, ...(overrides ?? {}) };
}

function resolveWindowMs(
  overrides: Partial<Record<MarketState, number>> | undefined,
  state: MarketState,
): number {
  return overrides?.[state] ?? DEFAULT_WINDOW_MS[state];
}

/**
 * Engagement metric. We look for `meta.engagement` on the mention because
 * different upstream pollers expose different counts (Reddit `ups + comments`,
 * StockTwits `likes + replies`, etc.). When absent we fall back to `1` so the
 * `log1p` factor degrades to a constant rather than zero.
 */
function engagementOf(scored: ScoredMention): number {
  const meta = (scored as { meta?: Record<string, unknown> }).meta;
  if (meta && typeof meta === 'object') {
    const e = (meta as { engagement?: unknown }).engagement;
    if (typeof e === 'number' && Number.isFinite(e) && e >= 0) return e;
  }
  return 1;
}

function labelFor(score: number): 'bearish' | 'neutral' | 'bullish' {
  if (score >= 0.15) return 'bullish';
  if (score <= -0.15) return 'bearish';
  return 'neutral';
}

/* -------------------------------------------------------------------------- */
/* Pure aggregation (exported for testing)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pure aggregation: given a flat list of {@link ScoredMention}s + weights,
 * produce a {@link SentimentSnapshot} (or `null` when the input is empty).
 *
 * Exported so tests and the recommender context builder (#46) can reuse the
 * exact aggregation semantics without going through the store.
 */
export function aggregateScoredMentions(
  symbol: string,
  scored: readonly ScoredMention[],
  opts: { now: Date; sourceWeights?: SentimentAggregatorWeights } = { now: new Date() },
): SentimentSnapshot | null {
  if (scored.length === 0) return null;
  const weights = resolveWeights(opts.sourceWeights);

  let sumWeight = 0;
  let sumWeightedScore = 0;
  let sumConfidence = 0;
  const bySourceAcc: Partial<
    Record<SentimentSource, { sw: number; sws: number; sc: number; vol: number }>
  > = {};

  for (const m of scored) {
    const sw = weights[m.source] ?? 1;
    const eng = engagementOf(m);
    const w = m.sentiment.confidence * Math.log1p(eng) * sw;
    if (!Number.isFinite(w) || w <= 0) continue;
    sumWeight += w;
    sumWeightedScore += w * m.sentiment.score;
    sumConfidence += m.sentiment.confidence;

    const acc = bySourceAcc[m.source] ?? { sw: 0, sws: 0, sc: 0, vol: 0 };
    acc.sw += w;
    acc.sws += w * m.sentiment.score;
    acc.sc += m.sentiment.confidence;
    acc.vol += 1;
    bySourceAcc[m.source] = acc;
  }

  if (sumWeight <= 0) return null;

  const score = sumWeightedScore / sumWeight;
  const confidence = sumConfidence / scored.length;

  const bySource: Partial<Record<SentimentSource, SentimentBySource>> = {};
  for (const [src, acc] of Object.entries(bySourceAcc) as Array<
    [SentimentSource, { sw: number; sws: number; sc: number; vol: number }]
  >) {
    bySource[src] = {
      score: acc.sw > 0 ? acc.sws / acc.sw : 0,
      confidence: acc.vol > 0 ? acc.sc / acc.vol : 0,
      volume: acc.vol,
    };
  }

  return SentimentSnapshot.parse({
    symbol,
    asOf: opts.now.toISOString(),
    score: clamp(score, -1, 1),
    confidence: clamp(confidence, 0, 1),
    volume: scored.length,
    bySource,
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/* -------------------------------------------------------------------------- */
/* Job entrypoint                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Read `[now - windowMs, now]` worth of `ScoredMention`s for `symbol`,
 * compute the aggregate, persist via {@link MentionStore.appendSentiment},
 * and emit `sentiment.update`.
 *
 * When the window yields zero scored mentions, **no snapshot is persisted**
 * but a `sentiment.update` event with `snapshot: null` is still emitted so
 * downstream surfaces can show a "no data" state.
 *
 * Includes "Not financial advice" guard: this function intentionally never
 * formats a user-facing string — it only emits the structured snapshot.
 */
export async function aggregateSentiment(
  opts: AggregateSentimentOptions,
): Promise<AggregateSentimentResult> {
  const now = (opts.now ?? (() => new Date()))();
  const state: MarketState = opts.marketState ?? 'rth';
  const window = resolveWindowMs(opts.windowMs, state);
  const since = new Date(now.getTime() - window);
  const symbol = opts.symbol.toUpperCase();

  const scored: ScoredMention[] = [];
  for await (const m of opts.store.readMentions(symbol, since, now)) {
    // `readMentions` yields both raw `MentionItem` and `ScoredMention`. The
    // aggregator only consumes scored rows — unscored mentions belong to the
    // scorer (#37), not us.
    if (m && typeof m === 'object' && 'sentiment' in m) {
      scored.push(m as ScoredMention);
    }
  }

  const snapshot = aggregateScoredMentions(symbol, scored, {
    now,
    sourceWeights: opts.sourceWeights,
  });

  if (snapshot !== null) {
    await opts.store.appendSentiment(snapshot);
  }

  opts.onEvent?.({ type: 'sentiment.update', symbol, snapshot });

  return { symbol, snapshot, contributing: scored.length };
}
