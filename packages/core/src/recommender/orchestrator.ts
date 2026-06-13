/**
 * Recommender orchestrator (#49, parent #44).
 *
 * Composes the recommender pipeline end-to-end for one symbol:
 *
 *   ContextBuilder → AI Recommender → applyRules(HardGates)
 *                 → RecommendationStore.append (with dedup)
 *                 → emit `recommendation.update`
 *
 * Design notes:
 *   - The orchestrator is framework-free. Every external dependency
 *     (context builder, recommender, rules, store, event sink) is injected
 *     so tests can swap in fakes and the polling job (#49 / `recommendations.ts`)
 *     can wire it into the {@link Scheduler}.
 *   - Backpressure: a per-symbol single-flight guard drops overlapping ticks
 *     and reports them as `skipped: 'inflight'`. The recommendations
 *     polling job sets `singleFlight: true` on the scheduler side too, but
 *     the orchestrator owns the guarantee — anyone (HTTP route, CLI,
 *     scheduler) calling `runOnce` benefits.
 *   - Dedup: when the freshly-computed recommendation matches the last
 *     persisted one (same equity action, same conviction bucket within
 *     ±5%, same options stance actions) AND less than `dedupTtlMs` has
 *     elapsed since the last write, we *do not* append a new history
 *     entry. We still emit a `recommendation.update` event so live
 *     consumers can re-render freshness — but the on-disk JSONL stays
 *     compact. This matches issue #49's "skip writing a new entry when
 *     nothing material changed".
 *   - The orchestrator NEVER catches the recommender's errors silently:
 *     a failure bubbles up to the caller (the polling job logs + backs
 *     off via the scheduler's `BackoffPolicy`). Fail-safe "HOLD
 *     everything" output is the recommender's own concern (#48).
 */

import type { Rule } from './rules/index.js';
import { applyRules } from './rules/index.js';
import type { RecommendationContext } from './rules/index.js';
import type { Recommender, RecommenderStamp } from './recommender.js';
import type { RecommendationStore } from './store.js';
import type { Recommendation } from '../schemas/recommendation.js';

/**
 * `recommendation.update` event fired after every successful pipeline run,
 * whether or not the result was persisted (dedup). Consumers (SSE bridge
 * from #25, web/CLI live views) get a uniform stream.
 */
export interface RecommendationUpdateEvent {
  readonly type: 'recommendation.update';
  readonly symbol: string;
  readonly recommendation: Recommendation;
  /** True when the recommendation was appended to the store. */
  readonly persisted: boolean;
}

/**
 * Inputs to {@link RecommenderOrchestrator}. Each piece is a small,
 * orthogonal capability so tests can build a minimal harness.
 */
export interface RecommenderOrchestratorOptions {
  readonly recommender: Recommender;
  readonly store: RecommendationStore;
  /** Build a {@link RecommendationContext} for the symbol. */
  buildContext(symbol: string): Promise<RecommendationContext>;
  /** Build the {@link RecommenderStamp} for the freshly-built context. */
  stampFor(context: RecommendationContext): RecommenderStamp;
  /**
   * Ordered rule pipeline. Defaults to `[]` — callers typically pass
   * `[HardGates]` (#47). Rules are evaluated in order.
   */
  readonly rules?: readonly Rule[];
  /** Override clock (tests). Default: `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Dedup conviction bucket as a fraction (0..1). Default 0.05 = ±5%.
   * Two convictions within `dedupBucket` of each other are considered the
   * same bucket.
   */
  readonly dedupBucket?: number;
  /**
   * Dedup TTL in ms. Within this window, a materially-equivalent
   * recommendation is *not* written to the store. Default: 1 hour.
   */
  readonly dedupTtlMs?: number;
  /** Optional event sink for `recommendation.update`. */
  readonly onEvent?: (e: RecommendationUpdateEvent) => void;
}

/** Outcome of one orchestrator tick for a single symbol. */
export type RunOnceResult =
  | {
      readonly status: 'ok';
      readonly symbol: string;
      readonly recommendation: Recommendation;
      readonly persisted: boolean;
    }
  | {
      readonly status: 'skipped';
      readonly symbol: string;
      readonly reason: 'inflight';
    };

const DEFAULT_DEDUP_BUCKET = 0.05;
const DEFAULT_DEDUP_TTL_MS = 60 * 60 * 1000;

export class RecommenderOrchestrator {
  private readonly opts: RecommenderOrchestratorOptions;
  private readonly rules: readonly Rule[];
  private readonly now: () => Date;
  private readonly dedupBucket: number;
  private readonly dedupTtlMs: number;
  private readonly inflight = new Map<string, Promise<RunOnceResult>>();

  constructor(opts: RecommenderOrchestratorOptions) {
    this.opts = opts;
    this.rules = opts.rules ?? [];
    this.now = opts.now ?? (() => new Date());
    this.dedupBucket = opts.dedupBucket ?? DEFAULT_DEDUP_BUCKET;
    this.dedupTtlMs = opts.dedupTtlMs ?? DEFAULT_DEDUP_TTL_MS;
  }

  /**
   * Run the pipeline once for `symbol`. Concurrent calls for the same
   * symbol share the in-flight promise (single-flight). A *second*
   * concurrent caller resolves with `status: 'skipped'` so back-pressured
   * callers (e.g. a slow LLM under a 15-min scheduler) never queue
   * unbounded work.
   */
  runOnce(symbol: string): Promise<RunOnceResult> {
    const sym = symbol.toUpperCase();
    const existing = this.inflight.get(sym);
    if (existing) {
      return Promise.resolve<RunOnceResult>({
        status: 'skipped',
        symbol: sym,
        reason: 'inflight',
      });
    }
    const run = this.runOnceInner(sym).finally(() => {
      this.inflight.delete(sym);
    });
    this.inflight.set(sym, run);
    return run;
  }

  private async runOnceInner(symbol: string): Promise<RunOnceResult> {
    const context = await this.opts.buildContext(symbol);
    const stamp = this.opts.stampFor(context);
    const draft = await this.opts.recommender.recommend(context, stamp);
    const gated = applyRules(context, draft, this.rules);

    const previous = await this.opts.store.readLatest(symbol);
    let persisted = false;
    if (this.shouldPersist(previous, gated)) {
      await this.opts.store.append(symbol, gated);
      persisted = true;
    }

    this.opts.onEvent?.({
      type: 'recommendation.update',
      symbol,
      recommendation: gated,
      persisted,
    });

    return { status: 'ok', symbol, recommendation: gated, persisted };
  }

  /**
   * Returns true when `next` is materially different from `prev` OR the
   * dedup TTL has elapsed.
   *
   * "Material" means:
   *   - equity.action differs, OR
   *   - equity.conviction differs by more than `dedupBucket` (absolute), OR
   *   - any options-stance action differs (nulls included).
   *
   * Rationale: we want a year of replayable history for self-eval (#54),
   * but we don't want one entry per 15-minute tick when the model just
   * jitters within a bucket. Forcing a write every `dedupTtlMs` keeps a
   * heartbeat row so "no change for 4 hours" is still attributable.
   */
  private shouldPersist(
    prev: Recommendation | null,
    next: Recommendation,
  ): boolean {
    if (!prev) return true;

    if (prev.equity.action !== next.equity.action) return true;
    if (Math.abs(prev.equity.conviction - next.equity.conviction) > this.dedupBucket) {
      return true;
    }
    const stances = ['coveredCall', 'coveredPut', 'nakedCall', 'nakedPut'] as const;
    for (const k of stances) {
      const a = prev.options[k];
      const b = next.options[k];
      if ((a === null) !== (b === null)) return true;
      if (a !== null && b !== null && a.action !== b.action) return true;
    }

    const prevTs = Date.parse(prev.generatedAt);
    if (!Number.isFinite(prevTs)) return true;
    const nowMs = this.now().getTime();
    if (nowMs - prevTs >= this.dedupTtlMs) return true;

    return false;
  }
}
