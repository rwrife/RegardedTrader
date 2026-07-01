import { describe, it, expect } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import type { LLM, TechnicianAgent, NewsScoutAgent } from './agents/index.js';
import type { MarketDataClient } from './clients/index.js';
import type { OptionContract, TradePlan } from './schemas/index.js';
import { DISCLAIMER } from './constants.js';

/**
 * Coverage for issue #115: `POST /plans` wire format must surface
 * `RiskOfficer` violations on every plan, and flag `noCompliantPlans` when
 * every candidate fails review.
 *
 * Also covers issue #126: full briefing pipeline (analyst + optional
 * Technician/NewsScout + strategist + RiskOfficer aggregate verdict).
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

/**
 * Fake LLM that returns a valid Analyst JSON when the system prompt looks
 * like the Analyst's, and a `{ plans: [...] }` StrategistOutput otherwise.
 * Post-#165 the Analyst validates its reply via Zod and throws on mismatch,
 * so tests that exercise both agents need per-agent replies.
 */
function analystAndPlanJson(plans: TradePlan[]): LLM {
  return {
    async complete({ system }) {
      if (/equity research analyst/i.test(system)) {
        return JSON.stringify({
          bullCase: 'bull',
          bearCase: 'bear',
          catalysts: ['c1'],
          risks: ['r1'],
        });
      }
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

describe('Orchestrator.briefing (#126)', () => {
  const analystReply = JSON.stringify({
    bullCase: 'bull',
    bearCase: 'bear',
    catalysts: ['c1'],
    risks: ['r1'],
  });
  function analystLLM(): LLM {
    return {
      async complete() {
        return analystReply;
      },
    };
  }

  it('produces a valid analyst-only briefing when no optional agents are registered', async () => {
    const o = new Orchestrator(fakeMarket(), analystLLM());
    const b = await o.briefing('NVDA');
    expect(b.symbol).toBe('NVDA');
    expect(b.bullCase).toBe('bull');
    expect(b.ta).toBeUndefined();
    expect(b.newsScout).toBeUndefined();
    expect(b.strategist).toBeUndefined();
    expect(b.riskVerdict).toBeUndefined();
    expect(b.disclaimer).toMatch(/Not financial advice/i);
    expect(Array.isArray(b.sourcesUsed)).toBe(true);
  });

  it('skips missing optional agents without breaking the briefing', async () => {
    // Only Technician registered; NewsScout absent.
    const technician: TechnicianAgent = {
      async analyze() {
        return {
          trend: 'up',
          momentum: 'positive',
          volatility: 'normal',
          keyLevels: [500],
          commentary: 'looks fine',
          sourcesUsed: ['indicators'],
          disclaimer: DISCLAIMER,
        };
      },
    };
    const o = new Orchestrator(
      fakeMarket(),
      analystLLM(),
      undefined,
      { technician },
    );
    const b = await o.briefing('NVDA');
    expect(b.ta?.trend).toBe('up');
    expect(b.newsScout).toBeUndefined();
    expect(b.sourcesUsed).toContain('indicators');
  });

  it('composes Technician + NewsScout + strategist and applies RiskOfficer last', async () => {
    const technician: TechnicianAgent = {
      async analyze() {
        return {
          trend: 'up',
          momentum: 'pos',
          volatility: 'low',
          keyLevels: [],
          commentary: 'ok',
          sourcesUsed: ['ta:rsi'],
          disclaimer: DISCLAIMER,
        };
      },
    };
    const scout: NewsScoutAgent = {
      async scout() {
        return {
          headlines: [],
          summary: 'no fresh news',
          sourcesUsed: ['news:yahoo'],
          disclaimer: DISCLAIMER,
        };
      },
    };
    const o = new Orchestrator(
      fakeMarket(),
      analystAndPlanJson([compliantPlan]),
      { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true },
      { technician, newsScout: scout },
    );
    const b = await o.briefing('NVDA', { thesis: 'bullish', maxLossUsd: 500 });
    expect(b.ta?.commentary).toBe('ok');
    expect(b.newsScout?.summary).toBe('no fresh news');
    expect(b.strategist?.candidates).toHaveLength(1);
    expect(b.strategist?.candidates[0]?.review.ok).toBe(true);
    expect(b.riskVerdict?.ok).toBe(true);
    expect(b.sourcesUsed).toEqual(
      expect.arrayContaining(['ta:rsi', 'news:yahoo']),
    );
  });

  it('surfaces RiskOfficer-violation path in the aggregate verdict', async () => {
    const o = new Orchestrator(
      fakeMarket(),
      analystAndPlanJson([violatingPlan]),
      { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true },
    );
    const b = await o.briefing('NVDA', { thesis: 'bullish', maxLossUsd: 500 });
    expect(b.strategist?.noCompliantPlans).toBe(true);
    expect(b.riskVerdict?.ok).toBe(false);
    expect(b.riskVerdict?.violations.length).toBeGreaterThan(0);
    // Violation strings are prefixed with the plan name for traceability.
    expect(b.riskVerdict?.violations[0]).toMatch(/^Big long call: /);
  });

  /**
   * Issue #165: strategist LLM parse failures must surface on the briefing
   * as a distinct `parseError`, not silently as `candidates: []`. This lets
   * CLI/web render “AI failed to produce valid plans” instead of “no
   * candidates” and keeps the analyst/technician sections intact.
   */
  it('surfaces a strategist parseError on the briefing when the LLM reply is unparseable', async () => {
    let call = 0;
    const llm: LLM = {
      async complete() {
        call += 1;
        // First call = Analyst (valid), second call = Strategist (junk).
        if (call === 1) {
          return JSON.stringify({
            bullCase: 'bull',
            bearCase: 'bear',
            catalysts: [],
            risks: [],
          });
        }
        return 'not json at all';
      },
    };
    const o = new Orchestrator(fakeMarket(), llm, {
      maxLossUsd: 500,
      maxLegs: 4,
      forbidNakedShorts: true,
    });
    const b = await o.briefing('NVDA', { thesis: 'bullish', maxLossUsd: 500 });
    expect(b.bullCase).toBe('bull');
    expect(b.strategist?.candidates).toEqual([]);
    expect(b.strategist?.parseError).toMatch(/OptionsStrategist/);
  });
});
