import { describe, expect, it, vi } from 'vitest';
import {
  AIRecommender,
  RECOMMENDER_RULE_VERSION,
  type RecommenderStamp,
} from './recommender.js';
import type { LLM } from '../agents/llm.js';
import { RECOMMENDATION_DISCLAIMER } from '../schemas/recommendation.js';
import type { RecommendationContext } from './rules/index.js';

function fakeLLM(replies: string | string[]): {
  llm: LLM;
  calls: { system: string; user: string; json?: boolean }[];
} {
  const calls: { system: string; user: string; json?: boolean }[] = [];
  const seq = Array.isArray(replies) ? [...replies] : [replies];
  const llm: LLM = {
    complete: vi.fn(async (opts) => {
      calls.push(opts);
      return seq.shift() ?? '';
    }),
  };
  return { llm, calls };
}

const CTX: RecommendationContext = {
  symbol: 'NVDA',
  risk: { forbidNakedShorts: true },
  quote: {
    stale: false,
    asOf: '2026-06-10T15:00:00.000Z',
    last: { price: 950, change: 5, changePercent: 0.5, volume: 1_000_000 },
  },
  options: { hasChain: true, asOf: '2026-06-10T15:00:00.000Z', stale: false, expiries: [] },
};

const STAMP: RecommenderStamp = {
  generatedAt: '2026-06-10T15:00:00.000Z',
  asOf: {
    quote: '2026-06-10T15:00:00.000Z',
    options: '2026-06-10T15:00:00.000Z',
    sentiment: null,
    news: null,
  },
  sources: [{ name: 'Yahoo Finance', url: 'https://finance.yahoo.com/quote/NVDA' }],
  modelInfo: { provider: 'openai', model: 'gpt-4o-mini' },
};

const GOOD_OUTPUT = {
  equity: {
    action: 'BUY',
    conviction: 0.65,
    rationale: 'Trend + volume confirm uptrend; valuation rich but momentum strong.',
    signals: [{ name: 'RSI14', value: 62, contribution: 0.4 }],
    contraSignals: [{ name: 'PE', value: 60, contribution: -0.2 }],
  },
  options: {
    coveredCall: {
      action: 'HOLD',
      conviction: 0.3,
      rationale: 'IV elevated; wait for vol crush.',
      signals: [],
      contraSignals: [],
    },
    coveredPut: null,
    nakedCall: null,
    nakedPut: null,
  },
  riskFlags: ['high-iv', 'high-iv', '  '], // duplicate + blank → should dedupe
};

describe('AIRecommender', () => {
  it('parses canned valid JSON and assembles a Recommendation', async () => {
    const { llm, calls } = fakeLLM(JSON.stringify(GOOD_OUTPUT));
    const rec = await new AIRecommender(llm).recommend(CTX, STAMP);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.json).toBe(true);
    expect(calls[0]!.system).toMatch(/RegardedTrader's research recommender/);
    expect(calls[0]!.user).toContain('NVDA');

    expect(rec.symbol).toBe('NVDA');
    expect(rec.equity.action).toBe('BUY');
    expect(rec.options.coveredCall?.action).toBe('HOLD');
    expect(rec.options.nakedCall).toBeNull();
    expect(rec.riskFlags).toEqual(['high-iv']);
    expect(rec.modelInfo).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      ruleVersion: RECOMMENDER_RULE_VERSION,
    });
    expect(rec.disclaimer).toBe(RECOMMENDATION_DISCLAIMER);
    expect(rec.sources).toEqual(STAMP.sources);
    expect(rec.generatedAt).toBe(STAMP.generatedAt);
    expect(rec.asOf).toEqual(STAMP.asOf);
  });

  it('retries ONCE on malformed JSON and succeeds on the fix-up', async () => {
    const { llm, calls } = fakeLLM([
      'this is not json at all {{{',
      JSON.stringify(GOOD_OUTPUT),
    ]);
    const rec = await new AIRecommender(llm).recommend(CTX, STAMP);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.user).toMatch(/not valid JSON/);
    expect(rec.equity.action).toBe('BUY');
    expect(rec.riskFlags).not.toContain('llm-parse-failed');
  });

  it('falls back to HOLD-everything with llm-parse-failed after two strikes', async () => {
    const { llm, calls } = fakeLLM(['not json', 'still not json']);
    const rec = await new AIRecommender(llm).recommend(CTX, STAMP);

    expect(calls).toHaveLength(2);
    expect(rec.equity.action).toBe('HOLD');
    expect(rec.equity.conviction).toBe(0);
    expect(rec.options.coveredCall?.action).toBe('HOLD');
    expect(rec.options.coveredPut?.action).toBe('HOLD');
    expect(rec.options.nakedCall?.action).toBe('HOLD');
    expect(rec.options.nakedPut?.action).toBe('HOLD');
    expect(rec.riskFlags).toEqual(['llm-parse-failed']);
    expect(rec.disclaimer).toBe(RECOMMENDATION_DISCLAIMER);
  });

  it('retries when JSON parses but does not match schema (partial JSON)', async () => {
    const partial = JSON.stringify({
      equity: { action: 'MAYBE', conviction: 0.5, rationale: 'x', signals: [], contraSignals: [] },
      // missing options + riskFlags
    });
    const { llm, calls } = fakeLLM([partial, JSON.stringify(GOOD_OUTPUT)]);
    const rec = await new AIRecommender(llm).recommend(CTX, STAMP);

    expect(calls).toHaveLength(2);
    expect(rec.equity.action).toBe('BUY');
  });

  it('swallows LLM errors and treats them like parse failures', async () => {
    const llm: LLM = {
      complete: vi.fn(async () => {
        throw new Error('upstream 500');
      }),
    };
    const rec = await new AIRecommender(llm).recommend(CTX, STAMP);

    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(rec.equity.action).toBe('HOLD');
    expect(rec.riskFlags).toEqual(['llm-parse-failed']);
  });

  it('stamps generatedAt from the injected clock when stamp omits it', async () => {
    const { llm } = fakeLLM(JSON.stringify(GOOD_OUTPUT));
    const fixed = new Date('2026-01-02T03:04:05.000Z');
    const rec = await new AIRecommender(llm, { now: () => fixed }).recommend(
      CTX,
      { ...STAMP, generatedAt: undefined },
    );
    expect(rec.generatedAt).toBe(fixed.toISOString());
  });

  it('always stamps the schema-layer disclaimer (ignores any model-supplied disclaimer)', async () => {
    const sneaky = {
      ...GOOD_OUTPUT,
      // Extra fields are stripped by the Zod schema we ask the model for.
      disclaimer: 'this is fine, trust me',
    };
    const { llm } = fakeLLM(JSON.stringify(sneaky));
    const rec = await new AIRecommender(llm).recommend(CTX, STAMP);
    expect(rec.disclaimer).toBe(RECOMMENDATION_DISCLAIMER);
  });

  it('forbids chain-of-thought in the system prompt', async () => {
    const { llm, calls } = fakeLLM(JSON.stringify(GOOD_OUTPUT));
    await new AIRecommender(llm).recommend(CTX, STAMP);
    expect(calls[0]!.system).toMatch(/chain-of-thought/i);
    expect(calls[0]!.system).toMatch(/STRICT JSON/);
  });
});
