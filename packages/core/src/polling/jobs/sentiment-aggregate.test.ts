import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MentionStore } from '../mention-store.js';
import {
  aggregateScoredMentions,
  aggregateSentiment,
  DEFAULT_SOURCE_WEIGHTS,
  type SentimentUpdateEvent,
} from './sentiment-aggregate.js';
import type { ScoredMention } from '../../schemas/sentiment.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function scored(
  source: ScoredMention['source'],
  score: number,
  confidence: number,
  publishedAt: string,
  opts: { sourceId?: string; engagement?: number; symbol?: string } = {},
): ScoredMention {
  const sym = (opts.symbol ?? 'NVDA') as ScoredMention['symbol'];
  return {
    source,
    sourceId: opts.sourceId ?? `${source}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: sym,
    text: 'short excerpt',
    publishedAt,
    fetchedAt: publishedAt,
    sentiment: {
      score,
      confidence,
      label: score > 0.15 ? 'bullish' : score < -0.15 ? 'bearish' : 'neutral',
    },
    scoredAt: publishedAt,
    ...(opts.engagement !== undefined
      ? { meta: { engagement: opts.engagement } as ScoredMention['meta'] }
      : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Pure aggregation                                                            */
/* -------------------------------------------------------------------------- */

describe('aggregateScoredMentions (pure)', () => {
  const now = new Date('2026-05-15T18:00:00Z');

  it('returns null for an empty input (distinct from neutral)', () => {
    expect(aggregateScoredMentions('NVDA', [], { now })).toBeNull();
  });

  it('computes a confidence × log1p(engagement) × sourceWeight weighted mean', () => {
    const items: ScoredMention[] = [
      scored('reddit', 1, 1, now.toISOString(), { engagement: 99 }),
      scored('reddit', -1, 1, now.toISOString(), { engagement: 99 }),
    ];
    const snap = aggregateScoredMentions('NVDA', items, { now });
    expect(snap).not.toBeNull();
    // Equal & opposite → mean ≈ 0.
    expect(snap!.score).toBeCloseTo(0, 6);
    expect(snap!.volume).toBe(2);
    expect(snap!.bySource.reddit?.volume).toBe(2);
  });

  it('weights higher-confidence mentions more', () => {
    const items: ScoredMention[] = [
      scored('reddit', 1, 0.9, now.toISOString(), { engagement: 10 }),
      scored('reddit', -1, 0.1, now.toISOString(), { engagement: 10 }),
    ];
    const snap = aggregateScoredMentions('NVDA', items, { now })!;
    expect(snap.score).toBeGreaterThan(0.5);
  });

  it('respects source weight overrides (cnn 1.2 > stocktwits 0.7)', () => {
    const items: ScoredMention[] = [
      scored('cnn', 1, 1, now.toISOString(), { engagement: 10 }),
      scored('stocktwits', -1, 1, now.toISOString(), { engagement: 10 }),
    ];
    const snap = aggregateScoredMentions('NVDA', items, { now })!;
    // CNN (1.2) outweighs StockTwits (0.7) at equal confidence/engagement.
    expect(snap.score).toBeGreaterThan(0);
    // Per-source breakdown preserves the raw per-source means (1 and -1).
    expect(snap.bySource.cnn?.score).toBeCloseTo(1, 6);
    expect(snap.bySource.stocktwits?.score).toBeCloseTo(-1, 6);
  });

  it('honors custom sourceWeights overrides', () => {
    const items: ScoredMention[] = [
      scored('cnn', 1, 1, now.toISOString(), { engagement: 10 }),
      scored('stocktwits', -1, 1, now.toISOString(), { engagement: 10 }),
    ];
    const snap = aggregateScoredMentions('NVDA', items, {
      now,
      sourceWeights: { cnn: 0.1, stocktwits: 10 },
    })!;
    // Flipped: stocktwits now massively outweighs cnn.
    expect(snap.score).toBeLessThan(0);
  });

  it('falls back to engagement=1 when meta.engagement is missing', () => {
    const items: ScoredMention[] = [
      scored('reddit', 0.5, 1, now.toISOString()),
      scored('reddit', 0.5, 1, now.toISOString()),
    ];
    const snap = aggregateScoredMentions('NVDA', items, { now })!;
    expect(snap.score).toBeCloseTo(0.5, 6);
    expect(snap.volume).toBe(2);
  });

  it('clamps the aggregate score into [-1, 1]', () => {
    const items: ScoredMention[] = [scored('reddit', 1, 1, now.toISOString(), { engagement: 100 })];
    const snap = aggregateScoredMentions('NVDA', items, { now })!;
    expect(snap.score).toBeLessThanOrEqual(1);
    expect(snap.score).toBeGreaterThanOrEqual(-1);
  });

  it('exposes sane default weights', () => {
    expect(DEFAULT_SOURCE_WEIGHTS.reddit).toBe(1.0);
    expect(DEFAULT_SOURCE_WEIGHTS.stocktwits).toBe(0.7);
    expect(DEFAULT_SOURCE_WEIGHTS.cnn).toBe(1.2);
    expect(DEFAULT_SOURCE_WEIGHTS['google-news']).toBe(1.1);
    expect(DEFAULT_SOURCE_WEIGHTS.hn).toBe(0.4);
  });
});

/* -------------------------------------------------------------------------- */
/* Job + store integration                                                     */
/* -------------------------------------------------------------------------- */

describe('aggregateSentiment (store-backed)', () => {
  let tmp: string;
  let store: MentionStore;
  const now = new Date('2026-05-15T18:00:00Z');

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'rt-agg-'));
    store = new MentionStore({ root: tmp, now: () => now });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reads scored mentions in the window, persists a snapshot, emits an event', async () => {
    await store.appendScoredMention(
      scored('reddit', 0.8, 0.9, new Date(now.getTime() - 5 * 60 * 1000).toISOString(), {
        sourceId: 'r1',
        engagement: 50,
      }),
    );
    await store.appendScoredMention(
      scored('stocktwits', -0.6, 0.7, new Date(now.getTime() - 10 * 60 * 1000).toISOString(), {
        sourceId: 's1',
        engagement: 10,
      }),
    );

    const events: SentimentUpdateEvent[] = [];
    const res = await aggregateSentiment({
      symbol: 'nvda',
      store,
      marketState: 'rth',
      now: () => now,
      onEvent: (e) => events.push(e),
    });

    expect(res.symbol).toBe('NVDA');
    expect(res.contributing).toBe(2);
    expect(res.snapshot).not.toBeNull();
    expect(res.snapshot!.volume).toBe(2);
    expect(res.snapshot!.bySource.reddit?.volume).toBe(1);
    expect(res.snapshot!.bySource.stocktwits?.volume).toBe(1);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('sentiment.update');
    expect(events[0]!.snapshot?.symbol).toBe('NVDA');

    // Persisted: readSentiment should yield exactly one row.
    const persisted: unknown[] = [];
    for await (const s of store.readSentiment('NVDA')) persisted.push(s);
    expect(persisted).toHaveLength(1);
  });

  it('returns null snapshot when the window has zero scored mentions, emits null event, does NOT persist', async () => {
    // Mention exists but outside the 30-min RTH window.
    await store.appendScoredMention(
      scored('reddit', 0.8, 0.9, new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(), {
        sourceId: 'old',
        engagement: 50,
      }),
    );

    const events: SentimentUpdateEvent[] = [];
    const res = await aggregateSentiment({
      symbol: 'NVDA',
      store,
      marketState: 'rth',
      now: () => now,
      onEvent: (e) => events.push(e),
    });

    expect(res.snapshot).toBeNull();
    expect(res.contributing).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.snapshot).toBeNull();

    const persisted: unknown[] = [];
    for await (const s of store.readSentiment('NVDA')) persisted.push(s);
    expect(persisted).toHaveLength(0);
  });

  it('uses a wider window when the market is closed', async () => {
    await store.appendScoredMention(
      scored('reddit', 0.4, 0.8, new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(), {
        sourceId: 'r-old',
        engagement: 20,
      }),
    );

    const rth = await aggregateSentiment({
      symbol: 'NVDA',
      store,
      marketState: 'rth',
      now: () => now,
    });
    expect(rth.snapshot).toBeNull();

    const closed = await aggregateSentiment({
      symbol: 'NVDA',
      store,
      marketState: 'closed',
      now: () => now,
    });
    expect(closed.snapshot).not.toBeNull();
    expect(closed.snapshot!.volume).toBe(1);
  });

  it('ignores unscored MentionItems (the scorer is upstream)', async () => {
    await store.appendMention({
      source: 'reddit',
      sourceId: 'raw1',
      symbol: 'NVDA',
      text: 'plain text mention',
      publishedAt: new Date(now.getTime() - 60_000).toISOString(),
      fetchedAt: new Date(now.getTime() - 60_000).toISOString(),
    });
    await store.appendScoredMention(
      scored('reddit', 0.5, 0.8, new Date(now.getTime() - 60_000).toISOString(), {
        sourceId: 'scored1',
        engagement: 5,
      }),
    );

    const res = await aggregateSentiment({
      symbol: 'NVDA',
      store,
      marketState: 'rth',
      now: () => now,
    });

    expect(res.contributing).toBe(1);
    expect(res.snapshot!.volume).toBe(1);
  });
});
