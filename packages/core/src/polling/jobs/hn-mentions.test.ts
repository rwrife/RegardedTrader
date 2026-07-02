import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MentionStore } from '../mention-store.js';
import {
  pollHnMentions,
  parseHnMentions,
  hnSearchUrl,
  hnItemUrl,
  HN_DEFAULT_HITS_PER_PAGE,
  HN_DEFAULT_LOOKBACK_MS,
  HN_ITEM_BASE_URL,
  HN_SEARCH_BASE_URL,
  type MentionNewEvent,
} from './hn-mentions.js';

/* -------------------------------------------------------------------------- */
/* Recorded fixture — trimmed to the fields the poller reads.                  */
/* -------------------------------------------------------------------------- */

const NOW = new Date('2026-05-27T12:00:00Z');
const T1 = Date.UTC(2026, 4, 27, 10, 0, 0) / 1000; // 10:00 UTC
const T2 = Date.UTC(2026, 4, 27, 11, 0, 0) / 1000; // 11:00 UTC
const T3 = Date.UTC(2026, 4, 27, 11, 30, 0) / 1000; // 11:30 UTC

const HN_BODY = JSON.stringify({
  hits: [
    {
      objectID: '40000001',
      title: 'Nvidia beats earnings; $NVDA up 8% after hours',
      url: 'https://example.com/nvda-earnings',
      story_text: null,
      created_at: '2026-05-27T10:00:00Z',
      created_at_i: T1,
      // Author present upstream — must NOT be persisted.
      author: 'someuser',
      points: 200,
    },
    {
      objectID: '40000002',
      title: 'Ask HN: is $NVDA overvalued at $1200?',
      url: null,
      story_text: 'Long rambling self-post about NVDA valuation and options flow.',
      created_at_i: T2,
      author: 'anotheruser',
    },
    {
      // Dropped: no title and no story_text.
      objectID: '40000003',
      title: null,
      story_text: '   ',
      created_at_i: T3,
    },
    {
      // Dropped: no valid timestamp.
      objectID: '40000004',
      title: 'no time',
      story_text: 'body',
      created_at: 'not-a-date',
      created_at_i: 0,
    },
    {
      // Dropped: missing objectID → schema failure, whole hit skipped.
      title: 'no id',
      story_text: 'body',
      created_at_i: T3,
    },
  ],
});

function mockFetch(handlers: Record<string, { status?: number; body: string }>) {
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

describe('hn poller — URL builder', () => {
  it('builds a symbol-only query when no name is supplied', () => {
    const url = hnSearchUrl('nvda', undefined, 1_700_000_000);
    expect(url.startsWith(`${HN_SEARCH_BASE_URL}?`)).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('query')).toBe('$NVDA');
    expect(params.get('tags')).toBe('story');
    expect(params.get('numericFilters')).toBe('created_at_i>1700000000');
    expect(params.get('hitsPerPage')).toBe(String(HN_DEFAULT_HITS_PER_PAGE));
  });

  it('adds a quoted OR clause when a company name is supplied', () => {
    const url = hnSearchUrl('NVDA', 'NVIDIA Corporation', 100);
    const params = new URL(url).searchParams;
    expect(params.get('query')).toBe('$NVDA OR "NVIDIA Corporation"');
  });

  it('strips embedded quotes from the company name (no injection into the query)', () => {
    const url = hnSearchUrl('NVDA', 'NV"IDIA', 100);
    const params = new URL(url).searchParams;
    expect(params.get('query')).toBe('$NVDA OR "NVIDIA"');
  });

  it('floors and clamps the cutoff', () => {
    const url = hnSearchUrl('NVDA', undefined, -1);
    expect(new URL(url).searchParams.get('numericFilters')).toBe('created_at_i>0');
    const url2 = hnSearchUrl('NVDA', undefined, 12.7);
    expect(new URL(url2).searchParams.get('numericFilters')).toBe('created_at_i>12');
  });

  it('hnItemUrl builds a valid item permalink', () => {
    expect(hnItemUrl('40000001')).toBe(`${HN_ITEM_BASE_URL}40000001`);
  });
});

/* -------------------------------------------------------------------------- */
/* Parser                                                                      */
/* -------------------------------------------------------------------------- */

describe('parseHnMentions', () => {
  it('maps valid hits to MentionItems and drops empty / undated ones', () => {
    const items = parseHnMentions(JSON.parse(HN_BODY), 'NVDA', NOW);
    expect(items).toHaveLength(2);

    const first = items[0]!;
    expect(first.source).toBe('hn');
    expect(first.sourceId).toBe('hn_40000001');
    expect(first.symbol).toBe('NVDA');
    expect(first.title).toContain('Nvidia beats earnings');
    expect(first.text).toContain('Nvidia beats earnings');
    expect(first.url).toBe('https://example.com/nvda-earnings');
    expect(first.publishedAt).toBe('2026-05-27T10:00:00.000Z');
    expect(first.fetchedAt).toBe(NOW.toISOString());

    const second = items[1]!;
    expect(second.sourceId).toBe('hn_40000002');
    // No external url on the hit — falls back to the HN item permalink.
    expect(second.url).toBe(hnItemUrl('40000002'));
    // Title + body concatenated for the scorer.
    expect(second.text).toContain('Ask HN');
    expect(second.text).toContain('valuation and options flow');
  });

  it('strips author / points — they never appear on MentionItem', () => {
    const items = parseHnMentions(JSON.parse(HN_BODY), 'NVDA', NOW);
    for (const item of items) {
      const asRecord = item as Record<string, unknown>;
      expect(asRecord.author).toBeUndefined();
      expect(asRecord.points).toBeUndefined();
    }
  });

  it('prefers the ISO created_at over created_at_i when both are present', () => {
    const items = parseHnMentions(JSON.parse(HN_BODY), 'NVDA', NOW);
    // First hit had both — ISO wins.
    expect(items[0]!.publishedAt).toBe('2026-05-27T10:00:00.000Z');
    // Second hit only had created_at_i.
    expect(items[1]!.publishedAt).toBe(new Date(T2 * 1000).toISOString());
  });

  it('returns [] on a totally bogus payload', () => {
    expect(parseHnMentions(null, 'NVDA')).toEqual([]);
    expect(parseHnMentions({ hits: 'not-an-array' }, 'NVDA')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Poller                                                                      */
/* -------------------------------------------------------------------------- */

describe('pollHnMentions', () => {
  let dir: string;
  let store: MentionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hn-test-'));
    store = new MentionStore({ root: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists fresh mentions, emits mention.new, and dedups on the second run', async () => {
    const fetchImpl = mockFetch({
      'hn.algolia.com': { body: HN_BODY },
    });
    const events: MentionNewEvent[] = [];

    const first = await pollHnMentions({
      symbol: 'NVDA',
      store,
      fetchImpl,
      onEvent: (e) => events.push(e),
      now: () => NOW,
    });

    expect(first.fetched).toBe(2);
    expect(first.inserted).toBe(2);
    expect(first.error).toBeUndefined();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === 'mention.new')).toBe(true);
    expect(events[0]!.item.source).toBe('hn');

    // Second poll — same payload, store should dedup both hits.
    const second = await pollHnMentions({
      symbol: 'NVDA',
      store,
      fetchImpl,
      onEvent: (e) => events.push(e),
      now: () => new Date(NOW.getTime() + 60_000),
    });
    expect(second.fetched).toBe(2);
    expect(second.inserted).toBe(0);
    expect(events).toHaveLength(2);
  });

  it('honours the lookback window when building the cutoff', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return new Response(HN_BODY, { status: 200 });
    }) as unknown as typeof fetch;

    await pollHnMentions({
      symbol: 'NVDA',
      store,
      fetchImpl,
      now: () => NOW,
      name: 'NVIDIA Corporation',
      lookbackMs: HN_DEFAULT_LOOKBACK_MS,
    });

    const params = new URL(capturedUrl).searchParams;
    const expectedCutoff = Math.floor((NOW.getTime() - HN_DEFAULT_LOOKBACK_MS) / 1000);
    expect(params.get('numericFilters')).toBe(`created_at_i>${expectedCutoff}`);
    expect(params.get('query')).toBe('$NVDA OR "NVIDIA Corporation"');
  });

  it('reports HTTP errors via onError and returns an empty result', async () => {
    const fetchImpl = mockFetch({
      'hn.algolia.com': { body: 'rate limited', status: 429 },
    });
    const errors: unknown[] = [];

    const result = await pollHnMentions({
      symbol: 'NVDA',
      store,
      fetchImpl,
      onError: (e) => errors.push(e),
      now: () => NOW,
    });

    expect(result.fetched).toBe(0);
    expect(result.inserted).toBe(0);
    expect(result.error).toBe('HTTP 429');
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('HTTP 429');
  });

  it('reports invalid JSON via onError', async () => {
    const fetchImpl = mockFetch({
      'hn.algolia.com': { body: 'not json at all' },
    });
    const errors: unknown[] = [];
    const result = await pollHnMentions({
      symbol: 'NVDA',
      store,
      fetchImpl,
      onError: (e) => errors.push(e),
      now: () => NOW,
    });
    expect(result.inserted).toBe(0);
    expect(result.error).toBeTruthy();
    expect(errors).toHaveLength(1);
  });
});
