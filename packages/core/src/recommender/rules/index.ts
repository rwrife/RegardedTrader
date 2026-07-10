/**
 * Recommender RuleEngine (#47).
 *
 * Rules are pure, ordered transformers that take a draft `Recommendation` and
 * a `RecommendationContext` (see #46 for the full builder) and return a new
 * `Recommendation`. They never mutate the draft.
 *
 * The runtime `applyRules` helper threads a draft through a list of rules
 * in order; the output of one rule is the input of the next. Each rule
 * carries a `name` + `version` so future audits (#54) can attribute a flag
 * or verdict change to a specific rule revision.
 *
 * `HardGates` (the v1 rule) enforces non-negotiable guardrails from the
 * recommender epic (#44):
 *   - Strip `nakedCall` / `nakedPut` when `forbidNakedShorts`.
 *   - Force the equity verdict to `HOLD` when aggregate confidence < 0.3.
 *   - Downgrade verdicts (clamp conviction) and add a `stale-quote` flag
 *     when the underlying quote is stale.
 *   - `null` all options verdicts when no options chain is available.
 *
 * `RecommendationContext` is defined here as a minimal forward-compatible
 * shape that the `ContextBuilder` (#46) will populate. We only declare the
 * fields HardGates needs today; #46 will extend it.
 */

import type {
  OptionsVerdicts,
  Recommendation,
  Verdict,
} from '../../schemas/recommendation.js';

/**
 * Forward-compatible context shape consumed by the rule engine and the
 * recommender LLM prompt.
 *
 * The v1 rules (HardGates) only read `symbol`, `risk`, `quote.stale`, and
 * `options.hasChain`. The richer fields below are populated by
 * `buildRecommendationContext` (#46) for the LLM prompt and the audit
 * trail; rules MAY use them but are not required to.
 *
 * All `*Section` blocks carry their own `asOf` ISO timestamp and a
 * `stale` flag computed as "older than 2× the section's cadence" by the
 * ContextBuilder. Sections that have no data at all are `null`.
 */
export interface RecommendationContext {
  readonly symbol: string;
  readonly risk: {
    /** Mirrors `AppConfig.risk.forbidNakedShorts` / `RiskOfficer` cap. */
    readonly forbidNakedShorts: boolean;
  };
  readonly quote: ContextQuoteSection;
  /**
   * Options-chain availability. `null` means no chain snapshot at all
   * (e.g. ticker has no listed options or the polling job has not run
   * yet). `{ hasChain: false }` means a snapshot exists but is empty.
   * Both cases trip the "null options verdicts" hard gate.
   *
   * `expiries` is the per-expiry top-of-book digest populated by the
   * ContextBuilder. Empty array when `hasChain` is false. Optional fields
   * are populated by `buildRecommendationContext` but absent in the
   * minimal rule-engine usage.
   */
  readonly options: ContextOptionsSection | null;
  /** Last 30d of daily OHLCV. `null` when no history was available. */
  readonly history?: ContextHistorySection | null;
  /** Indicators (RSI/MACD/SMA/EMA/ATR) computed from `history`. */
  readonly indicators?: ContextIndicatorsSection | null;
  /** Aggregate sentiment snapshot + 24h sparkline of past scores. */
  readonly sentiment?: ContextSentimentSection | null;
  /** Last N news headlines (default 8), deduped by URL. */
  readonly news?: ContextNewsSection | null;
  /** Last N opinion mentions (default 8), deduped by URL. */
  readonly opinions?: ContextOpinionsSection | null;
  /** Approximate char counts per section (post-budget). */
  readonly budget?: ContextBudgetReport;
  /**
   * Top-level convenience flag mirroring `budget.truncated.length > 0`
   * (issue #125). `true` when at least one variable-length section had
   * entries dropped to fit the char budget. Rules and prompts can branch
   * on this without reaching into `budget.truncated`.
   *
   * Optional so pre-#125 fixtures / rule-engine callers keep validating.
   */
  readonly truncated?: boolean;
}

/** Per-section freshness annotation. */
export interface ContextSectionMeta {
  /** ISO timestamp of the most recent datum in this section. */
  readonly asOf: string;
  /**
   * True when `asOf` is older than 2× the section's expected cadence,
   * per the recommender epic's freshness rule.
   */
  readonly stale: boolean;
}

export interface ContextQuoteSection {
  /**
   * True when the latest quote snapshot is older than 2x its cadence
   * (per the epic's freshness rule). Rules read this only — the
   * ContextBuilder computes it.
   */
  readonly stale: boolean;
  /** ISO timestamp of the latest quote snapshot. Optional for rule-engine-only callers. */
  readonly asOf?: string;
  /** Last price snapshot. Populated by the ContextBuilder. */
  readonly last?: {
    readonly price: number;
    readonly change: number;
    readonly changePercent: number;
    readonly volume: number;
  } | null;
}

export interface ContextOptionsExpiryDigest {
  /** UTC `YYYY-MM-DD` expiry. */
  readonly expiry: string;
  readonly asOf: string;
  readonly atmIv: number | null;
  readonly ivSkew25d: number | null;
  readonly openInterest: { readonly call: number; readonly put: number; readonly total: number };
  readonly volume: { readonly call: number; readonly put: number; readonly total: number };
  readonly putCallRatio: number | null;
  readonly contractCount: number;
  readonly underlyingPrice: number | null;
}

export interface ContextOptionsSection {
  readonly hasChain: boolean;
  /** Populated by the ContextBuilder. Optional for rule-engine-only callers. */
  readonly asOf?: string;
  readonly stale?: boolean;
  readonly expiries?: readonly ContextOptionsExpiryDigest[];
}

export interface ContextHistoryBar {
  readonly t: string;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
}

export interface ContextHistorySection extends ContextSectionMeta {
  readonly bars: readonly ContextHistoryBar[];
}

export interface ContextIndicatorsSection extends ContextSectionMeta {
  readonly rsi14: number | null;
  readonly sma20: number | null;
  readonly sma50: number | null;
  readonly ema12: number | null;
  readonly ema26: number | null;
  readonly macd: number | null;
  readonly macdSignal: number | null;
  readonly atr14: number | null;
}

export interface ContextSentimentSparkPoint {
  readonly t: string;
  readonly score: number;
}

export interface ContextSentimentSection extends ContextSectionMeta {
  readonly score: number;
  readonly confidence: number;
  readonly volume: number;
  /** 24h sparkline of prior `SentimentSnapshot.score` values, oldest-first. */
  readonly spark24h: readonly ContextSentimentSparkPoint[];
}

export interface ContextHeadline {
  readonly title: string;
  readonly url: string;
  readonly source: string;
  readonly publishedAt: string;
  readonly summary?: string;
}

export interface ContextNewsSection extends ContextSectionMeta {
  readonly items: readonly ContextHeadline[];
}

export interface ContextOpinionItem {
  readonly source: string;
  readonly url?: string;
  readonly title?: string;
  readonly text: string;
  readonly publishedAt: string;
  readonly score?: number;
  readonly confidence?: number;
  readonly label?: 'bearish' | 'neutral' | 'bullish';
}

export interface ContextOpinionsSection extends ContextSectionMeta {
  readonly items: readonly ContextOpinionItem[];
}

export interface ContextBudgetReport {
  /** Approximate char counts per section after budgeting. */
  readonly chars: {
    readonly history: number;
    readonly indicators: number;
    readonly options: number;
    readonly sentiment: number;
    readonly news: number;
    readonly opinions: number;
    readonly total: number;
  };
  /** Sections that were truncated to fit the budget. */
  readonly truncated: readonly string[];
  /** Total char budget applied. */
  readonly budgetChars: number;
}

/** A single transformation step in the recommender pipeline. */
export interface Rule {
  readonly name: string;
  readonly version: string;
  apply(ctx: RecommendationContext, draft: Recommendation): Recommendation;
}

/**
 * Thread `draft` through `rules` in order. Pure: never mutates `draft`.
 * Rules that don't apply should return the input unchanged.
 */
export function applyRules(
  ctx: RecommendationContext,
  draft: Recommendation,
  rules: readonly Rule[],
): Recommendation {
  let current = draft;
  for (const rule of rules) {
    current = rule.apply(ctx, current);
  }
  return current;
}

export { HardGates, HARD_GATES_VERSION, hardGatesRule } from './hard-gates.js';
export type { HardGatesOptions } from './hard-gates.js';

// Re-export types so consumers can import everything from one place.
export type { OptionsVerdicts, Verdict };
