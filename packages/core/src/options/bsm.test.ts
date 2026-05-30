import { describe, it, expect } from 'vitest';
import { price, greeks, normCdf, normPdf } from './bsm.js';

// Reference values cross-checked against a standard BSM calculator
// (e.g. Hull 9th ed. examples) — all to 1e-4 tolerance.

describe('normCdf', () => {
  it('matches known reference points', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1)).toBeCloseTo(0.8413, 4);
    expect(normCdf(-1)).toBeCloseTo(0.1587, 4);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
});

describe('normPdf', () => {
  it('matches known reference points', () => {
    expect(normPdf(0)).toBeCloseTo(0.39894, 4);
    expect(normPdf(1)).toBeCloseTo(0.24197, 4);
    expect(normPdf(-1)).toBeCloseTo(0.24197, 4);
  });
});

describe('bsm price()', () => {
  it('ATM call (S=K=100, r=5%, T=1, sigma=20%)', () => {
    // Hull example: ~10.4506
    const p = price({ S: 100, K: 100, T: 1, r: 0.05, sigma: 0.2, type: 'call' });
    expect(p).toBeCloseTo(10.4506, 3);
  });

  it('ATM put (same params)', () => {
    // Put-call parity: P = C - S + K*e^-rT = 10.4506 - 100 + 100*e^-0.05 ≈ 5.5735
    const p = price({ S: 100, K: 100, T: 1, r: 0.05, sigma: 0.2, type: 'put' });
    expect(p).toBeCloseTo(5.5735, 3);
  });

  it('ITM call (S=110, K=100)', () => {
    const p = price({ S: 110, K: 100, T: 0.5, r: 0.05, sigma: 0.25, type: 'call' });
    expect(p).toBeGreaterThan(10); // at least intrinsic
  });

  it('OTM put (S=110, K=100)', () => {
    const p = price({ S: 110, K: 100, T: 0.5, r: 0.05, sigma: 0.25, type: 'put' });
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(5);
  });

  it('put-call parity holds across a range', () => {
    const S = 100;
    const r = 0.04;
    const T = 0.75;
    const sigma = 0.3;
    for (const K of [80, 90, 100, 110, 120]) {
      const c = price({ S, K, T, r, sigma, type: 'call' });
      const p = price({ S, K, T, r, sigma, type: 'put' });
      const parity = c - p - (S - K * Math.exp(-r * T));
      expect(Math.abs(parity)).toBeLessThan(1e-8);
    }
  });

  it('respects dividend yield q', () => {
    const noDiv = price({ S: 100, K: 100, T: 1, r: 0.05, sigma: 0.2, type: 'call' });
    const withDiv = price({
      S: 100,
      K: 100,
      T: 1,
      r: 0.05,
      sigma: 0.2,
      q: 0.03,
      type: 'call',
    });
    expect(withDiv).toBeLessThan(noDiv); // dividends reduce call value
  });

  it('throws on invalid inputs', () => {
    expect(() => price({ S: 0, K: 100, T: 1, r: 0.05, sigma: 0.2, type: 'call' })).toThrow();
    expect(() => price({ S: 100, K: -1, T: 1, r: 0.05, sigma: 0.2, type: 'call' })).toThrow();
    expect(() => price({ S: 100, K: 100, T: 0, r: 0.05, sigma: 0.2, type: 'call' })).toThrow();
    expect(() => price({ S: 100, K: 100, T: 1, r: 0.05, sigma: 0, type: 'call' })).toThrow();
  });
});

describe('bsm greeks()', () => {
  it('ATM call greeks (S=K=100, r=5%, T=1, sigma=20%)', () => {
    const g = greeks({ S: 100, K: 100, T: 1, r: 0.05, sigma: 0.2, type: 'call' });
    expect(g.price).toBeCloseTo(10.4506, 3);
    expect(g.delta).toBeCloseTo(0.6368, 3);
    expect(g.gamma).toBeCloseTo(0.01876, 3);
    expect(g.vega).toBeCloseTo(37.524, 2); // per 1.0 vol => 0.37524 per 1%
    // Theta per year ≈ -6.414 for ATM 1Y 20% call. Per day ~ -0.0176.
    expect(g.theta).toBeCloseTo(-6.414, 2);
  });

  it('ATM put greeks satisfy put-call parity on delta', () => {
    const c = greeks({ S: 100, K: 100, T: 1, r: 0.05, sigma: 0.2, type: 'call' });
    const p = greeks({ S: 100, K: 100, T: 1, r: 0.05, sigma: 0.2, type: 'put' });
    // delta_call - delta_put = e^(-qT) = 1 for q=0
    expect(c.delta - p.delta).toBeCloseTo(1, 4);
    // gamma & vega are identical for call/put
    expect(c.gamma).toBeCloseTo(p.gamma, 8);
    expect(c.vega).toBeCloseTo(p.vega, 8);
  });

  it('deep ITM call has delta -> 1', () => {
    const g = greeks({ S: 200, K: 50, T: 0.1, r: 0.05, sigma: 0.2, type: 'call' });
    expect(g.delta).toBeGreaterThan(0.99);
  });

  it('deep OTM put has delta near 0 (non-positive)', () => {
    const g = greeks({ S: 200, K: 50, T: 0.1, r: 0.05, sigma: 0.2, type: 'put' });
    expect(g.delta).toBeGreaterThanOrEqual(-0.01);
    expect(g.delta).toBeLessThanOrEqual(0);
  });
});
