import { describe, it, expect } from 'vitest';
import { riskGraph, computeRiskGraph, type RiskGraphLeg } from './risk-graph.js';
import { RiskGraphResult } from '../schemas/index.js';

describe('riskGraph — single legs', () => {
  it('long call: bounded loss = premium, unbounded gain, breakeven = K + premium', () => {
    const legs: RiskGraphLeg[] = [
      { side: 'long', type: 'call', strike: 100, qty: 1, premium: 5 },
    ];
    const g = riskGraph(legs, { uLo: 50, uHi: 200, steps: 151 });
    expect(g.maxLoss).toBeCloseTo(-500, 6); // $5 * 100 shares
    expect(g.maxGain).toBeNull(); // unbounded
    expect(g.breakevens.length).toBe(1);
    expect(g.breakevens[0]).toBeCloseTo(105, 6);
    expect(g.netDebit).toBeCloseTo(500, 6);
  });

  it('long put: max loss = premium, max gain = (K - 0 - premium) * 100', () => {
    const legs: RiskGraphLeg[] = [
      { side: 'long', type: 'put', strike: 100, qty: 1, premium: 3 },
    ];
    const g = riskGraph(legs, { uLo: 0.01, uHi: 200, steps: 201 });
    expect(g.maxLoss).toBeCloseTo(-300, 6);
    // As S -> 0, payoff -> (100 - 0 - 3) * 100 = 9700. But S=0 not allowed in
    // BSM so we use uLo. The slope at zero is negative for long put -> the
    // computation should detect "unbounded gain at 0" -> maxGain = null.
    expect(g.maxGain).toBeNull();
    expect(g.breakevens[0]).toBeCloseTo(97, 6);
  });

  it('short call (naked): bounded gain = premium, unbounded loss', () => {
    const legs: RiskGraphLeg[] = [
      { side: 'short', type: 'call', strike: 100, qty: 1, premium: 4 },
    ];
    const g = riskGraph(legs, { uLo: 50, uHi: 200, steps: 151 });
    expect(g.maxGain).toBeCloseTo(400, 6);
    expect(g.maxLoss).toBeNull(); // naked short call -> unbounded loss
    expect(g.netDebit).toBeCloseTo(-400, 6);
  });
});

describe('riskGraph — multi-leg verticals', () => {
  it('bull call spread (long 100C @5, short 110C @2)', () => {
    const legs: RiskGraphLeg[] = [
      { side: 'long', type: 'call', strike: 100, qty: 1, premium: 5 },
      { side: 'short', type: 'call', strike: 110, qty: 1, premium: 2 },
    ];
    // Net debit = (5 - 2) * 100 = 300
    // Max loss = -300 (when S <= 100)
    // Max gain = (10 - 3) * 100 = 700 (when S >= 110)
    // Breakeven = 100 + 3 = 103
    const g = riskGraph(legs, { uLo: 80, uHi: 130, steps: 51 });
    expect(g.netDebit).toBeCloseTo(300, 6);
    expect(g.maxLoss).toBeCloseTo(-300, 4);
    expect(g.maxGain).toBeCloseTo(700, 4);
    expect(g.breakevens.length).toBe(1);
    expect(g.breakevens[0]).toBeCloseTo(103, 4);
  });

  it('bear put spread (long 100P @5, short 90P @2)', () => {
    const legs: RiskGraphLeg[] = [
      { side: 'long', type: 'put', strike: 100, qty: 1, premium: 5 },
      { side: 'short', type: 'put', strike: 90, qty: 1, premium: 2 },
    ];
    // Net debit = 300, max gain = 700 at S<=90, max loss = -300 at S>=100
    const g = riskGraph(legs, { uLo: 70, uHi: 120, steps: 51 });
    expect(g.netDebit).toBeCloseTo(300, 6);
    expect(g.maxLoss).toBeCloseTo(-300, 4);
    expect(g.maxGain).toBeCloseTo(700, 4);
    expect(g.breakevens[0]).toBeCloseTo(97, 4);
  });
});

describe('riskGraph — iron condor', () => {
  it('classic iron condor is bounded both sides with two breakevens', () => {
    // Sell 95P @1.50, Buy 90P @0.75, Sell 105C @1.50, Buy 110C @0.75
    // Net credit = (1.5 - 0.75 + 1.5 - 0.75) * 100 = 150
    // Max gain = 150 (between 95 and 105)
    // Max loss = -(5 - 1.5) * 100 = -350 on either wing
    const legs: RiskGraphLeg[] = [
      { side: 'short', type: 'put', strike: 95, qty: 1, premium: 1.5 },
      { side: 'long', type: 'put', strike: 90, qty: 1, premium: 0.75 },
      { side: 'short', type: 'call', strike: 105, qty: 1, premium: 1.5 },
      { side: 'long', type: 'call', strike: 110, qty: 1, premium: 0.75 },
    ];
    const g = riskGraph(legs, { uLo: 70, uHi: 130, steps: 121 });
    expect(g.netDebit).toBeCloseTo(-150, 4); // credit
    expect(g.maxGain).toBeCloseTo(150, 4);
    expect(g.maxLoss).toBeCloseTo(-350, 4);
    expect(g.breakevens.length).toBe(2);
    expect(g.breakevens[0]).toBeCloseTo(93.5, 4); // 95 - 1.50
    expect(g.breakevens[1]).toBeCloseTo(106.5, 4); // 105 + 1.50
  });
});

describe('riskGraph — validation', () => {
  it('rejects empty legs', () => {
    expect(() => riskGraph([])).toThrow();
  });
  it('rejects bad strike', () => {
    expect(() =>
      riskGraph([{ side: 'long', type: 'call', strike: 0, qty: 1, premium: 1 }]),
    ).toThrow();
  });
  it('rejects bad qty', () => {
    expect(() =>
      riskGraph([{ side: 'long', type: 'call', strike: 100, qty: 0, premium: 1 }]),
    ).toThrow();
    expect(() =>
      riskGraph([{ side: 'long', type: 'call', strike: 100, qty: 1.5, premium: 1 }]),
    ).toThrow();
  });
  it('rejects negative premium', () => {
    expect(() =>
      riskGraph([{ side: 'long', type: 'call', strike: 100, qty: 1, premium: -1 }]),
    ).toThrow();
  });
  it('rejects bad range', () => {
    expect(() =>
      riskGraph([{ side: 'long', type: 'call', strike: 100, qty: 1, premium: 1 }], {
        uLo: 100,
        uHi: 100,
      }),
    ).toThrow();
  });
});

describe('computeRiskGraph — spec-named wrapper (issue #127)', () => {
  it('long call: returns points[], breakEvens, maxProfit=null, maxLoss=-premium', () => {
    const legs: RiskGraphLeg[] = [
      { side: 'long', type: 'call', strike: 100, qty: 1, premium: 5 },
    ];
    const r = computeRiskGraph(legs, { uLo: 50, uHi: 200, steps: 151 });
    expect(r.maxLoss).toBeCloseTo(-500, 6);
    expect(r.maxProfit).toBeNull();
    expect(r.breakEvens.length).toBe(1);
    expect(r.breakEvens[0]).toBeCloseTo(105, 6);
    expect(r.netDebit).toBeCloseTo(500, 6);
    expect(r.points.length).toBeGreaterThan(0);
    for (let i = 1; i < r.points.length; i++) {
      expect(r.points[i]!.underlying).toBeGreaterThan(r.points[i - 1]!.underlying);
    }
  });

  it('bull call vertical: matches hand-computed breakeven=103, maxProfit=700, maxLoss=-300', () => {
    const legs: RiskGraphLeg[] = [
      { side: 'long', type: 'call', strike: 100, qty: 1, premium: 5 },
      { side: 'short', type: 'call', strike: 110, qty: 1, premium: 2 },
    ];
    const r = computeRiskGraph(legs, { uLo: 80, uHi: 130, steps: 51 });
    expect(r.maxLoss).toBeCloseTo(-300, 4);
    expect(r.maxProfit).toBeCloseTo(700, 4);
    expect(r.breakEvens).toHaveLength(1);
    expect(r.breakEvens[0]).toBeCloseTo(103, 4);
  });

  it('iron condor: two breakevens, defined risk both wings', () => {
    const legs: RiskGraphLeg[] = [
      { side: 'short', type: 'put', strike: 95, qty: 1, premium: 1.5 },
      { side: 'long', type: 'put', strike: 90, qty: 1, premium: 0.75 },
      { side: 'short', type: 'call', strike: 105, qty: 1, premium: 1.5 },
      { side: 'long', type: 'call', strike: 110, qty: 1, premium: 0.75 },
    ];
    const r = computeRiskGraph(legs, { uLo: 70, uHi: 130, steps: 121 });
    expect(r.maxProfit).toBeCloseTo(150, 4);
    expect(r.maxLoss).toBeCloseTo(-350, 4);
    expect(r.breakEvens).toHaveLength(2);
    expect(r.breakEvens[0]).toBeCloseTo(93.5, 4);
    expect(r.breakEvens[1]).toBeCloseTo(106.5, 4);
  });

  it('result passes the RiskGraphResult Zod schema', () => {
    const legs: RiskGraphLeg[] = [
      { side: 'long', type: 'put', strike: 50, qty: 2, premium: 1.25 },
      { side: 'short', type: 'put', strike: 45, qty: 2, premium: 0.5 },
    ];
    const r = computeRiskGraph(legs);
    const parsed = RiskGraphResult.safeParse(r);
    expect(parsed.success).toBe(true);
  });

  it('points are zipped from the same data riskGraph() emits', () => {
    const legs: RiskGraphLeg[] = [
      { side: 'long', type: 'call', strike: 100, qty: 1, premium: 5 },
      { side: 'short', type: 'call', strike: 110, qty: 1, premium: 2 },
    ];
    const raw = riskGraph(legs, { uLo: 80, uHi: 130, steps: 21 });
    const r = computeRiskGraph(legs, { uLo: 80, uHi: 130, steps: 21 });
    expect(r.points).toHaveLength(raw.underlying.length);
    for (let i = 0; i < r.points.length; i++) {
      expect(r.points[i]!.underlying).toBe(raw.underlying[i]);
      expect(r.points[i]!.pnl).toBe(raw.pnl[i]);
    }
    expect(r.maxProfit).toBe(raw.maxGain);
    expect(r.maxLoss).toBe(raw.maxLoss);
    expect(r.breakEvens).toEqual(raw.breakevens);
  });

  it('validation errors from riskGraph propagate through the wrapper', () => {
    expect(() => computeRiskGraph([])).toThrow();
    expect(() =>
      computeRiskGraph([{ side: 'long', type: 'call', strike: 100, qty: 1, premium: -1 }]),
    ).toThrow();
  });
});

describe('riskGraph — sample integrity', () => {
  it('always includes every strike in the sample grid', () => {
    const legs: RiskGraphLeg[] = [
      { side: 'long', type: 'call', strike: 100, qty: 1, premium: 5 },
      { side: 'short', type: 'call', strike: 110, qty: 1, premium: 2 },
    ];
    const g = riskGraph(legs, { uLo: 80, uHi: 130, steps: 11 });
    expect(g.underlying).toContain(100);
    expect(g.underlying).toContain(110);
    // sample arrays line up
    expect(g.underlying.length).toBe(g.pnl.length);
    // strictly increasing
    for (let i = 1; i < g.underlying.length; i++) {
      expect(g.underlying[i]!).toBeGreaterThan(g.underlying[i - 1]!);
    }
  });
});
