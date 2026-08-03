import { describe, it, expect } from 'vitest';
import { computeIndicators, computeIndicatorSeries } from './index.js';
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

  it('computes aligned indicator series for chart overlays', () => {
    const bars: OHLCV[] = Array.from({ length: 40 }, (_, i) => {
      const c = 50 + i * 0.8;
      return { t: `2024-03-${String(i + 1).padStart(2, '0')}`, o: c - 0.3, h: c + 0.7, l: c - 0.8, c, v: 900_000 + i };
    });
    const s = computeIndicatorSeries(bars);
    expect(s.sma20).toHaveLength(bars.length);
    expect(s.ema12).toHaveLength(bars.length);
    expect(s.rsi14[s.rsi14.length - 1]).not.toBeNull();
    expect(s.macdSignal[s.macdSignal.length - 1]).not.toBeNull();
  });
});
