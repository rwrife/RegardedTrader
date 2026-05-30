import { describe, it, expect } from 'vitest';
import { impliedVol } from './iv.js';
import { price } from './bsm.js';

describe('impliedVol', () => {
  it('round-trips for an ATM call', () => {
    const S = 100,
      K = 100,
      T = 1,
      r = 0.05,
      sigma = 0.25;
    const mkt = price({ S, K, T, r, sigma, type: 'call' });
    const iv = impliedVol({ marketPrice: mkt, S, K, T, r, type: 'call' });
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(sigma, 4);
  });

  it('round-trips for an OTM put', () => {
    const S = 110,
      K = 100,
      T = 0.5,
      r = 0.04,
      sigma = 0.32;
    const mkt = price({ S, K, T, r, sigma, type: 'put' });
    const iv = impliedVol({ marketPrice: mkt, S, K, T, r, type: 'put' });
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(sigma, 4);
  });

  it('round-trips for an ITM call with dividend', () => {
    const S = 105,
      K = 100,
      T = 0.75,
      r = 0.05,
      q = 0.02,
      sigma = 0.18;
    const mkt = price({ S, K, T, r, sigma, q, type: 'call' });
    const iv = impliedVol({ marketPrice: mkt, S, K, T, r, q, type: 'call' });
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(sigma, 4);
  });

  it('returns null for prices above the upper bound', () => {
    // A call cannot be worth more than S*e^(-qT).
    const iv = impliedVol({ marketPrice: 200, S: 100, K: 100, T: 1, r: 0.05, type: 'call' });
    expect(iv).toBeNull();
  });

  it('returns null for non-positive market price', () => {
    expect(impliedVol({ marketPrice: 0, S: 100, K: 100, T: 1, r: 0.05, type: 'call' })).toBeNull();
    expect(impliedVol({ marketPrice: -1, S: 100, K: 100, T: 1, r: 0.05, type: 'call' })).toBeNull();
  });

  it('converges across a wide sigma sweep', () => {
    for (const sigma of [0.05, 0.1, 0.3, 0.6, 1.2, 2.5]) {
      const mkt = price({ S: 100, K: 100, T: 0.5, r: 0.05, sigma, type: 'call' });
      const iv = impliedVol({
        marketPrice: mkt,
        S: 100,
        K: 100,
        T: 0.5,
        r: 0.05,
        type: 'call',
      });
      expect(iv).not.toBeNull();
      expect(iv!).toBeCloseTo(sigma, 3);
    }
  });
});
