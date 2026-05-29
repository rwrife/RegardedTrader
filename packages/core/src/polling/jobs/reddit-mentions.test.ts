import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MentionStore } from '../mention-store.js';
import {
  pollRedditMentions,
  parseRedditPostListing,
  parseRedditCommentsListing,
  redditSearchUrl,
  redditCommentsUrl,
  redditSubredditAboutUrl,
  createRedditRateLimiter,
  createSubredditProbeCache,
  REDDIT_DEFAULT_LIMIT,
  REDDIT_DEFAULT_SUBREDDITS,
  REDDIT_USER_AGENT,
  REDDIT_SUBREDDIT_PROBE_TTL_MS,
} from './reddit-mentions.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function postChild(id: string, opts: {
  title?: string;
  selftext?: string;
  created_utc?: number;
  permalink?: string;
}): unknown {
  return {
    kind: 't3',
    data: {
      id,
      title: opts.title,
      selftext: opts.selftext ?? '',
      created_utc: opts.created_utc ?? Date.UTC(2026, 4, 26, 18, 0, 0) / 1000,
      permalink: opts.permalink ?? `/r/wallstreetbets/comments/${id}/_/`,
      // Author present upstream — must NOT be persisted.
      author: 'someuser',
      subreddit: 'wallstreetbets',
    },
  };
}

function commentChild(id: string, body: string, opts: { created_utc?: number; permalink?: string } = {}): unknown {
  return {
    kind: 't1',
    data: {
      id,
      body,
      created_utc: opts.created_utc ?? Date.UTC(2026, 4, 26, 18, 5, 0) / 1000,
      permalink: opts.permalink ?? `/r/wallstreetbets/comments/abc/_/${id}/`,
      author: 'commenter',
    },
  };
}

const SEARCH_BODY = JSON.stringify({
  kind: 'Listing',
  data: {
    children: [
      postChild('post1', {
        title: '$NVDA breaking out of consolidation',
        selftext: 'calls for next week',
      }),
      postChild('post2', {
        title: '$NVDA looks heavy here',
        selftext: '',
      }),
      // Dropped: no title and no body.
      postChild('post3', { title: '', selftext: '   ' }),
      // Dropped: invalid timestamp.
      {
        kind: 't3',
        data: {
          id: 'post4',
          title: 'no time',
          created_utc: 0,
        },
      },
    ],
  },
});

function commentsBody(postId: string): string {
  return JSON.stringify([
    { kind: 'Listing', data: { children: [postChild(postId, { title: 'parent' })] } },
    {
      kind: 'Listing',
      data: {
        children: [
          commentChild(`${postId}c1`, 'great DD on NVDA'),
          commentChild(`${postId}c2`, 'IV looks rich'),
          { kind: 'more', data: { id: `${postId}more`, body: '' } },
        ],
      },
    },
  ]);
}

interface Handler {
  status?: number;
  headers?: Record<string, string>;
  body: string;
}

function mockFetch(handlers: { match: (url: string) => boolean; handler: Handler }[]) {
  const calls: string[] = [];
  const headersSeen: Record<string, string>[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    headersSeen.push((init?.headers ?? {}) as Record<string, string>);
    for (const { match, handler } of handlers) {
      if (match(url)) {
        return new Response(handler.body, {
          status: handler.status ?? 200,
          headers: handler.headers,
        });
      }
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch & { _calls: string[]; _headers: Record<string, string>[] };
  (fn as unknown as { _calls: string[] })._calls = calls;
  (fn as unknown as { _headers: Record<string, string>[] })._headers = headersSeen;
  return fn;
}

/* -------------------------------------------------------------------------- */
/* URL builders                                                                */
/* -------------------------------------------------------------------------- */

describe('reddit poller — URL builders', () => {
  it('builds a search URL with the upper-cased symbol and default limit', () => {
    const url = redditSearchUrl('wallstreetbets', 'nvda');
    expect(url).toContain('https://www.reddit.com/r/wallstreetbets/search.json');
    expect(url).toContain('q=%24NVDA');
    expect(url).toContain('restrict_sr=1');
    expect(url).toContain('sort=new');
    expect(url).toContain(`limit=${REDDIT_DEFAULT_LIMIT}`);
  });

  it('honours an explicit limit and strips r/ prefix', () => {
    expect(redditSearchUrl('r/stocks', 'AAPL', 10)).toBe(
      'https://www.reddit.com/r/stocks/search.json?q=%24AAPL&restrict_sr=1&sort=new&limit=10',
    );
  });

  it('builds the comments and about URLs', () => {
    expect(redditCommentsUrl('options', 'abc123')).toBe(
      'https://www.reddit.com/r/options/comments/abc123.json',
    );
    expect(redditSubredditAboutUrl('r/NVDA')).toBe('https://www.reddit.com/r/NVDA/about.json');
  });
});

/* -------------------------------------------------------------------------- */
/* Parsers                                                                     */
/* -------------------------------------------------------------------------- */

describe('parseRedditPostListing', () => {
  it('maps valid posts to MentionItems and merges title + selftext', () => {
    const items = parseRedditPostListing(
      JSON.parse(SEARCH_BODY),
      'NVDA',
      new Date('2026-05-26T18:30:00Z'),
    );
    expect(items).toHaveLength(2);
    expect(items[0]!.source).toBe('reddit');
    expect(items[0]!.sourceId).toBe('t3_post1');
    expect(items[0]!.symbol).toBe('NVDA');
    expect(items[0]!.text).toContain('breaking out');
    expect(items[0]!.text).toContain('calls for next week');
    expect(items[0]!.title).toBe('$NVDA breaking out of consolidation');
    expect(items[0]!.url).toBe('https://www.reddit.com/r/wallstreetbets/comments/post1/_/');
    expect(items[0]!.fetchedAt).toBe('2026-05-26T18:30:00.000Z');
  });

  it('drops authors / usernames — never present on MentionItem', () => {
    const items = parseRedditPostListing(
      JSON.parse(SEARCH_BODY),
      'NVDA',
      new Date('2026-05-26T18:30:00Z'),
    );
    for (const item of items) {
      expect((item as Record<string, unknown>).author).toBeUndefined();
      expect((item as Record<string, unknown>).user).toBeUndefined();
      expect((item as Record<string, unknown>).subreddit).toBeUndefined();
    }
  });

  it('returns [] on a bogus payload', () => {
    expect(parseRedditPostListing(null, 'NVDA')).toEqual([]);
    expect(parseRedditPostListing({ data: 'nope' }, 'NVDA')).toEqual([]);
  });
});

describe('parseRedditCommentsListing', () => {
  it('extracts only depth-1 t1 comments from the tuple payload', () => {
    const items = parseRedditCommentsListing(
      JSON.parse(commentsBody('post1')),
      'NVDA',
      new Date('2026-05-26T18:30:00Z'),
    );
    expect(items).toHaveLength(2);
    expect(items[0]!.source).toBe('reddit');
    expect(items[0]!.sourceId).toBe('t1_post1c1');
    expect(items[0]!.text).toBe('great DD on NVDA');
    // "more" placeholder dropped.
    expect(items.find((i) => i.sourceId.endsWith('more'))).toBeUndefined();
  });

  it('honours the comment limit', () => {
    const items = parseRedditCommentsListing(
      JSON.parse(commentsBody('post1')),
      'NVDA',
      new Date('2026-05-26T18:30:00Z'),
      1,
    );
    expect(items).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Rate limiter                                                                */
/* -------------------------------------------------------------------------- */

describe('createRedditRateLimiter', () => {
  it('enforces a minimum gap between acquisitions', async () => {
    let t = 1_000;
    const slept: number[] = [];
    const limiter = createRedditRateLimiter(
      2_000,
      () => t,
      async (ms) => {
        slept.push(ms);
        t += ms;
      },
    );

    await limiter.acquire(); // first call: no wait
    expect(slept).toEqual([]);

    await limiter.acquire(); // second call: must wait 2s
    expect(slept.at(-1)).toBe(2_000);

    t += 5_000; // simulate caller idling past the next slot
    await limiter.acquire();
    expect(slept).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Subreddit probe cache                                                       */
/* -------------------------------------------------------------------------- */

describe('createSubredditProbeCache', () => {
  it('returns undefined for unknown subs and remembers writes case-insensitively', () => {
    let t = 0;
    const cache = createSubredditProbeCache(1_000, () => t);
    expect(cache.get('NVDA')).toBeUndefined();
    cache.set('NVDA', true);
    expect(cache.get('nvda')).toBe(true);
  });

  it('expires entries after the TTL', () => {
    let t = 0;
    const cache = createSubredditProbeCache(1_000, () => t);
    cache.set('AAPL', false);
    t = 999;
    expect(cache.get('AAPL')).toBe(false);
    t = 1_001;
    expect(cache.get('AAPL')).toBeUndefined();
  });

  it('default TTL is one week', () => {
    expect(REDDIT_SUBREDDIT_PROBE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

/* -------------------------------------------------------------------------- */
/* Poller end-to-end                                                           */
/* -------------------------------------------------------------------------- */

describe('pollRedditMentions', () => {
  let dir: string;
  let store: MentionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reddit-test-'));
    store = new MentionStore({ root: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function instantLimiter() {
    return { acquire: async () => {} };
  }

  it('polls one sub, persists posts + comments, and emits mention.new', async () => {
    const fetchImpl = mockFetch([
      {
        match: (url) => url.includes('/r/wallstreetbets/search.json'),
        handler: { body: SEARCH_BODY },
      },
      {
        match: (url) => url.includes('/r/wallstreetbets/comments/post1.json'),
        handler: { body: commentsBody('post1') },
      },
      {
        match: (url) => url.includes('/r/wallstreetbets/comments/post2.json'),
        handler: { body: commentsBody('post2') },
      },
    ]);
    const events: unknown[] = [];
    const result = await pollRedditMentions({
      symbol: 'NVDA',
      store,
      subreddits: ['wallstreetbets'],
      probeSymbolSubreddit: false,
      fetchImpl,
      limiter: instantLimiter(),
      now: () => new Date('2026-05-26T18:30:00Z'),
      sleep: async () => {},
      commentLimit: 2,
      onEvent: (e) => events.push(e),
    });

    // 2 posts + 2 comments per post = 6 total persisted.
    expect(result.fetched).toBe(6);
    expect(result.inserted).toBe(6);
    expect(events).toHaveLength(6);
    expect(result.bySub.wallstreetbets).toEqual({
      fetched: 6,
      inserted: 6,
      posts: 2,
      comments: 4,
    });
  });

  it('dedupes on (source, sourceId) across consecutive polls', async () => {
    const fetchImpl = mockFetch([
      {
        match: (url) => url.includes('/r/stocks/search.json'),
        handler: { body: SEARCH_BODY },
      },
      {
        match: (url) => url.includes('/r/stocks/comments/'),
        handler: { body: commentsBody('post1') },
      },
    ]);
    const first = await pollRedditMentions({
      symbol: 'NVDA',
      store,
      subreddits: ['stocks'],
      probeSymbolSubreddit: false,
      fetchImpl,
      limiter: instantLimiter(),
      sleep: async () => {},
      commentLimit: 2,
    });
    const second = await pollRedditMentions({
      symbol: 'NVDA',
      store,
      subreddits: ['stocks'],
      probeSymbolSubreddit: false,
      fetchImpl,
      limiter: instantLimiter(),
      sleep: async () => {},
      commentLimit: 2,
    });
    expect(first.inserted).toBeGreaterThan(0);
    expect(second.inserted).toBe(0);
  });

  it('sends the identified User-Agent on every request', async () => {
    const fetchImpl = mockFetch([
      { match: (url) => url.includes('search.json'), handler: { body: SEARCH_BODY } },
      { match: (url) => url.includes('/comments/'), handler: { body: commentsBody('post1') } },
    ]);
    await pollRedditMentions({
      symbol: 'NVDA',
      store,
      subreddits: ['wallstreetbets'],
      probeSymbolSubreddit: false,
      fetchImpl,
      limiter: instantLimiter(),
      sleep: async () => {},
      commentLimit: 0,
    });
    const headers = (fetchImpl as unknown as { _headers: Record<string, string>[] })._headers;
    expect(headers.length).toBeGreaterThan(0);
    for (const h of headers) {
      expect(h['User-Agent']).toBe(REDDIT_USER_AGENT);
    }
  });

  it('records an error per sub on HTTP 5xx without throwing', async () => {
    const fetchImpl = mockFetch([
      {
        match: (url) => url.includes('search.json'),
        handler: { status: 503, body: 'oops' },
      },
    ]);
    const errors: { sub: string; err: unknown }[] = [];
    const result = await pollRedditMentions({
      symbol: 'NVDA',
      store,
      subreddits: ['stocks'],
      probeSymbolSubreddit: false,
      fetchImpl,
      limiter: instantLimiter(),
      sleep: async () => {},
      commentLimit: 0,
      onError: (sub, err) => errors.push({ sub, err }),
    });
    expect(result.inserted).toBe(0);
    expect(result.bySub.stocks!.error).toContain('503');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.sub).toBe('stocks');
  });

  it('retries on HTTP 429 honouring Retry-After', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('search.json')) {
        calls += 1;
        if (calls === 1) {
          return new Response('rate limited', {
            status: 429,
            headers: { 'retry-after': '0' },
          });
        }
        return new Response(SEARCH_BODY, { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const slept: number[] = [];
    const result = await pollRedditMentions({
      symbol: 'NVDA',
      store,
      subreddits: ['stocks'],
      probeSymbolSubreddit: false,
      fetchImpl,
      limiter: instantLimiter(),
      sleep: async (ms) => {
        slept.push(ms);
      },
      commentLimit: 0,
    });
    expect(calls).toBe(2);
    expect(slept.length).toBeGreaterThan(0);
    expect(result.inserted).toBe(2);
  });

  it('probes r/$SYMBOL and includes it when it exists', async () => {
    const aboutBody = JSON.stringify({
      kind: 't5',
      data: { display_name: 'NVDA', subscribers: 12_345 },
    });
    const searchedSubs: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/about.json')) return new Response(aboutBody, { status: 200 });
      if (url.includes('search.json')) {
        const m = /\/r\/([^/]+)\/search\.json/.exec(url);
        if (m && m[1]) searchedSubs.push(m[1]);
        return new Response(SEARCH_BODY, { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await pollRedditMentions({
      symbol: 'NVDA',
      store,
      subreddits: ['wallstreetbets'],
      fetchImpl,
      limiter: instantLimiter(),
      sleep: async () => {},
      commentLimit: 0,
    });
    expect(searchedSubs).toContain('wallstreetbets');
    expect(searchedSubs).toContain('NVDA');
  });

  it('skips r/$SYMBOL when the probe says it does not exist', async () => {
    const searchedSubs: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/about.json')) return new Response('nope', { status: 404 });
      if (url.includes('search.json')) {
        const m = /\/r\/([^/]+)\/search\.json/.exec(url);
        if (m && m[1]) searchedSubs.push(m[1]);
        return new Response(SEARCH_BODY, { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await pollRedditMentions({
      symbol: 'NOSUCH',
      store,
      subreddits: ['stocks'],
      fetchImpl,
      limiter: instantLimiter(),
      sleep: async () => {},
      commentLimit: 0,
    });
    expect(searchedSubs).toEqual(['stocks']);
  });

  it('uses cached probe result on the second call', async () => {
    const aboutBody = JSON.stringify({ kind: 't5', data: { display_name: 'NVDA' } });
    let aboutCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/about.json')) {
        aboutCalls += 1;
        return new Response(aboutBody, { status: 200 });
      }
      if (url.includes('search.json')) {
        return new Response(SEARCH_BODY, { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const probeCache = createSubredditProbeCache();
    const limiter = instantLimiter();
    const common = {
      symbol: 'NVDA',
      store,
      subreddits: ['wallstreetbets'],
      fetchImpl,
      limiter,
      probeCache,
      sleep: async () => {},
      commentLimit: 0,
    };
    await pollRedditMentions(common);
    await pollRedditMentions(common);
    expect(aboutCalls).toBe(1);
  });

  it('coalesces concurrent (symbol, sub) polls via single-flight', async () => {
    let searchCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('search.json')) {
        searchCalls += 1;
        return new Response(SEARCH_BODY, { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const limiter = instantLimiter();
    const common = {
      symbol: 'NVDA',
      store,
      subreddits: ['stocks'],
      probeSymbolSubreddit: false,
      fetchImpl,
      limiter,
      sleep: async () => {},
      commentLimit: 0,
    };
    await Promise.all([pollRedditMentions(common), pollRedditMentions(common)]);
    // Only one upstream search request issued; the second poll coalesces.
    expect(searchCalls).toBe(1);
  });

  it('exposes a sensible default sub list', () => {
    expect(REDDIT_DEFAULT_SUBREDDITS).toContain('wallstreetbets');
    expect(REDDIT_DEFAULT_SUBREDDITS).toContain('options');
    expect(REDDIT_DEFAULT_SUBREDDITS).toContain('Daytrading');
  });
});
