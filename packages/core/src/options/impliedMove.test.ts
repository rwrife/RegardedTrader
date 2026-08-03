import { describe, expect, it } from 'vitest';
import type { OptionContract } from '../schemas/index.js';
import { computeImpliedMoves } from './impliedMove.js';

function contract(over: Partial<OptionContract>): OptionContract {
  return {
    symbol: 'NVDA260619C00150000',
    underlying: 'NVDA',
    expiry: '2026-06-19',
    strike: 150,
    type: 'call',
    bid: 4,
    ask: 4.2,
    last: 4.1,
    volume: 100,
    openInterest: 200,
    iv: 0.4,
    ...over,
  };
}

describe('computeImpliedMoves', () => {
  it('returns one ATM implied move row per expiry', () => {
    const rows = computeImpliedMoves(
      [
        contract({ expiry: '2026-06-19', strike: 150, type: 'call', bid: 4, ask: 4.2 }),
        contract({ expiry: '2026-06-19', strike: 150, type: 'put', bid: 3.8, ask: 4 }),
        contract({ expiry: '2026-07-17', strike: 150, type: 'call', bid: 5, ask: 5.2 }),
        contract({ expiry: '2026-07-17', strike: 150, type: 'put', bid: 4.9, ask: 5.1 }),
      ],
      150,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      expiry: '2026-06-19',
      straddleMid: 8,
      impliedMoveAbs: 8,
    });
    expect(rows[0]!.impliedMovePct).toBeCloseTo(8 / 150);
    expect(rows[1]!.expiry).toBe('2026-07-17');
  });

  it('interpolates when there is no exact ATM strike', () => {
    const rows = computeImpliedMoves(
      [
        contract({ strike: 145, type: 'call', bid: 6, ask: 6 }),
        contract({ strike: 145, type: 'put', bid: 1, ask: 1 }),
        contract({ strike: 155, type: 'call', bid: 2, ask: 2 }),
        contract({ strike: 155, type: 'put', bid: 5, ask: 5 }),
      ],
      150,
    );
    expect(rows).toHaveLength(1);
    // 145 straddle = 7, 155 straddle = 7 => ATM interpolates to 7.
    expect(rows[0]!.straddleMid).toBeCloseTo(7);
    expect(rows[0]!.impliedMovePct).toBeCloseTo(7 / 150);
  });

  it('skips expiries that cannot form an ATM straddle', () => {
    const rows = computeImpliedMoves(
      [
        contract({ expiry: '2026-06-19', strike: 150, type: 'call' }),
        // missing put at 150 and no bracket row -> skipped
        contract({ expiry: '2026-07-17', strike: 150, type: 'call', bid: 5, ask: 5 }),
        contract({ expiry: '2026-07-17', strike: 150, type: 'put', bid: 4, ask: 4 }),
      ],
      150,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expiry).toBe('2026-07-17');
  });
});
