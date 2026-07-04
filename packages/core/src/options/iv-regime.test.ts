/**
 * Tests for `ivRank` / `ivPercentile` / `ivRegime` (issue #140).
 *
 * Pure, deterministic, no network. Uses hand-computed fixtures for the
 * canonical definitions.
 */
import { describe, it, expect } from 'vitest';
import { ivRank, ivPercentile, ivRegime, IvRegimeSchema } from './iv-regime.js';

describe('ivRank', () => {
  it('is 0 when current equals the historical min', () => {
    expect(
      ivRank({ current: 0.15, history: [0.15, 0.25, 0.35, 0.45, 0.55] }),
    ).toBeCloseTo(0, 9);
  });

  it('is 100 when current equals the historical max', () => {
    expect(
      ivRank({ current: 0.55, history: [0.15, 0.25, 0.35, 0.45, 0.55] }),
    ).toBeCloseTo(100, 9);
  });

  it('scales linearly between min and max', () => {
    // History min=0, max=1, current=0.25 -> rank=25.
    expect(ivRank({ current: 0.25, history: [0, 0.5, 1] })).toBeCloseTo(25, 9);
    expect(ivRank({ current: 0.75, history: [0, 0.5, 1] })).toBeCloseTo(75, 9);
  });

  it('clamps out-of-sample current values into [0,100]', () => {
    expect(ivRank({ current: -1, history: [0, 0.5, 1] })).toBe(0);
    expect(ivRank({ current: 2, history: [0, 0.5, 1] })).toBe(100);
  });

  it('returns null for an empty history', () => {
    expect(ivRank({ current: 0.3, history: [] })).toBeNull();
  });

  it('returns null for a flat history (min === max)', () => {
    expect(ivRank({ current: 0.25, history: [0.25, 0.25, 0.25] })).toBeNull();
  });

  it('returns null when current is not finite', () => {
    expect(ivRank({ current: Number.NaN, history: [0.1, 0.2, 0.3] })).toBeNull();
    expect(ivRank({ current: Infinity, history: [0.1, 0.2, 0.3] })).toBeNull();
  });

  it('ignores non-finite history entries', () => {
    // Effective history [0.2, 0.4]; current=0.3 -> rank = 50.
    expect(
      ivRank({ current: 0.3, history: [0.2, Number.NaN, 0.4, Infinity] }),
    ).toBeCloseTo(50, 9);
  });
});

describe('ivPercentile', () => {
  it('is 0 when nothing is below current', () => {
    expect(
      ivPercentile({ current: 0.1, history: [0.1, 0.2, 0.3, 0.4] }),
    ).toBeCloseTo(0, 9);
  });

  it('is fraction-below * 100 for a spread history', () => {
    // 3 of 5 samples strictly < 0.4 -> 60.
    expect(
      ivPercentile({ current: 0.4, history: [0.1, 0.2, 0.3, 0.4, 0.5] }),
    ).toBeCloseTo(60, 9);
  });

  it('caps at 100 when current exceeds every history sample', () => {
    expect(
      ivPercentile({ current: 10, history: [0.1, 0.2, 0.3, 0.4] }),
    ).toBeCloseTo(100, 9);
  });

  it('returns null for an empty history', () => {
    expect(ivPercentile({ current: 0.3, history: [] })).toBeNull();
  });

  it('returns null when current is not finite', () => {
    expect(ivPercentile({ current: Number.NaN, history: [0.1] })).toBeNull();
  });

  it('ignores non-finite history entries in the denominator', () => {
    // Effective history [0.1, 0.3]; current=0.2 -> 1/2 * 100 = 50.
    expect(
      ivPercentile({ current: 0.2, history: [0.1, Number.NaN, 0.3, Infinity] }),
    ).toBeCloseTo(50, 9);
  });
});

describe('ivRegime', () => {
  it('returns both rank and percentile with a validated shape', () => {
    const r = ivRegime({ current: 0.4, history: [0.1, 0.2, 0.3, 0.4, 0.5] });
    expect(r.current).toBeCloseTo(0.4, 9);
    expect(r.windowSize).toBe(5);
    expect(r.rank).toBeCloseTo(75, 9);
    expect(r.percentile).toBeCloseTo(60, 9);
    expect(() => IvRegimeSchema.parse(r)).not.toThrow();
  });

  it('reports windowSize=0 with null scores on empty history', () => {
    const r = ivRegime({ current: 0.4, history: [] });
    expect(r.windowSize).toBe(0);
    expect(r.rank).toBeNull();
    expect(r.percentile).toBeNull();
    expect(() => IvRegimeSchema.parse(r)).not.toThrow();
  });
});
