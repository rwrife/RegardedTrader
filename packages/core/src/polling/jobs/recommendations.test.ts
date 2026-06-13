import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createRecommendationsJob,
  DEFAULT_RECOMMENDATIONS_CADENCES,
} from './recommendations.js';
import { Scheduler } from '../scheduler.js';
import { MarketClock } from '../market-clock.js';
import {
  RecommenderOrchestrator,
  type RecommenderOrchestratorOptions,
} from '../../recommender/orchestrator.js';
import {
  RECOMMENDATION_DISCLAIMER,
  type Recommendation,
} from '../../schemas/recommendation.js';
import type { Recommender } from '../../recommender/recommender.js';
import type { RecommendationContext } from '../../recommender/rules/index.js';

function constantClock(state: 'rth' | 'pre' | 'post' | 'closed' | 'holiday' = 'rth'): MarketClock {
  return {
    state: () => state,
    isOpen: () => state === 'rth',
    isHoliday: () => state === 'holiday',
    closeTimeFor: () => '16:00',
    getCalendar: () => ({
      timezone: 'America/New_York',
      regularHours: { open: '09:30', close: '16:00' },
      holidays: new Set<string>(),
      earlyCloses: new Map<string, string>(),
    }),
  } as unknown as MarketClock;
}

function buildCtx(): RecommendationContext {
  return {
    symbol: 'NVDA',
    risk: { forbidNakedShorts: true },
    quote: {
      stale: false,
      asOf: '2026-06-10T15:00:00.000Z',
      last: { price: 950, change: 5, changePercent: 0.5, volume: 1_000_000 },
    },
    options: { hasChain: true, asOf: '2026-06-10T15:00:00.000Z', stale: false, expiries: [] },
  };
}

function buildRec(action: 'BUY' | 'HOLD' | 'SELL' = 'BUY', conviction = 0.7): Recommendation {
  return {
    symbol: 'NVDA',
    generatedAt: new Date().toISOString(),
    asOf: {
      quote: '2026-06-10T15:00:00.000Z',
      options: '2026-06-10T15:00:00.000Z',
      sentiment: null,
      news: null,
    },
    equity: { action, conviction, rationale: '', signals: [], contraSignals: [] },
    options: { coveredCall: null, coveredPut: null, nakedCall: null, nakedPut: null },
    riskFlags: [],
    sources: [{ name: 'Yahoo', url: 'https://finance.yahoo.com/quote/NVDA' }],
    modelInfo: { provider: 'openai', model: 'gpt-4o-mini', ruleVersion: '1.0.0' },
    disclaimer: RECOMMENDATION_DISCLAIMER,
  };
}

function makeOrchestratorOpts(
  recommender: Recommender,
  initial: Recommendation | null = null,
): RecommenderOrchestratorOptions {
  let latest = initial;
  return {
    recommender,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: {
      async readLatest() {
        return latest;
      },
      async append(_s: string, r: Recommendation) {
        latest = r;
        return r;
      },
    } as any,
    buildContext: async () => buildCtx(),
    stampFor: () => ({
      generatedAt: new Date().toISOString(),
      asOf: {
        quote: '2026-06-10T15:00:00.000Z',
        options: '2026-06-10T15:00:00.000Z',
        sentiment: null,
        news: null,
      },
      sources: [{ name: 'Yahoo', url: 'https://finance.yahoo.com/quote/NVDA' }],
      modelInfo: { provider: 'openai', model: 'gpt-4o-mini' },
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createRecommendationsJob', () => {
  it('uses spec default cadences per market state', () => {
    const recommender: Recommender = { recommend: vi.fn(async () => buildRec()) };
    const orch = new RecommenderOrchestrator(makeOrchestratorOpts(recommender));
    const job = createRecommendationsJob({ symbol: 'nvda', orchestrator: orch });
    expect(job.id).toBe('recommendations:NVDA');
    expect(job.singleFlight).toBe(true);
    expect(job.cadence('rth')).toBe(DEFAULT_RECOMMENDATIONS_CADENCES.rth);
    expect(job.cadence('pre')).toBe(DEFAULT_RECOMMENDATIONS_CADENCES.pre);
    expect(job.cadence('post')).toBe(DEFAULT_RECOMMENDATIONS_CADENCES.post);
    expect(job.cadence('closed')).toBe(DEFAULT_RECOMMENDATIONS_CADENCES.closed);
    expect(job.cadence('holiday')).toBe(DEFAULT_RECOMMENDATIONS_CADENCES.holiday);
  });

  it('honours config-overridden cadences', () => {
    const recommender: Recommender = { recommend: vi.fn(async () => buildRec()) };
    const orch = new RecommenderOrchestrator(makeOrchestratorOpts(recommender));
    const job = createRecommendationsJob({
      symbol: 'NVDA',
      orchestrator: orch,
      cadences: { rth: 1_000, closed: 5_000 },
    });
    expect(job.cadence('rth')).toBe(1_000);
    expect(job.cadence('closed')).toBe(5_000);
    // unspecified states fall back to defaults
    expect(job.cadence('pre')).toBe(DEFAULT_RECOMMENDATIONS_CADENCES.pre);
  });

  it('ticks through Scheduler at RTH cadence and persists', async () => {
    const recommender: Recommender = { recommend: vi.fn(async () => buildRec()) };
    const orch = new RecommenderOrchestrator(makeOrchestratorOpts(recommender));
    const runs: string[] = [];
    const job = createRecommendationsJob({
      symbol: 'NVDA',
      orchestrator: orch,
      cadences: { rth: 1_000 }, // fast for tests
      onRun: (r) => runs.push(r.symbol),
    });
    const sched = new Scheduler({
      clock: constantClock('rth'),
      jitterRatio: 0,
      random: () => 0.5,
    });
    sched.register(job);
    sched.start();

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect((recommender.recommend as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(runs).toEqual(['NVDA', 'NVDA']);
    sched.stop();
  });

  it('drops overlapping ticks under a slow LLM (backpressure)', async () => {
    let resolveFirst!: (r: Recommendation) => void;
    let llmCalls = 0;
    const recommender: Recommender = {
      recommend: vi.fn(() => {
        llmCalls++;
        if (llmCalls === 1) {
          return new Promise<Recommendation>((res) => {
            resolveFirst = res;
          });
        }
        return Promise.resolve(buildRec());
      }),
    };
    const orch = new RecommenderOrchestrator(makeOrchestratorOpts(recommender));
    const skips: string[] = [];
    const job = createRecommendationsJob({
      symbol: 'NVDA',
      orchestrator: orch,
      cadences: { rth: 1_000 },
      onSkip: (s) => skips.push(s.reason),
    });
    const sched = new Scheduler({
      clock: constantClock('rth'),
      jitterRatio: 0,
      random: () => 0.5,
    });
    sched.register(job);
    sched.start();

    // Tick 1 starts and stalls.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(llmCalls).toBe(1);

    // Scheduler's singleFlight prevents a second concurrent run. With
    // singleFlight engaged, the scheduler should not start a second tick
    // while the first is in flight. Either way, no second LLM call.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(llmCalls).toBe(1);

    // Resolve the first tick.
    resolveFirst(buildRec());
    await vi.runOnlyPendingTimersAsync();

    sched.stop();
  });

  it('directly invoking the job concurrently fires onSkip once', async () => {
    let resolveFirst!: (r: Recommendation) => void;
    let calls = 0;
    const recommender: Recommender = {
      recommend: vi.fn(() => {
        calls++;
        if (calls === 1) {
          return new Promise<Recommendation>((res) => {
            resolveFirst = res;
          });
        }
        return Promise.resolve(buildRec());
      }),
    };
    const orch = new RecommenderOrchestrator(makeOrchestratorOpts(recommender));
    const skips: { symbol: string; reason: 'inflight' }[] = [];
    const job = createRecommendationsJob({
      symbol: 'NVDA',
      orchestrator: orch,
      onSkip: (s) => skips.push(s),
    });

    const fakeCtx = { id: job.id, state: 'rth' as const, attempt: 0, now: new Date() };
    const a = job.run(fakeCtx);
    const b = job.run(fakeCtx);
    await b;
    expect(skips).toEqual([{ symbol: 'NVDA', reason: 'inflight' }]);
    resolveFirst(buildRec());
    await a;
  });
});
