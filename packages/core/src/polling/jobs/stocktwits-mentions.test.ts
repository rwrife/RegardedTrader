import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MentionStore } from '../mention-store.js';
import {
  pollStocktwitsMentions,
  parseStocktwitsMentions,
  stocktwitsStreamUrl,
  STOCKTWITS_DEFAULT_LIMIT,
  type MentionNewEvent,
} from './stocktwits-mentions.js';

/* -------------------------------------------------------------------------- */
/* Recorded fixture (trimmed to fields we read).                               */
/* -------------------------------------------------------------------------- */

const STOCKTWITS_BODY = JSON.stringify({
  cursor: { more: false, since: 0, max: 0 },
  response: { status: 200 },
  symbol: { id: 6066, symbol: 'NVDA', title: 'NVIDIA Corporation' },
  messages: [
    {
      id: 555000001,
      body: '$NVDA breaking out of consolidation — calls for next week',
      created_at: '2026-05-26T18:01:00Z',
      // Author / username intentionally present in the upstream payload —
      // the poller / store must not persist them.
      user: { id: 1, username: 'someuser', followers: 123 },
      entities: { sentiment: { basic: 'Bullish' } },
    },
    {
      id: 555000002,
      body: '$NVDA looks heavy here, IV crush after earnings',
      created_at: '2026-05-26T18:05:00Z',
      user: { id: 2, username: 'bear42' },
      entities: { sentiment: { basic: 'Bearish' } },
    },
    {
      id: 555000003,
      body: 'Just watching $NVDA today',
      created_at: '2026-05-26T18:10:00Z',
      // `sentiment` is `null` when the poster did not tag their message.
      entities: { sentiment: null },
    },
    {
      // Dropped: empty body.
      id: 555000004,
      body: '   ',
      created_at: '2026-05-26T18:11:00Z',
    },
    {
      // Dropped: invalid timestamp.
      id: 555000005,
      body: 'No time on this one',
      created_at: 'not-a-date',
    },
  ],
});

function mockFetch(handlers: Record<string, { ok?: boolean; status?: number; body: string }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const key of Object.keys(handlers)) {
      if (url.includes(key)) {
        const h = handlers[key];
        if (!h) continue;
        return new Response(h.body, { status: h.status ?? 200 });
      }
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

/* -------------------------------------------------------------------------- */
/* URL builder                                                                 */
/* -------------------------------------------------------------------------- */

describe('stocktwits poller — URL builder', () => {
  it('uppercases the symbol and uses the default limit', () => {
    const url = stocktwitsStreamUrl('nvda');
    expect(url).toBe(
      `https://api.stocktwits.com/api/2/streams/symbol/NVDA.json?limit=${STOCKTWITS_DEFAULT_LIMIT}`,
    );
  });

  it('honours an explicit limit override', () => {
    expect(stocktwitsStreamUrl('aapl', 10)).toContain('limit=10');
  });
});

/* -------------------------------------------------------------------------- */
/* Parser                                                                      */
/* -------------------------------------------------------------------------- */

describe('parseStocktwitsMentions', () => {
  it('maps valid messages to MentionItems and captures the self-declared label', () => {
    const items = parseStocktwitsMentions(
      JSON.parse(STOCKTWITS_BODY),
      'NVDA',
      new Date('2026-05-26T18:30:00Z'),
    );
    // 3 valid messages survive (empty body + bad timestamp dropped).
    expect(items).toHaveLength(3);

    const bullish = items[0]!;
    expect(bullish.source).toBe('stocktwits');
    expect(bullish.sourceId).toBe('555000001');
    expect(bullish.symbol).toBe('NVDA');
    expect(bullish.text).toContain('breaking out');
    expect(bullish.publishedAt).toBe('2026-05-26T18:01:00.000Z');
    expect(bullish.fetchedAt).toBe('2026-05-26T18:30:00.000Z');
    expect(bullish.meta?.sentimentLabel).toBe('bullish');

    expect(items[1]!.meta?.sentimentLabel).toBe('bearish');
    // Untagged message has no `meta.sentimentLabel`.
    expect(items[2]!.meta).toBeUndefined();
  });

  it('strips author / username — they never appear on MentionItem', () => {
    const items = parseStocktwitsMentions(
      JSON.parse(STOCKTWITS_BODY),
      'NVDA',
      new Date('2026-05-26T18:30:00Z'),
    );
    for (const item of items) {
      // Author fields are not on the MentionItem schema; Zod strips them.
      expect((item as Record<string, unknown>).user).toBeUndefined();
      expect((item as Record<string, unknown>).author).toBeUndefined();
    }
  });

  it('returns [] on a totally bogus payload', () => {
    expect(parseStocktwitsMentions(null, 'NVDA')).toEqual([]);
    expect(parseStocktwitsMentions({ messages: 'not-an-array' }, 'NVDA')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Poller                                                                      */
/* -------------------------------------------------------------------------- */

describe('pollStocktwitsMentions', () => {
  let dir: string;
  let store: MentionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stocktwits-test-'));
    store = new MentionStore({ root: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists fresh mentions, emits mention.new, and dedups on the second run', async () => {
    const fetchImpl = mockFetch({
      'api.stocktwits.com': { body: STOCKTWITS_BODY },
    });
    const events: MentionNewEvent[] = [];

    const first = await pollStocktwitsMentions({
      symbol: 'NVDA',
      store,
      fetchImpl,
      onEvent: (e) => events.push(e),
      now: () => new Date('2026-05-26T18:30:00Z'),
    });

    expect(first.fetched).toBe(3);
    expect(first.inserted).toBe(3);
    expect(first.error).toBeUndefined();
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.type === 'mention.new')).toBe(true);
    expect(events[0]!.item.source).toBe('stocktwits');

    // Second poll — same payload, store should dedup all of them.
    const second = await pollStocktwitsMentions({
      symbol: 'NVDA',
      store,
      fetchImpl,
      onEvent: (e) => events.push(e),
      now: () => new Date('2026-05-26T18:35:00Z'),
    });
    expect(second.fetched).toBe(3);
    expect(second.inserted).toBe(0);
    // No new events emitted on the dedup pass.
    expect(events).toHaveLength(3);
  });

  it('reports HTTP errors via onError and returns an empty result', async () => {
    const fetchImpl = mockFetch({
      'api.stocktwits.com': { body: 'rate limited', status: 429 },
    });
    const errors: unknown[] = [];

    const result = await pollStocktwitsMentions({
      symbol: 'NVDA',
      store,
      fetchImpl,
      onError: (e) => errors.push(e),
    });

    expect(result.fetched).toBe(0);
    expect(result.inserted).toBe(0);
    expect(result.error).toBe('HTTP 429');
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('HTTP 429');
  });

  it('reports invalid JSON via onError', async () => {
    const fetchImpl = mockFetch({
      'api.stocktwits.com': { body: 'not json at all' },
    });
    const errors: unknown[] = [];
    const result = await pollStocktwitsMentions({
      symbol: 'NVDA',
      store,
      fetchImpl,
      onError: (e) => errors.push(e),
    });
    expect(result.inserted).toBe(0);
    expect(result.error).toBeTruthy();
    expect(errors).toHaveLength(1);
  });
});
