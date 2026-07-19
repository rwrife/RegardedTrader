import { describe, expect, it, vi } from 'vitest';
import {
  RecommenderOrchestrator,
  type RecommendationUpdateEvent,
} from './orchestrator.js';
import {
  RECOMMENDATION_DISCLAIMER,
  type Recommendation,
} from '../schemas/recommendation.js';
import type { Recommender, RecommenderStamp } from './recommender.js';
import type { RecommendationContext, Rule } from './rules/index.js';
import { createTestRecommendationStore } from './__fixtures__/store.js';

function buildCtx(symbol = 'NVDA'): RecommendationContext {
  return {
    symbol,
    risk: { forbidNakedShorts: true },
    quote: {
      stale: false,
      asOf: '2026-06-10T15:00:00.000Z',
      last: { price: 950, change: 5, changePercent: 0.5, volume: 1_000_000 },
    },
    options: { hasChain: true, asOf: '2026-06-10T15:00:00.000Z', stale: false, expiries: [] },
  };
}

function buildRec(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    symbol: 'NVDA',
    generatedAt: '2026-06-10T15:00:00.000Z',
    asOf: {
      quote: '2026-06-10T15:00:00.000Z',
      options: '2026-06-10T15:00:00.000Z',
      sentiment: null,
      news: null,
    },
    equity: {
      action: 'BUY',
      conviction: 0.7,
      rationale: 'demo',
      signals: [],
      contraSignals: [],
    },
    options: {
      coveredCall: null,
      coveredPut: null,
      nakedCall: null,
      nakedPut: null,
    },
    riskFlags: [],
    sources: [{ name: 'Yahoo', url: 'https://finance.yahoo.com/quote/NVDA' }],
    modelInfo: { provider: 'openai', model: 'gpt-4o-mini', ruleVersion: '1.0.0' },
    disclaimer: RECOMMENDATION_DISCLAIMER,
    ...overrides,
  };
}

function makeRecommender(rec: Recommendation | (() => Recommendation)): {
  rec: Recommender;
  calls: number;
} {
  let calls = 0;
  const rec_: Recommender = {
    recommend: vi.fn(async () => {
      calls++;
      return typeof rec === 'function' ? rec() : rec;
    }),
  };
  return {
    rec: rec_,
    get calls() {
      return calls;
    },
  };
}

const STAMP: RecommenderStamp = {
  generatedAt: '2026-06-10T15:00:00.000Z',
  asOf: {
    quote: '2026-06-10T15:00:00.000Z',
    options: '2026-06-10T15:00:00.000Z',
    sentiment: null,
    news: null,
  },
  sources: [{ name: 'Yahoo', url: 'https://finance.yahoo.com/quote/NVDA' }],
  modelInfo: { provider: 'openai', model: 'gpt-4o-mini' },
};

describe('RecommenderOrchestrator', () => {
  it('threads context → recommender → rules → store and emits update', async () => {
    const ctx = buildCtx();
    const rec = buildRec();
    const { rec: recommender } = makeRecommender(rec);
    const { store, appends } = createTestRecommendationStore(null);
    const events: RecommendationUpdateEvent[] = [];

    const ruleSeen: RecommendationContext[] = [];
    const tagRule: Rule = {
      name: 'tag',
      version: '1.0.0',
      apply(c, draft) {
        ruleSeen.push(c);
        return { ...draft, riskFlags: [...draft.riskFlags, 'tagged'] };
      },
    };

    const orch = new RecommenderOrchestrator({
      recommender,
      store,
      buildContext: async () => ctx,
      stampFor: () => STAMP,
      rules: [tagRule],
      onEvent: (e) => events.push(e),
    });

    const result = await orch.runOnce('nvda');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error();
    expect(result.symbol).toBe('NVDA');
    expect(result.persisted).toBe(true);
    expect(result.recommendation.riskFlags).toContain('tagged');
    expect(appends).toHaveLength(1);
    expect(appends[0]?.riskFlags).toContain('tagged');
    expect(ruleSeen[0]?.symbol).toBe('NVDA');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'recommendation.update',
      symbol: 'NVDA',
      persisted: true,
    });
  });

  it('first run with empty store always persists', async () => {
    const { rec } = makeRecommender(buildRec());
    const { store, appends } = createTestRecommendationStore(null);
    const orch = new RecommenderOrchestrator({
      recommender: rec,
      store,
      buildContext: async () => buildCtx(),
      stampFor: () => STAMP,
    });
    const r = await orch.runOnce('NVDA');
    expect(r.status).toBe('ok');
    expect(appends).toHaveLength(1);
  });

  it('dedupes when action+conviction bucket unchanged within TTL', async () => {
    const prev = buildRec({
      generatedAt: '2026-06-10T15:00:00.000Z',
      equity: {
        action: 'BUY',
        conviction: 0.7,
        rationale: 'old',
        signals: [],
        contraSignals: [],
      },
    });
    const next = buildRec({
      generatedAt: '2026-06-10T15:10:00.000Z',
      equity: {
        action: 'BUY',
        conviction: 0.73, // within 5%
        rationale: 'new',
        signals: [],
        contraSignals: [],
      },
    });
    const { rec } = makeRecommender(next);
    const { store, appends } = createTestRecommendationStore(prev);
    const events: RecommendationUpdateEvent[] = [];

    const orch = new RecommenderOrchestrator({
      recommender: rec,
      store,
      buildContext: async () => buildCtx(),
      stampFor: () => STAMP,
      now: () => new Date('2026-06-10T15:10:00.000Z'),
    });

    const r = await orch.runOnce('NVDA');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error();
    expect(r.persisted).toBe(false);
    expect(appends).toHaveLength(0);
    // event still fires
    expect(events).toHaveLength(0); // no onEvent wired
    expect((rec.recommend as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('persists when equity action flips', async () => {
    const prev = buildRec({
      equity: {
        action: 'BUY',
        conviction: 0.7,
        rationale: '',
        signals: [],
        contraSignals: [],
      },
    });
    const next = buildRec({
      equity: {
        action: 'SELL',
        conviction: 0.7,
        rationale: '',
        signals: [],
        contraSignals: [],
      },
    });
    const { rec } = makeRecommender(next);
    const { store, appends } = createTestRecommendationStore(prev);
    const orch = new RecommenderOrchestrator({
      recommender: rec,
      store,
      buildContext: async () => buildCtx(),
      stampFor: () => STAMP,
      now: () => new Date('2026-06-10T15:10:00.000Z'),
    });
    const r = await orch.runOnce('NVDA');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error();
    expect(r.persisted).toBe(true);
    expect(appends).toHaveLength(1);
  });

  it('persists when conviction shifts beyond bucket', async () => {
    const prev = buildRec({
      equity: {
        action: 'BUY',
        conviction: 0.5,
        rationale: '',
        signals: [],
        contraSignals: [],
      },
    });
    const next = buildRec({
      equity: {
        action: 'BUY',
        conviction: 0.7, // +0.2 > 0.05 bucket
        rationale: '',
        signals: [],
        contraSignals: [],
      },
    });
    const { rec } = makeRecommender(next);
    const { store, appends } = createTestRecommendationStore(prev);
    const orch = new RecommenderOrchestrator({
      recommender: rec,
      store,
      buildContext: async () => buildCtx(),
      stampFor: () => STAMP,
      now: () => new Date('2026-06-10T15:10:00.000Z'),
    });
    const r = await orch.runOnce('NVDA');
    if (r.status !== 'ok') throw new Error();
    expect(r.persisted).toBe(true);
    expect(appends).toHaveLength(1);
  });

  it('persists when TTL has elapsed even without material change', async () => {
    const prev = buildRec({
      generatedAt: '2026-06-10T10:00:00.000Z',
      equity: {
        action: 'BUY',
        conviction: 0.7,
        rationale: '',
        signals: [],
        contraSignals: [],
      },
    });
    const next = buildRec({
      generatedAt: '2026-06-10T15:00:00.000Z',
      equity: {
        action: 'BUY',
        conviction: 0.71,
        rationale: '',
        signals: [],
        contraSignals: [],
      },
    });
    const { rec } = makeRecommender(next);
    const { store, appends } = createTestRecommendationStore(prev);
    const orch = new RecommenderOrchestrator({
      recommender: rec,
      store,
      buildContext: async () => buildCtx(),
      stampFor: () => STAMP,
      now: () => new Date('2026-06-10T15:00:00.000Z'),
    });
    const r = await orch.runOnce('NVDA');
    if (r.status !== 'ok') throw new Error();
    expect(r.persisted).toBe(true);
    expect(appends).toHaveLength(1);
  });

  it('persists when an option stance flips null ↔ non-null', async () => {
    const prev = buildRec();
    const next = buildRec({
      options: {
        coveredCall: {
          action: 'BUY',
          conviction: 0.6,
          rationale: '',
          signals: [],
          contraSignals: [],
        },
        coveredPut: null,
        nakedCall: null,
        nakedPut: null,
      },
    });
    const { rec } = makeRecommender(next);
    const { store, appends } = createTestRecommendationStore(prev);
    const orch = new RecommenderOrchestrator({
      recommender: rec,
      store,
      buildContext: async () => buildCtx(),
      stampFor: () => STAMP,
      now: () => new Date('2026-06-10T15:10:00.000Z'),
    });
    const r = await orch.runOnce('NVDA');
    if (r.status !== 'ok') throw new Error();
    expect(r.persisted).toBe(true);
    expect(appends).toHaveLength(1);
  });

  it('single-flights concurrent calls per symbol (backpressure)', async () => {
    let resolveFirst!: (r: Recommendation) => void;
    const firstPromise = new Promise<Recommendation>((res) => {
      resolveFirst = res;
    });
    const recommender: Recommender = {
      recommend: vi.fn(() => firstPromise),
    };
    const { store, appends } = createTestRecommendationStore(null);
    const orch = new RecommenderOrchestrator({
      recommender,
      store,
      buildContext: async () => buildCtx(),
      stampFor: () => STAMP,
    });

    const p1 = orch.runOnce('NVDA');
    const p2 = orch.runOnce('NVDA');
    const r2 = await p2;
    expect(r2).toEqual({ status: 'skipped', symbol: 'NVDA', reason: 'inflight' });

    resolveFirst(buildRec());
    const r1 = await p1;
    expect(r1.status).toBe('ok');
    expect(appends).toHaveLength(1);
    // After the first finishes, a follow-up call must run a fresh tick.
    const recommender2: Recommender = {
      recommend: vi.fn(async () => buildRec({ equity: { action: 'SELL', conviction: 0.9, rationale: '', signals: [], contraSignals: [] } })),
    };
    // swap not possible; just verify inflight cleared by issuing another call
    // and seeing the recommender invoked once for that call.
    const p3 = orch.runOnce('NVDA');
    const r3 = await p3;
    expect(r3.status).toBe('ok');
    expect((recommender.recommend as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    // recommender2 unused — silence lint
    void recommender2;
  });

  it('does not catch recommender errors', async () => {
    const recommender: Recommender = {
      recommend: vi.fn(async () => {
        throw new Error('LLM down');
      }),
    };
    const { store } = createTestRecommendationStore(null);
    const orch = new RecommenderOrchestrator({
      recommender,
      store,
      buildContext: async () => buildCtx(),
      stampFor: () => STAMP,
    });
    await expect(orch.runOnce('NVDA')).rejects.toThrow('LLM down');
  });
});
