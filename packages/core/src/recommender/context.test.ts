import { describe, expect, it } from 'vitest';
import {
  buildRecommendationContext,
  DEFAULT_CONTEXT_BUDGET_CHARS,
  DEFAULT_NEWS_LIMIT,
  type ContextLatestSnapshot,
  type MentionReader,
  type SnapshotReader,
} from './context.js';
import type {
  MentionItem,
  ScoredMention,
  SentimentSnapshot,
} from '../schemas/sentiment.js';

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

interface StreamEntry {
  ts: string;
  data: unknown;
}

function makeSnapshotReader(
  latest: ContextLatestSnapshot,
  streams: {
    quote?: StreamEntry[];
    options?: StreamEntry[];
    news?: StreamEntry[];
  } = {},
): SnapshotReader {
  return {
    readLatest: async () => latest,
    readRange: async function* (
      _symbol: string,
      kind: 'quote' | 'options' | 'news',
      since?: Date,
      until?: Date,
    ) {
      const all = streams[kind] ?? [];
      const sinceMs = since?.getTime() ?? -Infinity;
      const untilMs = until?.getTime() ?? Infinity;
      for (const e of all) {
        const t = Date.parse(e.ts);
        if (!Number.isFinite(t)) continue;
        if (t < sinceMs || t > untilMs) continue;
        yield e;
      }
    },
  };
}

function makeMentionReader(
  mentions: Array<MentionItem | ScoredMention>,
  sentiment: SentimentSnapshot[],
): MentionReader {
  return {
    readMentions: async function* (_symbol, since, until) {
      const sinceMs = since?.getTime() ?? -Infinity;
      const untilMs = until?.getTime() ?? Infinity;
      for (const m of mentions) {
        const t = Date.parse(m.publishedAt);
        if (!Number.isFinite(t)) continue;
        if (t < sinceMs || t > untilMs) continue;
        yield m;
      }
    },
    readSentiment: async function* (_symbol, since, until) {
      const sinceMs = since?.getTime() ?? -Infinity;
      const untilMs = until?.getTime() ?? Infinity;
      for (const s of sentiment) {
        const t = Date.parse(s.asOf);
        if (!Number.isFinite(t)) continue;
        if (t < sinceMs || t > untilMs) continue;
        yield s;
      }
    },
  };
}

const NOW = new Date('2026-06-07T15:00:00.000Z');
const now = () => NOW;

function isoMinusMin(min: number): string {
  return new Date(NOW.getTime() - min * 60_000).toISOString();
}
function isoMinusHour(h: number): string {
  return new Date(NOW.getTime() - h * 60 * 60_000).toISOString();
}
function dateMinusDays(d: number): string {
  const x = new Date(NOW.getTime() - d * 24 * 60 * 60_000);
  return x.toISOString().slice(0, 10);
}

function dailyBars(n: number): StreamEntry[] {
  const bars: StreamEntry[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = dateMinusDays(i);
    const c = 100 + i * 0.5;
    bars.push({
      ts: new Date(`${t}T20:00:00.000Z`).toISOString(),
      data: { t, o: c - 1, h: c + 1, l: c - 2, c, v: 1_000_000 + i * 1000 },
    });
  }
  return bars;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('buildRecommendationContext', () => {
  it('returns a fresh quote section when latest is recent', async () => {
    const latest: ContextLatestSnapshot = {
      symbol: 'NVDA',
      updatedAt: isoMinusMin(1),
      entries: {
        quote: {
          ts: isoMinusMin(1),
          data: {
            symbol: 'NVDA',
            price: 100.5,
            change: 1.5,
            changePercent: 1.5,
            volume: 12_345_678,
            asOf: isoMinusMin(1),
          },
        },
      },
    };
    const ctx = await buildRecommendationContext({
      symbol: 'NVDA',
      snapshots: makeSnapshotReader(latest),
      now,
    });
    expect(ctx.symbol).toBe('NVDA');
    expect(ctx.quote.stale).toBe(false);
    expect(ctx.quote.last?.price).toBe(100.5);
    expect(ctx.risk.forbidNakedShorts).toBe(false);
  });

  it('flags the quote section stale past 2x cadence', async () => {
    const latest: ContextLatestSnapshot = {
      symbol: 'NVDA',
      updatedAt: isoMinusMin(10),
      entries: {
        quote: {
          ts: isoMinusMin(10),
          data: { price: 1, change: 0, changePercent: 0, volume: 0 },
        },
      },
    };
    const ctx = await buildRecommendationContext({
      symbol: 'NVDA',
      snapshots: makeSnapshotReader(latest),
      cadences: { quote: 60_000 },
      now,
    });
    expect(ctx.quote.stale).toBe(true);
  });

  it('handles missing quote without throwing', async () => {
    const latest: ContextLatestSnapshot = {
      symbol: 'NVDA',
      updatedAt: NOW.toISOString(),
      entries: {},
    };
    const ctx = await buildRecommendationContext({
      symbol: 'NVDA',
      snapshots: makeSnapshotReader(latest),
      now,
    });
    expect(ctx.quote.last).toBeNull();
    expect(ctx.quote.stale).toBe(true);
    expect(ctx.options).toBeNull();
    expect(ctx.history ?? null).toBeNull();
    expect(ctx.indicators ?? null).toBeNull();
    expect(ctx.news ?? null).toBeNull();
  });

  it('builds an options digest from a latest options entry', async () => {
    const latest: ContextLatestSnapshot = {
      symbol: 'NVDA',
      updatedAt: isoMinusMin(2),
      entries: {
        options: {
          ts: isoMinusMin(2),
          data: {
            metrics: {
              symbol: 'NVDA',
              expiry: '2026-06-19',
              underlyingPrice: 100,
              atmIv: 0.45,
              ivSkew25d: 0.05,
              openInterest: { call: 1000, put: 800, total: 1800 },
              volume: { call: 500, put: 400, total: 900 },
              putCallRatio: 0.8,
              contractCount: 60,
            },
            contracts: [],
          },
        },
      },
    };
    const ctx = await buildRecommendationContext({
      symbol: 'NVDA',
      snapshots: makeSnapshotReader(latest),
      now,
    });
    expect(ctx.options).not.toBeNull();
    expect(ctx.options!.hasChain).toBe(true);
    expect(ctx.options!.expiries?.[0]?.atmIv).toBe(0.45);
    expect(ctx.options!.expiries?.[0]?.putCallRatio).toBe(0.8);
  });

  it('marks options without a metrics block as no-chain', async () => {
    const latest: ContextLatestSnapshot = {
      symbol: 'NVDA',
      updatedAt: isoMinusMin(2),
      entries: {
        options: { ts: isoMinusMin(2), data: { weird: true } },
      },
    };
    const ctx = await buildRecommendationContext({
      symbol: 'NVDA',
      snapshots: makeSnapshotReader(latest),
      now,
    });
    expect(ctx.options).not.toBeNull();
    expect(ctx.options!.hasChain).toBe(false);
    expect(ctx.options!.expiries).toEqual([]);
  });

  it('builds history + indicators from the quote OHLCV stream', async () => {
    const bars = dailyBars(30);
    const latest: ContextLatestSnapshot = {
      symbol: 'NVDA',
      updatedAt: NOW.toISOString(),
      entries: {},
    };
    const ctx = await buildRecommendationContext({
      symbol: 'NVDA',
      snapshots: makeSnapshotReader(latest, { quote: bars }),
      now,
    });
    expect(ctx.history).not.toBeNull();
    expect(ctx.history!.bars.length).toBeGreaterThan(0);
    expect(ctx.indicators).not.toBeNull();
    expect(ctx.indicators!.sma20).not.toBeNull();
    expect(ctx.indicators!.rsi14).not.toBeNull();
  });

  it('dedupes news by url and limits to N items', async () => {
    const newsEntries: StreamEntry[] = [];
    for (let i = 0; i < 12; i++) {
      newsEntries.push({
        ts: isoMinusHour(i),
        data: {
          title: `Headline ${i}`,
          url: `https://example.com/a-${i}`,
          source: 'yahoo',
          publishedAt: isoMinusHour(i),
        },
      });
    }
    // Duplicate URL — older timestamp; should be dropped.
    newsEntries.push({
      ts: isoMinusHour(20),
      data: {
        title: 'Headline 0 older copy',
        url: 'https://example.com/a-0',
        source: 'yahoo',
        publishedAt: isoMinusHour(20),
      },
    });
    const latest: ContextLatestSnapshot = {
      symbol: 'NVDA',
      updatedAt: NOW.toISOString(),
      entries: {},
    };
    const ctx = await buildRecommendationContext({
      symbol: 'NVDA',
      snapshots: makeSnapshotReader(latest, { news: newsEntries }),
      now,
    });
    expect(ctx.news).not.toBeNull();
    expect(ctx.news!.items.length).toBe(DEFAULT_NEWS_LIMIT);
    // Newest-first ordering.
    expect(ctx.news!.items[0]?.title).toBe('Headline 0');
    // Dedup kept the newer copy.
    const urls = ctx.news!.items.map((i) => i.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('pulls latest sentiment + 24h sparkline from the mention store', async () => {
    const snapshots: SentimentSnapshot[] = [];
    for (let i = 0; i < 24; i++) {
      snapshots.push({
        symbol: 'NVDA',
        asOf: isoMinusHour(23 - i),
        score: 0.1 * (i - 12) * 0.05,
        confidence: 0.5,
        volume: 10,
        bySource: {},
      });
    }
    const latest: ContextLatestSnapshot = {
      symbol: 'NVDA',
      updatedAt: isoMinusMin(1),
      entries: {},
      sentiment: snapshots[snapshots.length - 1],
    };
    const ctx = await buildRecommendationContext({
      symbol: 'NVDA',
      snapshots: makeSnapshotReader(latest),
      mentions: makeMentionReader([], snapshots),
      now,
    });
    expect(ctx.sentiment).not.toBeNull();
    expect(ctx.sentiment!.spark24h.length).toBeGreaterThan(0);
    expect(ctx.sentiment!.score).toBeCloseTo(snapshots[snapshots.length - 1]!.score);
  });

  it('returns opinions dedup-by-url, scored when available', async () => {
    const items: Array<MentionItem | ScoredMention> = [
      {
        source: 'reddit',
        sourceId: 'a1',
        symbol: 'NVDA',
        url: 'https://reddit.com/r/x/a1',
        title: 'big calls',
        text: 'yolo into nvda',
        publishedAt: isoMinusHour(2),
        fetchedAt: isoMinusHour(2),
      },
      {
        source: 'stocktwits',
        sourceId: 's1',
        symbol: 'NVDA',
        url: 'https://stocktwits.com/s1',
        text: 'bearish RSI',
        publishedAt: isoMinusHour(1),
        fetchedAt: isoMinusHour(1),
        sentiment: { score: -0.4, confidence: 0.7, label: 'bearish' },
        scoredAt: isoMinusHour(1),
      },
      // Duplicate URL of first, older — should be dropped.
      {
        source: 'reddit',
        sourceId: 'a1-old',
        symbol: 'NVDA',
        url: 'https://reddit.com/r/x/a1',
        text: 'old copy',
        publishedAt: isoMinusHour(10),
        fetchedAt: isoMinusHour(10),
      },
    ];
    const latest: ContextLatestSnapshot = {
      symbol: 'NVDA',
      updatedAt: NOW.toISOString(),
      entries: {},
    };
    const ctx = await buildRecommendationContext({
      symbol: 'NVDA',
      snapshots: makeSnapshotReader(latest),
      mentions: makeMentionReader(items, []),
      now,
    });
    expect(ctx.opinions).not.toBeNull();
    expect(ctx.opinions!.items.length).toBe(2);
    const scored = ctx.opinions!.items.find((i) => i.source === 'stocktwits');
    expect(scored?.label).toBe('bearish');
    expect(scored?.score).toBeCloseTo(-0.4);
  });

  it('respects the char budget by truncating variable sections', async () => {
    // 200 news items with long summaries — way over a tiny budget.
    const newsEntries: StreamEntry[] = [];
    for (let i = 0; i < 60; i++) {
      newsEntries.push({
        ts: isoMinusHour(i),
        data: {
          title: `Headline number ${i} with extra padding text here`,
          url: `https://example.com/x-${i}`,
          source: 'yahoo',
          publishedAt: isoMinusHour(i),
          summary: 'x'.repeat(400),
        },
      });
    }
    const latest: ContextLatestSnapshot = {
      symbol: 'NVDA',
      updatedAt: NOW.toISOString(),
      entries: {},
    };
    const ctx = await buildRecommendationContext({
      symbol: 'NVDA',
      snapshots: makeSnapshotReader(latest, { news: newsEntries, quote: dailyBars(30) }),
      newsLimit: 50,
      budgetChars: 1500,
      now,
    });
    expect(ctx.budget).toBeDefined();
    expect(ctx.budget!.chars.total).toBeLessThanOrEqual(1500 + 200); // small headroom
    expect(ctx.budget!.truncated.length).toBeGreaterThan(0);
  });

  it('leaves the budget alone when under default limit', async () => {
    const ctx = await buildRecommendationContext({
      symbol: 'NVDA',
      snapshots: makeSnapshotReader({
        symbol: 'NVDA',
        updatedAt: NOW.toISOString(),
        entries: {},
      }),
      now,
    });
    expect(ctx.budget!.chars.total).toBeLessThan(DEFAULT_CONTEXT_BUDGET_CHARS);
    expect(ctx.budget!.truncated).toEqual([]);
  });

  it('is a pure function with respect to inputs (no observable side effects)', async () => {
    const latest: ContextLatestSnapshot = Object.freeze({
      symbol: 'NVDA',
      updatedAt: isoMinusMin(1),
      entries: Object.freeze({
        quote: Object.freeze({
          ts: isoMinusMin(1),
          data: Object.freeze({ price: 10, change: 0, changePercent: 0, volume: 0 }),
        }),
      }),
    }) as ContextLatestSnapshot;
    // No throw on frozen input
    await expect(
      buildRecommendationContext({
        symbol: 'NVDA',
        snapshots: makeSnapshotReader(latest),
        now,
      }),
    ).resolves.toBeTruthy();
  });
});
