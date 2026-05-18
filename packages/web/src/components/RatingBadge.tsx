import React from 'react';
import type { StockRating } from '@regardedtrader/core/rating';

/**
 * RatingBadge (#82) — a compact pill that surfaces the SELL/HOLD/BUY/YOLO
 * conviction rating inside the ticker price box.
 *
 * Visuals:
 * - SELL  — red    (text + soft red surface)
 * - HOLD  — neutral gray
 * - BUY   — green
 * - YOLO  — gradient with a `prefers-reduced-motion`-aware pulse
 *
 * Accessibility: the pill exposes a descriptive `aria-label` and `title` of
 * the form `${rating} — score ${score}/100. ${reasons.join('; ')}` so screen
 * readers and hover tooltips both get the rationale.
 */
export interface RatingBadgeProps {
  rating: StockRating | null | undefined;
  className?: string;
}

const STYLE_BY_RATING: Record<StockRating['rating'], string> = {
  SELL: 'bg-down/15 text-down border-down/40',
  HOLD: 'bg-surface-2 text-fg-secondary border-border-subtle',
  BUY: 'bg-up/15 text-up border-up/40',
  // YOLO uses an inline class (rating-yolo) for the gradient; border kept
  // transparent so the gradient runs to the pill edge.
  YOLO: 'rating-yolo rating-yolo-pulse border-transparent',
};

export function RatingBadge({ rating, className }: RatingBadgeProps): React.ReactElement | null {
  if (!rating) return null;
  const label = `${rating.rating} — score ${rating.score}/100. ${rating.reasons.join('; ')}`;
  const base =
    'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-mono tracking-wider uppercase';
  const tone = STYLE_BY_RATING[rating.rating];
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      data-rating={rating.rating}
      className={`${base} ${tone} ${className ?? ''}`.trim()}
    >
      <span className="font-semibold">{rating.rating}</span>
      <span className="num opacity-75">{Math.round(rating.score)}</span>
    </span>
  );
}
