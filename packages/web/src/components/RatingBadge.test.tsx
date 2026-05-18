import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { RatingBadge } from './RatingBadge.js';
import type { StockRating } from '@regardedtrader/core/rating';

afterEach(() => cleanup());

function mk(rating: StockRating['rating'], score = 50): StockRating {
  return {
    symbol: 'NVDA',
    rating,
    score,
    reasons: ['+3.2% today', '2.1× avg volume'],
    asOf: '2024-06-12T15:30:00Z',
  };
}

describe('RatingBadge', () => {
  it('returns null when no rating is provided', () => {
    const { container } = render(<RatingBadge rating={null} />);
    expect(container.firstChild).toBeNull();
  });

  it.each([
    ['SELL', 'text-down', false],
    ['HOLD', 'text-fg-secondary', false],
    ['BUY', 'text-up', false],
    ['YOLO', 'rating-yolo', true],
  ] as const)(
    'renders %s with the correct color class and pulse only for YOLO',
    (level, expectedClass, expectPulse) => {
      render(<RatingBadge rating={mk(level, 60)} />);
      const el = screen.getByRole('status');
      expect(el.textContent).toContain(level);
      expect(el.className).toContain(expectedClass);
      expect(el.className.includes('rating-yolo-pulse')).toBe(expectPulse);
      expect(el.getAttribute('data-rating')).toBe(level);
    },
  );

  it('exposes a descriptive aria-label and title with score + reasons', () => {
    render(<RatingBadge rating={mk('BUY', 72)} />);
    const el = screen.getByRole('status');
    const expected = 'BUY — score 72/100. +3.2% today; 2.1× avg volume';
    expect(el.getAttribute('aria-label')).toBe(expected);
    expect(el.getAttribute('title')).toBe(expected);
  });
});
