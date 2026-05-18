import { describe, it, expect } from 'vitest';
import { computeRating, RatingSchema, StockRatingSchema } from './rating.js';

const ASOF = '2024-06-12T15:30:00Z';

describe('RatingSchema', () => {
  it('accepts the four valid buckets', () => {
    for (const r of ['SELL', 'HOLD', 'BUY', 'YOLO'] as const) {
      expect(RatingSchema.parse(r)).toBe(r);
    }
  });
  it('rejects anything else', () => {
    expect(() => RatingSchema.parse('UNKNOWN')).toThrow();
  });
});

describe('computeRating - buckets', () => {
  it('a sharp dump with heavy volume → SELL', () => {
    const r = computeRating({
      symbol: 'XYZ',
      changePercent: -15,
      volumeRatio: 0.5,
      asOf: ASOF,
    });
    expect(r.rating).toBe('SELL');
    expect(r.score).toBeLessThan(25);
    expect(StockRatingSchema.parse(r)).toEqual(r);
  });

  it('a flat day → HOLD', () => {
    const r = computeRating({
      symbol: 'XYZ',
      changePercent: 0,
      volumeRatio: 1,
      asOf: ASOF,
    });
    expect(r.rating).toBe('HOLD');
    expect(r.score).toBe(50);
  });

  it('a solid rip with above-avg volume → BUY', () => {
    const r = computeRating({
      symbol: 'XYZ',
      changePercent: 4,
      volumeRatio: 2,
      asOf: ASOF,
    });
    expect(r.rating).toBe('BUY');
    expect(r.score).toBeGreaterThanOrEqual(55);
    expect(r.score).toBeLessThan(85);
  });

  it('an absolute moonshot with squeeze fuel → YOLO', () => {
    const r = computeRating({
      symbol: 'XYZ',
      changePercent: 20,
      volumeRatio: 5,
      rsi: 85,
      shortInterest: 0.3,
      asOf: ASOF,
    });
    expect(r.rating).toBe('YOLO');
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.reasons.some((s) => s.includes('squeeze'))).toBe(true);
  });
});

describe('computeRating - boundaries', () => {
  it('clamps the score to [0, 100]', () => {
    const floor = computeRating({
      symbol: 'XYZ',
      changePercent: -100,
      volumeRatio: 0,
      rsi: 10,
      asOf: ASOF,
    });
    expect(floor.score).toBeGreaterThanOrEqual(0);
    expect(floor.score).toBeLessThanOrEqual(100);
    expect(floor.rating).toBe('SELL');

    const ceil = computeRating({
      symbol: 'XYZ',
      changePercent: 100,
      volumeRatio: 100,
      rsi: 90,
      shortInterest: 0.5,
      asOf: ASOF,
    });
    expect(ceil.score).toBeLessThanOrEqual(100);
    expect(ceil.rating).toBe('YOLO');
  });

  it('boundary at score 25 → HOLD (just inside)', () => {
    // start 50, changePercent = -12.5 → adj = -25 → score 25 → HOLD
    const r = computeRating({ symbol: 'XYZ', changePercent: -12.5, asOf: ASOF });
    expect(r.score).toBe(25);
    expect(r.rating).toBe('HOLD');
  });

  it('boundary at score 55 → BUY (just inside)', () => {
    // changePercent = 2.5 → +5, volumeRatio = 1 → 0 → score 55 → BUY
    const r = computeRating({
      symbol: 'XYZ',
      changePercent: 2.5,
      volumeRatio: 1,
      asOf: ASOF,
    });
    expect(r.score).toBe(55);
    expect(r.rating).toBe('BUY');
  });

  it('boundary at score 85 → YOLO (just inside)', () => {
    // changePercent = 12.5 → +25 (clamped), volumeRatio = 2 → +10 → 85 → YOLO
    const r = computeRating({
      symbol: 'XYZ',
      changePercent: 12.5,
      volumeRatio: 2,
      asOf: ASOF,
    });
    expect(r.score).toBe(85);
    expect(r.rating).toBe('YOLO');
  });

  it('is deterministic for fixed inputs', () => {
    const a = computeRating({
      symbol: 'XYZ',
      changePercent: 3.2,
      volumeRatio: 2.1,
      asOf: ASOF,
    });
    const b = computeRating({
      symbol: 'XYZ',
      changePercent: 3.2,
      volumeRatio: 2.1,
      asOf: ASOF,
    });
    expect(a).toEqual(b);
  });

  it('produces human-readable reasons', () => {
    const r = computeRating({
      symbol: 'XYZ',
      changePercent: 3.2,
      volumeRatio: 2.1,
      asOf: ASOF,
    });
    expect(r.reasons).toContain('+3.2% today');
    expect(r.reasons).toContain('2.1× avg volume');
  });
});
