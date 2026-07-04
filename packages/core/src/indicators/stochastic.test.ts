/**
 * Tests for `stochastic()` (issue #140).
 *
 * Deterministic, pure, no network. Uses hand-computed fixtures for the
 * canonical fast-%K definition ((close - lo) / (hi - lo) * 100) and the
 * %D SMA-smoothed line.
 */
import { describe, it, expect } from 'vitest';
import { stochastic } from './index.js';

describe('stochastic', () => {
  it('returns nulls until the k-window fills', () => {
    const highs = [10, 11, 12, 13, 14];
    const lows = [1, 2, 3, 4, 5];
    const closes = [5, 6, 7, 8, 9];
    const s = stochastic(highs, lows, closes, 5, 3);
    expect(s.k[0]).toBeNull();
    expect(s.k[3]).toBeNull();
    expect(s.k[4]).not.toBeNull();
    // %D takes k + d - 1 warmup bars, so it stays null with only 5 bars and d=3.
    expect(s.d[4]).toBeNull();
  });

  it('produces %K in [0,100] and matches a hand-computed fixture', () => {
    // 5-bar windows, each with hi=10, lo=0 so %K = close * 10.
    // Slot indexes:                0   1   2   3   4   5   6
    const highs = [10, 10, 10, 10, 10, 10, 10];
    const lows = [0, 0, 0, 0, 0, 0, 0];
    const closes = [1, 2, 3, 4, 5, 4, 3];
    const s = stochastic(highs, lows, closes, 5, 3);
    // First 4 slots null (window unfilled).
    for (let i = 0; i < 4; i++) expect(s.k[i]).toBeNull();
    expect(s.k[4]).toBeCloseTo((5 - 0) / (10 - 0) * 100, 6); // 50
    expect(s.k[5]).toBeCloseTo((4 - 0) / (10 - 0) * 100, 6); // 40
    expect(s.k[6]).toBeCloseTo((3 - 0) / (10 - 0) * 100, 6); // 30
    // %D = SMA(3) of %K at slots 4, 5, 6 = (50 + 40 + 30) / 3 = 40
    expect(s.d[6]).toBeCloseTo(40, 6);
  });

  it('emits %K = 50 for a flat window (hi === lo)', () => {
    const highs = [5, 5, 5, 5, 5];
    const lows = [5, 5, 5, 5, 5];
    const closes = [5, 5, 5, 5, 5];
    const s = stochastic(highs, lows, closes, 5, 3);
    expect(s.k[4]).toBe(50);
  });

  it('%D lags %K by d-1 bars and equals the SMA of the last d %K values', () => {
    const n = 20;
    const highs = Array.from({ length: n }, (_, i) => 100 + i * 0.5);
    const lows = Array.from({ length: n }, (_, i) => 90 + i * 0.5);
    const closes = Array.from({ length: n }, (_, i) => 95 + i * 0.5);
    const s = stochastic(highs, lows, closes, 5, 3);
    // First %D should appear when three %K values are available: index 6.
    expect(s.d[5]).toBeNull();
    expect(s.d[6]).not.toBeNull();
    // %D at index 10 should equal mean of %K at 8, 9, 10.
    const manual = ((s.k[8]! + s.k[9]! + s.k[10]!) as number) / 3;
    expect(s.d[10]).toBeCloseTo(manual, 9);
  });

  it('keeps %K bounded in [0,100] for a noisy series', () => {
    const n = 60;
    const highs = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 3) * 4 + 1);
    const lows = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 3) * 4 - 1);
    const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 3) * 4);
    const s = stochastic(highs, lows, closes, 14, 3);
    for (const v of s.k) {
      if (v == null) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('throws on invalid parameters', () => {
    expect(() => stochastic([1], [1], [1], 0, 3)).toThrow(RangeError);
    expect(() => stochastic([1], [1], [1], 3, 0)).toThrow(RangeError);
    expect(() => stochastic([1, 2], [1], [1, 2], 2, 3)).toThrow(RangeError);
    expect(() => stochastic([1, 2], [1, 2], [1], 2, 3)).toThrow(RangeError);
  });

  it('is length-preserving', () => {
    const n = 30;
    const highs = new Array(n).fill(10);
    const lows = new Array(n).fill(0);
    const closes = Array.from({ length: n }, (_, i) => (i % 10));
    const s = stochastic(highs, lows, closes, 14, 3);
    expect(s.k).toHaveLength(n);
    expect(s.d).toHaveLength(n);
  });
});
