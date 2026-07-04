/**
 * IV rank + IV percentile (issue #140).\n *
 * Two closely-related regime signals traders use to decide whether to be
 * a net premium seller vs. buyer:
 *
 *  - **IV rank** — the current IV's position between the historical *min*
 *    and *max* over the lookback window, 0-100.
 *    `ivRank = (iv - min) / (max - min) * 100`.
 *  - **IV percentile** — the fraction of historical IV observations that
 *    are strictly below the current IV, 0-100.
 *    `ivPercentile = countBelow(iv) / n * 100`.
 *
 * Both are pure, deterministic, and depend only on a history array plus the
 * current IV. `null` is returned when the input is degenerate (empty
 * history, non-finite values, or a flat window for `ivRank`).
 */
import { z } from 'zod';

export interface IvRegimeInput {
  /** The current IV to score. */
  current: number;
  /** Historical IV samples (any order; non-finite entries are ignored). */
  history: readonly number[];
}

function cleanHistory(history: readonly number[]): number[] {
  const out: number[] = [];
  for (const v of history) {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * IV rank as a 0-100 score. Returns `null` when history is empty, `current`
 * is not finite, or the historical min equals the max (undefined range).
 */
export function ivRank(input: IvRegimeInput): number | null {
  if (!Number.isFinite(input.current)) return null;
  const hist = cleanHistory(input.history);
  if (hist.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const v of hist) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range === 0) return null;
  // Clamp to [0, 100] so an out-of-sample current doesn't produce nonsense.
  const raw = ((input.current - min) / range) * 100;
  if (raw < 0) return 0;
  if (raw > 100) return 100;
  return raw;
}

/**
 * IV percentile as a 0-100 score. Returns `null` when history is empty or
 * `current` is not finite. Uses the strict-inequality convention (the
 * fraction of history samples strictly less than `current`), which matches
 * the tastyworks / TOS definition traders expect.
 */
export function ivPercentile(input: IvRegimeInput): number | null {
  if (!Number.isFinite(input.current)) return null;
  const hist = cleanHistory(input.history);
  if (hist.length === 0) return null;
  let below = 0;
  for (const v of hist) if (v < input.current) below++;
  return (below / hist.length) * 100;
}

/**
 * Combined regime snapshot. Zod-validated so it can flow through wire /
 * storage boundaries without extra plumbing.
 */
export const IvRegimeSchema = z.object({
  /** Current IV that was scored. */
  current: z.number(),
  /** Number of historical samples used (post-filter). */
  windowSize: z.number().int().nonnegative(),
  /** IV rank, 0-100, or null when undefined (see `ivRank`). */
  rank: z.number().nullable(),
  /** IV percentile, 0-100, or null when undefined (see `ivPercentile`). */
  percentile: z.number().nullable(),
});
export type IvRegime = z.infer<typeof IvRegimeSchema>;

/**
 * Convenience wrapper that returns both rank and percentile plus the
 * effective window size, so callers don't have to keep the history in
 * scope for two calls.
 */
export function ivRegime(input: IvRegimeInput): IvRegime {
  const hist = cleanHistory(input.history);
  return {
    current: input.current,
    windowSize: hist.length,
    rank: ivRank(input),
    percentile: ivPercentile(input),
  };
}
