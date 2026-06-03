import type { OptionContract, TradePlan } from '../../schemas/index.js';

/** Build a minimal valid OptionContract. */
export function makeContract(
  overrides: Partial<OptionContract> & {
    underlying?: string;
    strike: number;
    type: 'call' | 'put';
    expiry?: string;
  },
): OptionContract {
  const underlying = overrides.underlying ?? 'NVDA';
  const expiry = overrides.expiry ?? '2026-06-19';
  return {
    symbol: `${underlying}${expiry.replace(/-/g, '')}${overrides.type === 'call' ? 'C' : 'P'}${overrides.strike}`,
    underlying,
    expiry,
    strike: overrides.strike,
    type: overrides.type,
    bid: overrides.bid ?? 1.0,
    ask: overrides.ask ?? 1.2,
    last: overrides.last ?? 1.1,
    volume: overrides.volume ?? 100,
    openInterest: overrides.openInterest ?? 200,
    iv: overrides.iv ?? 0.35,
    delta: overrides.delta ?? null,
    gamma: overrides.gamma ?? null,
    theta: overrides.theta ?? null,
    vega: overrides.vega ?? null,
  };
}

/**
 * Defined-risk long-call plan with no risk-graph attached. Useful for
 * exercising `RiskOfficer` against LLM-provided `maxLoss` directly.
 */
export function definedRiskPlan(
  overrides: Partial<TradePlan> = {},
): TradePlan {
  return {
    name: 'long call NVDA 100',
    thesis: 'bullish',
    legs: [
      {
        action: 'buy',
        qty: 1,
        contract: makeContract({ strike: 100, type: 'call' }),
      },
    ],
    maxLoss: 110, // $1.10 mid * 100
    maxGain: null,
    breakEvens: [101.1],
    ...overrides,
  };
}
