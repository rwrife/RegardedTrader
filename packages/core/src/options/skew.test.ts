import { describe, expect, it } from 'vitest';
import type { OptionContract } from '../schemas/index.js';
import { computeSkew } from './skew.js';

function contract(over: Partial<OptionContract>): OptionContract {
  return {
    symbol: 'NVDA260619C00100000',
    underlying: 'NVDA',
    expiry: '2026-06-19',
    strike: 100,
    type: 'call',
    bid: 2,
    ask: 2.2,
    last: 2.1,
    volume: 100,
    openInterest: 300,
    iv: 0.3,
    ...over,
  };
}

describe('computeSkew', () => {
  it('returns smile-like points with higher wing IV and ATM IV', () => {
    const rows = computeSkew(
      [
        contract({ strike: 90, type: 'call', iv: 0.42 }),
        contract({ strike: 100, type: 'call', iv: 0.3 }),
        contract({ strike: 110, type: 'call', iv: 0.41 }),
        contract({ strike: 90, type: 'put', symbol: 'NVDA-P-90', iv: 0.44 }),
        contract({ strike: 100, type: 'put', symbol: 'NVDA-P-100', iv: 0.31 }),
        contract({ strike: 110, type: 'put', symbol: 'NVDA-P-110', iv: 0.43 }),
      ],
      { spot: 100 },
    );

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.callIv.map((p) => p.strike)).toEqual([90, 100, 110]);
    expect(row?.putIv.map((p) => p.strike)).toEqual([90, 100, 110]);
    expect(row?.atmIv).toBeCloseTo(0.305, 3);
    expect(row?.callIv[0]!.iv).toBeGreaterThan(row?.callIv[1]!.iv ?? 0);
    expect(row?.callIv[2]!.iv).toBeGreaterThan(row?.callIv[1]!.iv ?? 0);
    expect(row?.gappy).toBe(false);
  });

  it('handles a flat curve', () => {
    const rows = computeSkew(
      [
        contract({ strike: 90, iv: 0.25 }),
        contract({ strike: 100, iv: 0.25 }),
        contract({ strike: 110, iv: 0.25 }),
        contract({ strike: 90, type: 'put', symbol: 'P-90', iv: 0.25 }),
        contract({ strike: 100, type: 'put', symbol: 'P-100', iv: 0.25 }),
        contract({ strike: 110, type: 'put', symbol: 'P-110', iv: 0.25 }),
      ],
      { spot: 100 },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.atmIv).toBeCloseTo(0.25, 8);
  });

  it('marks gappy chains and still returns partial series', () => {
    const rows = computeSkew(
      [
        contract({ strike: 90, iv: 0.38 }),
        contract({ strike: 100, iv: null }),
        contract({ strike: 110, iv: 0.37 }),
        contract({ strike: 90, type: 'put', symbol: 'P-90', iv: null }),
        contract({ strike: 100, type: 'put', symbol: 'P-100', iv: 0.32 }),
        contract({ strike: 110, type: 'put', symbol: 'P-110', iv: 0.39 }),
      ],
      { spot: 100 },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.gappy).toBe(true);
    expect(rows[0]!.callIv.length).toBe(2);
    expect(rows[0]!.putIv.length).toBe(2);
  });

  it('interpolates ATM IV when there is no exact ATM strike', () => {
    const rows = computeSkew(
      [
        contract({ strike: 95, iv: 0.34 }),
        contract({ strike: 105, iv: 0.36 }),
        contract({ strike: 95, type: 'put', symbol: 'P-95', iv: 0.35 }),
        contract({ strike: 105, type: 'put', symbol: 'P-105', iv: 0.37 }),
      ],
      { spot: 100 },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.atmIv).toBeCloseTo(0.355, 3);
  });
});
