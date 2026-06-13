/**
 * Recommendations polling job (#49, parent #44).
 *
 * Wraps a {@link RecommenderOrchestrator} as a scheduler {@link Job} so the
 * Scheduler (#20) can drive recommendation generation per symbol on a
 * market-state-aware cadence.
 *
 * Cadence (per the issue spec):
 *   - `rth`     → every 15 min
 *   - `pre`/`post` → every 1 h
 *   - `closed`/`holiday` → every 4 h
 *
 * All four values are overridable via {@link RecommendationsCadenceConfig}
 * so the eventual `polling.recommendations` config block (#23) can tune
 * them without touching code.
 *
 * Backpressure & single-flight:
 *   - The Job is registered with `singleFlight: true` so the scheduler
 *     never starts a second tick while one is running.
 *   - The orchestrator itself also guards in-flight calls per symbol, so a
 *     stray HTTP call to the same code path during a slow LLM run resolves
 *     with `skipped: 'inflight'` rather than queueing.
 *   - When a tick is dropped (either because singleFlight is engaged or the
 *     orchestrator reports `skipped`), the optional `onSkip` hook fires
 *     once so callers can log / meter without coupling to the scheduler.
 *
 * The job intentionally never swallows recommender errors — it lets them
 * bubble so the scheduler's per-job {@link BackoffPolicy} can apply
 * exponential backoff with jitter.
 */

import type { Job, JobContext } from '../scheduler.js';
import type { MarketState } from '../market-clock.js';
import type {
  RecommenderOrchestrator,
  RunOnceResult,
} from '../../recommender/orchestrator.js';

/**
 * Per-market-state cadence in milliseconds. Mirrors the spec defaults
 * called out in #49. Anything omitted falls back to {@link DEFAULT_RECOMMENDATIONS_CADENCES}.
 */
export interface RecommendationsCadenceConfig {
  /** Regular trading hours (09:30–16:00 ET). Default 15 min. */
  readonly rth?: number;
  /** Pre-market (04:00–09:30 ET). Default 1 h. */
  readonly pre?: number;
  /** Post-market (16:00–20:00 ET). Default 1 h. */
  readonly post?: number;
  /** Outside extended hours. Default 4 h. */
  readonly closed?: number;
  /** US holidays. Default 4 h. */
  readonly holiday?: number;
}

export const DEFAULT_RECOMMENDATIONS_CADENCES: Required<RecommendationsCadenceConfig> =
  Object.freeze({
    rth: 15 * 60 * 1000,
    pre: 60 * 60 * 1000,
    post: 60 * 60 * 1000,
    closed: 4 * 60 * 60 * 1000,
    holiday: 4 * 60 * 60 * 1000,
  });

export interface CreateRecommendationsJobOptions {
  /** Symbol the job is bound to. One Job per symbol. */
  readonly symbol: string;
  readonly orchestrator: RecommenderOrchestrator;
  /** Override cadences. */
  readonly cadences?: RecommendationsCadenceConfig;
  /**
   * Optional hook fired when the orchestrator reports the tick was
   * skipped because another run was already in-flight for the symbol.
   * Useful for logs/metrics — *never* used to retry.
   */
  readonly onSkip?: (info: { readonly symbol: string; readonly reason: 'inflight' }) => void;
  /**
   * Optional hook fired after every successful run (persisted or dedup-
   * skipped). Mirrors the orchestrator's `recommendation.update` event
   * shape but scoped to the job's symbol.
   */
  readonly onRun?: (result: Extract<RunOnceResult, { status: 'ok' }>) => void;
  /** Override job id. Default: `recommendations:<SYM>`. */
  readonly id?: string;
}

function resolveCadenceMs(
  state: MarketState,
  cadences: RecommendationsCadenceConfig | undefined,
): number {
  const merged: Required<RecommendationsCadenceConfig> = {
    ...DEFAULT_RECOMMENDATIONS_CADENCES,
    ...(cadences ?? {}),
  };
  switch (state) {
    case 'rth':
      return merged.rth;
    case 'pre':
      return merged.pre;
    case 'post':
      return merged.post;
    case 'holiday':
      return merged.holiday;
    case 'closed':
    default:
      return merged.closed;
  }
}

/**
 * Build a {@link Job} for one symbol's recommendation pipeline. Register
 * the returned job with a {@link Scheduler} and it will tick at the
 * configured cadence; single-flight is enforced server-side.
 */
export function createRecommendationsJob(
  opts: CreateRecommendationsJobOptions,
): Job {
  const symbol = opts.symbol.toUpperCase();
  const id = opts.id ?? `recommendations:${symbol}`;
  return {
    id,
    singleFlight: true,
    cadence: (state) => resolveCadenceMs(state, opts.cadences),
    async run(_ctx: JobContext): Promise<void> {
      const result = await opts.orchestrator.runOnce(symbol);
      if (result.status === 'skipped') {
        opts.onSkip?.({ symbol, reason: result.reason });
        return;
      }
      opts.onRun?.(result);
    },
  };
}
