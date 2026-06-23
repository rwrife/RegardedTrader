import { describe, expect, it } from 'vitest';
import { buildChainRows } from './options.js';
import type { OptionContract } from '@regardedtrader/core';

function call(strike: number, over: Partial<OptionContract> = {}): OptionContract {
  return {
    symbol: `NVDA-C-${strike}`,
    underlying: 'NVDA',
    expiry: '2026-12-18',
    strike,
    type: 'call',
    bid: 1,
    ask: 1.2,
    last: 1.1,
    volume: 10,
    openInterest: 100,
    iv: 0.35,
    ...over,
  };
}

function put(strike: number, over: Partial<OptionContract> = {}): OptionContract {
  return { ...call(strike, over), type: 'put', symbol: `NVDA-P-${strike}` };
}

describe('OptionsScreen / buildChainRows', () => {
  it('filters by expiry and fills greeks when spot is provided', () => {
    const rows = buildChainRows(
      [call(150), put(150), call(160, { expiry: '2027-01-15' })],
      { spot: 150, asOf: '2026-01-01T00:00:00Z', expiry: '2026-12-18' },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.strike).toBe(150);
    expect(rows[0]!.call?.delta).not.toBeNull();
    expect(rows[0]!.put?.delta).not.toBeNull();
  });

  it('passes greeks through unchanged when spot is missing', () => {
    const rows = buildChainRows([call(150, { delta: null })], { spot: null });
    expect(rows[0]!.call?.delta ?? null).toBeNull();
  });

  it('sorts rows by strike ascending and pairs call/put per strike', () => {
    const rows = buildChainRows(
      [call(160), put(140), call(140), put(160)],
      { spot: 150, asOf: '2026-01-01T00:00:00Z' },
    );
    expect(rows.map((r) => r.strike)).toEqual([140, 160]);
    expect(rows[0]!.call).not.toBeNull();
    expect(rows[0]!.put).not.toBeNull();
    expect(rows[1]!.call).not.toBeNull();
    expect(rows[1]!.put).not.toBeNull();
  });

  it('returns an empty array when input is empty', () => {
    expect(buildChainRows([], { spot: 150 })).toEqual([]);
  });

  it('keeps non-matching-expiry rows out when expiry filter is set', () => {
    const rows = buildChainRows(
      [call(150, { expiry: '2026-12-18' }), call(160, { expiry: '2027-01-15' })],
      { spot: 150, expiry: '2026-12-18' },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.strike).toBe(150);
  });
});
