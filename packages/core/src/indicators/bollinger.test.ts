/**
 * Tests for `bollinger()` (issue #140).
 *
 * Uses hand-computed fixtures for tiny series so the values are pinned to
 * the canonical Bollinger definition (SMA \u00b1 mult * population stdev).
 * Deterministic, pure, no network.
 */
import { describe, it, expect } from 'vitest';
import { bollinger } from './index.js';

const EPS = 1e-9;

describe('bollinger', () => {
  it('returns nulls for the first period-1 slots and finite bands afterwards', () => {
    const closes = [1, 2, 3, 4, 5];
    const bb = bollinger(closes, 5, 2);
    // First 4 slots should be null; last slot filled.
    for (let i = 0; i < 4; i++) {
      expect(bb.middle[i]).toBeNull();
      expect(bb.upper[i]).toBeNull();
      expect(bb.lower[i]).toBeNull();
    }
    expect(bb.middle[4]).toBeCloseTo(3, 9);
    // Population stdev of [1..5] = sqrt(2) \u2248 1.4142135623730951
    const sd = Math.sqrt(2);
    expect(bb.upper[4]).toBeCloseTo(3 + 2 * sd, 9);
    expect(bb.lower[4]).toBeCloseTo(3 - 2 * sd, 9);
  });

  it('produces zero-width bands for a constant series', () => {
    const closes = new Array(30).fill(42);
    const bb = bollinger(closes, 20, 2);
    for (let i = 19; i < 30; i++) {
      expect(bb.middle[i]).toBeCloseTo(42, 9);
      expect(bb.upper[i]).toBeCloseTo(42, 9);
      expect(bb.lower[i]).toBeCloseTo(42, 9);
    }
  });

  it('respects the mult parameter', () => {
    const closes = [10, 12, 14, 16, 18];
    const bb1 = bollinger(closes, 5, 1);
    const bb2 = bollinger(closes, 5, 2);
    const mid = bb1.middle[4]!;
    const sd = bb1.upper[4]! - mid;
    expect(sd).toBeGreaterThan(0);
    expect(bb2.upper[4]! - mid).toBeCloseTo(2 * sd, 9);
    expect(mid - bb2.lower[4]!).toBeCloseTo(2 * sd, 9);
  });

  it('is length-preserving', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 4) * 3);
    const bb = bollinger(closes, 20, 2);
    expect(bb.middle).toHaveLength(50);
    expect(bb.upper).toHaveLength(50);
    expect(bb.lower).toHaveLength(50);
  });

  it('keeps upper >= middle >= lower everywhere non-null', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + (i % 7) * 0.5);
    const bb = bollinger(closes, 20, 2);
    for (let i = 0; i < 40; i++) {
      const m = bb.middle[i];
      const u = bb.upper[i];
      const l = bb.lower[i];
      if (m == null) {
        expect(u).toBeNull();
        expect(l).toBeNull();
        continue;
      }
      expect(u! - m).toBeGreaterThan(-EPS);
      expect(m - l!).toBeGreaterThan(-EPS);
    }
  });

  it('matches a hand-computed 4-bar window', () => {
    // Population stdev of [2,4,4,4,5,5,7,9] is exactly 2.
    // Middle = mean = 5, so upper(k=1) = 7, lower(k=1) = 3.
    const closes = [2, 4, 4, 4, 5, 5, 7, 9];
    const bb = bollinger(closes, 8, 1);
    expect(bb.middle[7]).toBeCloseTo(5, 9);
    expect(bb.upper[7]).toBeCloseTo(7, 9);
    expect(bb.lower[7]).toBeCloseTo(3, 9);
  });

  it('throws on invalid period', () => {
    expect(() => bollinger([1, 2, 3], 0, 2)).toThrow(RangeError);
    expect(() => bollinger([1, 2, 3], -1, 2)).toThrow(RangeError);
  });

  it('throws on non-finite mult', () => {
    expect(() => bollinger([1, 2, 3], 3, Number.NaN)).toThrow(RangeError);
    expect(() => bollinger([1, 2, 3], 3, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
