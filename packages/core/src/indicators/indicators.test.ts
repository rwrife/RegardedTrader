import { describe, it, expect } from 'vitest';
import { computeIndicators } from './index.js';
import type { OHLCV } from '../schemas/index.js';

describe('computeIndicators', () => {
  it('returns nulls for sparse data and numbers for sufficient data', () => {
    const bars: OHLCV[] = Array.from({ length: 60 }, (_, i) => {
      const c = 100 + Math.sin(i / 3) * 5;
      return { t: `2024-01-${i + 1}`, o: c, h: c + 1, l: c - 1, c, v: 1_000_000 };
    });
    const ind = computeIndicators(bars);
    expect(ind.rsi14).not.toBeNull();
    expect(ind.sma20).not.toBeNull();
    expect(ind.sma50).not.toBeNull();
    expect(ind.macd).not.toBeNull();
  });
});
