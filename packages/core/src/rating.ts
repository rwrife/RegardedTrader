/**
 * Stock rating (#82): 4-level conviction bucket (`SELL`/`HOLD`/`BUY`/`YOLO`)
 * computed deterministically from a small bag of signals.
 *
 * Kept intentionally simple so it can be unit-tested exhaustively and so it
 * stays cheap to call inside the live-quote response path. ML/news/options
 * flow are explicitly out of scope (see issue #82).
 */
import { z } from 'zod';
import { Ticker } from './schemas/index.js';

export const RatingSchema = z.enum(['SELL', 'HOLD', 'BUY', 'YOLO']);
export type Rating = z.infer<typeof RatingSchema>;

export const StockRatingSchema = z.object({
  symbol: Ticker,
  rating: RatingSchema,
  /** 0–100 internal aggregate. 50 == neutral. */
  score: z.number().min(0).max(100),
  /** Short human-readable strings explaining the score, for tooltips. */
  reasons: z.array(z.string()),
  /** ISO timestamp the rating was computed. */
  asOf: z.string(),
});
export type StockRating = z.infer<typeof StockRatingSchema>;

export interface ComputeRatingInput {
  symbol: string;
  /** Daily % change (e.g. 3.2 for +3.2%). */
  changePercent: number;
  /** Today's volume divided by 10-day average. 1.0 == normal. */
  volumeRatio?: number;
  /** RSI(14). Optional. */
  rsi?: number;
  /** Short interest as a fraction of float (e.g. 0.18 for 18%). Optional. */
  shortInterest?: number;
  /** Override the timestamp; used by tests for determinism. */
  asOf?: string;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function bucket(score: number): Rating {
  if (score < 25) return 'SELL';
  if (score < 55) return 'HOLD';
  if (score < 85) return 'BUY';
  return 'YOLO';
}

/**
 * Deterministically compute a `StockRating` from a small signal bag.
 *
 * Score starts at 50 (neutral) and is adjusted by:
 * - `changePercent * 2`, clamped to [-25, +25]
 * - `(volumeRatio - 1) * 10`, clamped to [-10, +15] (only when provided)
 * - RSI: ≥70 → +5 (momentum), ≤30 → -5 (washed out — but flagged as a reason)
 * - Short interest: ≥0.20 → +5 (squeeze potential), else nudges slightly negative
 *
 * Bucketing:
 *   score <25 → SELL, <55 → HOLD, <85 → BUY, ≥85 → YOLO.
 */
export function computeRating(input: ComputeRatingInput): StockRating {
  const reasons: string[] = [];
  let score = 50;

  const changeAdj = clamp(input.changePercent * 2, -25, 25);
  score += changeAdj;
  const pct = input.changePercent;
  reasons.push(`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% today`);

  if (typeof input.volumeRatio === 'number') {
    const volAdj = clamp((input.volumeRatio - 1) * 10, -10, 15);
    score += volAdj;
    reasons.push(`${input.volumeRatio.toFixed(1)}× avg volume`);
  }

  if (typeof input.rsi === 'number') {
    if (input.rsi >= 70) {
      score += 5;
      reasons.push(`RSI ${input.rsi.toFixed(0)} (overbought / momentum)`);
    } else if (input.rsi <= 30) {
      score -= 5;
      reasons.push(`RSI ${input.rsi.toFixed(0)} (oversold)`);
    }
  }

  if (typeof input.shortInterest === 'number') {
    if (input.shortInterest >= 0.2) {
      score += 5;
      reasons.push(
        `${(input.shortInterest * 100).toFixed(0)}% short interest (squeeze fuel)`,
      );
    } else if (input.shortInterest >= 0.1) {
      reasons.push(`${(input.shortInterest * 100).toFixed(0)}% short interest`);
    }
  }

  score = clamp(score, 0, 100);

  return {
    symbol: input.symbol,
    rating: bucket(score),
    score: Math.round(score * 10) / 10,
    reasons,
    asOf: input.asOf ?? new Date().toISOString(),
  };
}
