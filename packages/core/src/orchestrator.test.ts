import { describe, it, expect } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import type { LLM } from './agents/index.js';
import type { MarketDataClient } from './clients/index.js';
import type { OptionContract, TradePlan } from './schemas/index.js';

/**
 * Coverage for issue #115: `POST /plans` wire format must surface
 * `RiskOfficer` violations on every plan, and flag `noCompliantPlans` when
 * every candidate fails review.
 */

const chain: OptionContract[] = [
  {
    symbol: 'NVDA260619C00500000',
    underlying: 'NVDA',
    expiry: '2026-06-19',
    strike: 500,
    type: 'call',
    bid: 5,
    ask: 5,
    last: 5,
    volume: 0,
    openInterest: 0,
    iv: 0.5,
  },
  {
    symbol: 'NVDA260619C00450000',
    underlying: 'NVDA',
    expiry: '2026-06-19',
    strike: 450,
    type: 'call',
    bid: 60,
    ask: 60,
    last: 60,
    volume: 0,
    openInterest: 0,
    iv: 0.5,
  },
];

function fakeMarket(): MarketDataClient {
  return {
    quote: async () => ({
      symbol: 'NVDA',
      price: 500,
      change: 0,
      changePercent: 0,
      volume: 0,
      asOf: '',
    }),
    history: async () => [],
    news: async () => [],
    optionsChain: async () => chain,
  };
}

function planJson(plans: TradePlan[]): LLM {
  return {
    async complete() {
      return JSON.stringify({ plans });
    },
  };
}

const compliantPlan: TradePlan = {
  name: 'Long call',
  thesis: 'bullish',
  legs: [
    {
      action: 'buy',
      qty: 1,
      contract: chain[0]!,
    },
  ],
  maxLoss: 100,
  maxGain: null,
  breakEvens: [505],
};

const violatingPlan: TradePlan = {
  ...compliantPlan,
  name: 'Big long call',
  legs: [
    {
      action: 'buy',
      qty: 1,
      contract: chain[1]!,
    },
  ],
  maxLoss: 6000,
};

describe('Orchestrator.proposePlans (#115)', () => {
  it('returns each plan paired with its RiskOfficer review', async () => {
    const o = new Orchestrator(fakeMarket(), planJson([compliantPlan]), {
      maxLossUsd: 500,
      maxLegs: 4,
      forbidNakedShorts: true,
    });
    const res = await o.proposePlans({
      symbol: 'NVDA',
      thesis: 'bullish',
      maxLossUsd: 500,
    });
    expect(res.plans).toHaveLength(1);
    expect(res.plans[0]?.review.ok).toBe(true);
    expect(res.plans[0]?.review.violations).toEqual([]);
    expect(res.noCompliantPlans).toBeUndefined();
  });

  it('emits violations[] and noCompliantPlans=true when every plan fails review', async () => {
    const o = new Orchestrator(fakeMarket(), planJson([violatingPlan]), {
      maxLossUsd: 500,
      maxLegs: 4,
      forbidNakedShorts: true,
    });
    const res = await o.proposePlans({
      symbol: 'NVDA',
      thesis: 'bullish',
      maxLossUsd: 500,
    });
    expect(res.plans).toHaveLength(1);
    expect(res.plans[0]?.review.ok).toBe(false);
    expect(res.plans[0]?.review.violations.length).toBeGreaterThan(0);
    expect(res.noCompliantPlans).toBe(true);
  });

  it('does not set noCompliantPlans when at least one plan passes review', async () => {
    const o = new Orchestrator(
      fakeMarket(),
      planJson([compliantPlan, violatingPlan]),
      { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true },
    );
    const res = await o.proposePlans({
      symbol: 'NVDA',
      thesis: 'bullish',
      maxLossUsd: 500,
    });
    expect(res.plans).toHaveLength(2);
    expect(res.noCompliantPlans).toBeUndefined();
    expect(res.plans[0]?.review.ok).toBe(true);
    expect(res.plans[1]?.review.ok).toBe(false);
  });
});
