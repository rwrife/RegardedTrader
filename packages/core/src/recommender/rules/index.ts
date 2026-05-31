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
 * Minimal forward-compatible context shape consumed by the v1 rules.
 *
 * The full `RecommendationContext` (snapshot bundles, indicators, sentiment,
 * news) lands in #46. We keep the shape narrow here so HardGates can be
 * tested and shipped independently; #46 will widen this interface.
 */
export interface RecommendationContext {
  readonly symbol: string;
  readonly risk: {
    /** Mirrors `AppConfig.risk.forbidNakedShorts` / `RiskOfficer` cap. */
    readonly forbidNakedShorts: boolean;
  };
  readonly quote: {
    /**
     * True when the latest quote snapshot is older than 2x its cadence
     * (per the epic's freshness rule). Rules read this only — the
     * ContextBuilder computes it.
     */
    readonly stale: boolean;
  };
  /**
   * Options-chain availability. `null` means no chain snapshot at all
   * (e.g. ticker has no listed options or the polling job has not run
   * yet). `{ hasChain: false }` means a snapshot exists but is empty.
   * Both cases trip the "null options verdicts" hard gate.
   */
  readonly options: {
    readonly hasChain: boolean;
  } | null;
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
