import { describe, expect, it } from 'vitest';
import { fillGreeks, groupChainByStrike, yearsToExpiry } from './chain.js';
import type { OptionContract } from '../schemas/index.js';

function contract(over: Partial<OptionContract>): OptionContract {
  return {
    symbol: 'NVDA250117C00150000',
    underlying: 'NVDA',
    expiry: '2026-01-17',
    strike: 150,
    type: 'call',
    bid: 5,
    ask: 5.5,
    last: 5.25,
    volume: 100,
    openInterest: 1000,
    iv: 0.4,
    ...over,
  };
}

describe('groupChainByStrike', () => {
  it('pairs calls and puts at the same strike', () => {
    const rows = groupChainByStrike([
      contract({ strike: 150, type: 'call' }),
      contract({ strike: 150, type: 'put', symbol: 'P150' }),
      contract({ strike: 160, type: 'call' }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.strike).toBe(150);
    expect(rows[0]!.call?.type).toBe('call');
    expect(rows[0]!.put?.type).toBe('put');
    expect(rows[1]!.strike).toBe(160);
    expect(rows[1]!.put).toBeNull();
  });

  it('sorts rows by strike ascending', () => {
    const rows = groupChainByStrike([
      contract({ strike: 200 }),
      contract({ strike: 100 }),
      contract({ strike: 150 }),
    ]);
    expect(rows.map((r) => r.strike)).toEqual([100, 150, 200]);
  });

  it('keeps the first contract when duplicates appear', () => {
    const rows = groupChainByStrike([
      contract({ strike: 150, type: 'call', symbol: 'A' }),
      contract({ strike: 150, type: 'call', symbol: 'B' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.call?.symbol).toBe('A');
  });

  it('returns an empty array for empty input', () => {
    expect(groupChainByStrike([])).toEqual([]);
  });
});

describe('yearsToExpiry', () => {
  it('returns a positive year fraction for a future expiry', () => {
    const t = yearsToExpiry('2026-01-01T00:00:00Z', '2026-12-31');
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(0.9);
    expect(t!).toBeLessThan(1.05);
  });

  it('returns null for an expired contract', () => {
    expect(yearsToExpiry('2026-06-01T00:00:00Z', '2026-01-01')).toBeNull();
  });

  it('returns null for unparseable inputs', () => {
    expect(yearsToExpiry('not-a-date', '2026-01-01')).toBeNull();
    expect(yearsToExpiry('2026-01-01T00:00:00Z', 'nope')).toBeNull();
  });
});

describe('fillGreeks', () => {
  it('fills missing greeks for ATM contracts with valid IV', () => {
    const [filled] = fillGreeks(
      [contract({ delta: null, gamma: null, theta: null, vega: null })],
      { spot: 150, asOf: '2026-01-01T00:00:00Z' },
    );
    expect(filled!.delta).not.toBeNull();
    expect(filled!.gamma).not.toBeNull();
    expect(filled!.theta).not.toBeNull();
    expect(filled!.vega).not.toBeNull();
    // ATM call delta ~ 0.5
    expect(filled!.delta!).toBeGreaterThan(0.3);
    expect(filled!.delta!).toBeLessThan(0.7);
  });

  it('preserves greeks provided by the upstream feed', () => {
    const [filled] = fillGreeks(
      [contract({ delta: 0.99, gamma: 0.01, theta: -0.5, vega: 0.2 })],
      { spot: 150, asOf: '2026-01-01T00:00:00Z' },
    );
    expect(filled!.delta).toBe(0.99);
    expect(filled!.gamma).toBe(0.01);
    expect(filled!.theta).toBe(-0.5);
    expect(filled!.vega).toBe(0.2);
  });

  it('skips contracts with no IV', () => {
    const [filled] = fillGreeks(
      [contract({ iv: null, delta: null })],
      { spot: 150, asOf: '2026-01-01T00:00:00Z' },
    );
    expect(filled!.delta ?? null).toBeNull();
  });

  it('skips contracts with non-positive IV', () => {
    const [filled] = fillGreeks(
      [contract({ iv: 0, delta: null })],
      { spot: 150, asOf: '2026-01-01T00:00:00Z' },
    );
    expect(filled!.delta ?? null).toBeNull();
  });

  it('skips contracts whose expiry is in the past', () => {
    const [filled] = fillGreeks(
      [contract({ expiry: '2025-01-01', delta: null })],
      { spot: 150, asOf: '2026-01-01T00:00:00Z' },
    );
    expect(filled!.delta ?? null).toBeNull();
  });

  it('skips when spot is non-positive', () => {
    const [filled] = fillGreeks(
      [contract({ delta: null })],
      { spot: 0, asOf: '2026-01-01T00:00:00Z' },
    );
    expect(filled!.delta ?? null).toBeNull();
  });

  it('rescales theta to per-day and vega to per-1%-vol', () => {
    // Same contract, deep ITM put should have small positive theta-per-day
    // (in absolute value) and small vega-per-1%.
    const [filled] = fillGreeks(
      [contract({ strike: 150, type: 'put', delta: null, theta: null, vega: null })],
      { spot: 150, asOf: '2026-01-01T00:00:00Z' },
    );
    // Per-day theta and per-1% vega should be small (|x| < 1 for a $150
    // underlying with ~1y to expiry, 40% IV).
    expect(Math.abs(filled!.theta!)).toBeLessThan(1);
    expect(Math.abs(filled!.vega!)).toBeLessThan(1);
  });
});
