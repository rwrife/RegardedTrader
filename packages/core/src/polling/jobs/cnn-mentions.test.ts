import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MentionStore } from '../mention-store.js';
import {
  pollCnnMentions,
  parseCnnMentions,
  parseCnnRssItems,
  extractCnnStockPageBlurb,
  cnnMatchesSymbol,
  cnnStockPageUrl,
  cnnUrlHash,
  CNN_DEFAULT_LOOKBACK_MS,
  CNN_DEFAULT_RSS_FEEDS,
  CNN_STOCK_PAGE_BASE_URL,
  CNN_USER_AGENT,
  type MentionNewEvent,
} from './cnn-mentions.js';

/* -------------------------------------------------------------------------- */
/* Recorded fixtures                                                           */
/* -------------------------------------------------------------------------- */

const NOW = new Date('2026-05-27T12:00:00Z');

const RSS_TOPSTORIES = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>CNN Business - Top stories</title>
  <item>
    <title><![CDATA[Nvidia ($NVDA) beats earnings again]]></title>
    <description><![CDATA[Shares of $NVDA jumped 8% after hours.]]></description>
    <link>https://www.cnn.com/2026/05/27/investing/nvda-earnings.html</link>
    <pubDate>Wed, 27 May 2026 10:00:00 GMT</pubDate>
    <guid isPermaLink="false">cnn-nvda-earnings-2026-05-27</guid>
  </item>
  <item>
    <title>Fed keeps rates steady, markets rally</title>
    <description>S&amp;P 500 up 1.2% on the day.</description>
    <link>https://www.cnn.com/2026/05/27/economy/fed-rates.html</link>
    <pubDate>Wed, 27 May 2026 11:00:00 GMT</pubDate>
    <guid>cnn-fed-2026-05-27</guid>
  </item>
  <item>
    <title>Apple unveils new iPhone</title>
    <description>Not about our ticker at all.</description>
    <link>https://www.cnn.com/2026/05/27/tech/apple-iphone.html</link>
    <pubDate>Wed, 27 May 2026 09:00:00 GMT</pubDate>
    <guid>cnn-apple-2026-05-27</guid>
  </item>
</channel></rss>`;

const RSS_MARKETS = `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel>
  <item>
    <title>Analysts raise Nvidia price target to $1400</title>
    <description>Nvidia analysts see more upside for the chipmaker.</description>
    <link>https://www.cnn.com/markets/nvda-target.html</link>
    <pubDate>Wed, 27 May 2026 11:30:00 GMT</pubDate>
    <guid>cnn-nvda-target</guid>
  </item>
  <item>
    <title>Old story about NVDA from last week</title>
    <description>$NVDA rally reviewed.</description>
    <link>https://www.cnn.com/old.html</link>
    <pubDate>Mon, 18 May 2026 09:00:00 GMT</pubDate>
    <guid>cnn-nvda-old</guid>
  </item>
</channel></rss>`;

const STOCK_PAGE_HTML = `<!DOCTYPE html>
<html><head>
  <title>NVDA: NVIDIA Corp Stock Price and News - CNN</title>
  <meta name="description" content="Nvidia stock rose 8% after strong earnings and updated guidance.">
  <meta property="og:description" content="Should also be ignored when name= wins.">
</head><body>
  <h1>NVDA $1,205.42 <span>+8.2%</span></h1>
  <p>Nvidia extended its rally following blowout Q1 numbers.</p>
</body></html>`;

const STOCK_PAGE_HTML_BROKEN = `<!doctype html><html><body>
  <div>opaque JS-rendered page with no meta/h1/p</div>
</body></html>`;

/* -------------------------------------------------------------------------- */
/* mockFetch                                                                   */
/* -------------------------------------------------------------------------- */

function mockFetch(
  handlers: Record<string, { status?: number; body: string } | { throw: string }>,
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const key of Object.keys(handlers)) {
      if (url.includes(key)) {
        const h = handlers[key]!;
        if ('throw' in h) throw new Error(h.throw);
        return new Response(h.body, { status: h.status ?? 200 });
      }
    }
    return new Response('not found', { status: 404 });
  });
}

/* -------------------------------------------------------------------------- */
/* Pure-function tests                                                         */
/* -------------------------------------------------------------------------- */

describe('cnn-mentions: URL + helpers', () => {
  it('cnnStockPageUrl lowercases the symbol and joins the base', () => {
    expect(cnnStockPageUrl('NVDA')).toBe(`${CNN_STOCK_PAGE_BASE_URL}nvda`);
  });

  it('cnnUrlHash is stable and hex-8', () => {
    const a = cnnUrlHash('hello');
    const b = cnnUrlHash('hello');
    const c = cnnUrlHash('helloz');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it('exports the documented defaults', () => {
    expect(CNN_DEFAULT_LOOKBACK_MS).toBe(24 * 60 * 60 * 1000);
    expect(CNN_DEFAULT_RSS_FEEDS.length).toBeGreaterThanOrEqual(2);
    expect(CNN_USER_AGENT).toContain('RegardedTrader');
  });
});

describe('cnnMatchesSymbol', () => {
  it('matches $SYM, (SYM), bare SYM, and company name', () => {
    expect(cnnMatchesSymbol('$NVDA is up', 'NVDA')).toBe(true);
    expect(cnnMatchesSymbol('NVIDIA (NVDA) earnings', 'NVDA')).toBe(true);
    expect(cnnMatchesSymbol('shares of NVDA rose', 'NVDA')).toBe(true);
    expect(cnnMatchesSymbol('nvidia rally today', 'NVDA', 'Nvidia')).toBe(true);
  });

  it('does not match unrelated all-caps words or partial hits', () => {
    expect(cnnMatchesSymbol('IT WAS a rally', 'IT')).toBe(true); // standalone IT
    expect(cnnMatchesSymbol('NVDACORP announced', 'NVDA')).toBe(false);
    expect(cnnMatchesSymbol('nothing here', 'NVDA')).toBe(false);
    expect(cnnMatchesSymbol('', 'NVDA')).toBe(false);
  });

  it('respects the company name only when >=2 chars', () => {
    expect(cnnMatchesSymbol('X rocks', 'NVDA', 'X')).toBe(false);
    expect(cnnMatchesSymbol('Meta earnings out', 'META', 'Meta')).toBe(true);
  });
});

describe('parseCnnRssItems', () => {
  it('extracts <item> blocks with CDATA + entities', () => {
    const items = parseCnnRssItems(RSS_TOPSTORIES);
    expect(items).toHaveLength(3);
    expect(items[0]?.title).toBe('Nvidia ($NVDA) beats earnings again');
    // & entity in description
    expect(items[1]?.description).toContain('S&P 500');
  });

  it('returns [] on garbage input', () => {
    expect(parseCnnRssItems('not xml at all')).toEqual([]);
    expect(parseCnnRssItems('')).toEqual([]);
  });
});

describe('parseCnnMentions', () => {
  it('filters RSS items to symbol/name matches and maps to MentionItem', () => {
    const items = parseCnnMentions(RSS_TOPSTORIES, 'NVDA', 'Nvidia', NOW);
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    expect(it0.source).toBe('cnn');
    expect(it0.symbol).toBe('NVDA');
    expect(it0.sourceId.startsWith('cnn_rss_')).toBe(true);
    expect(it0.title).toContain('Nvidia');
    expect(it0.url).toContain('cnn.com');
    // publishedAt derived from pubDate
    expect(it0.publishedAt).toBe('2026-05-27T10:00:00.000Z');
    expect(it0.fetchedAt).toBe(NOW.toISOString());
  });

  it('respects the lookback window', () => {
    const items = parseCnnMentions(RSS_MARKETS, 'NVDA', 'Nvidia', NOW);
    // The "old" 2026-05-18 story is >24h back, excluded.
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toContain('price target');
  });

  it('drops items when title AND description are missing/blank', () => {
    const xml =
      '<rss><channel><item><link>https://x</link><pubDate>Wed, 27 May 2026 10:00:00 GMT</pubDate></item></channel></rss>';
    expect(parseCnnMentions(xml, 'NVDA', 'Nvidia', NOW)).toEqual([]);
  });

  it('never persists an author field even if fed through', () => {
    // (Also implicitly: the schema has no `author`; store.appendMention strips
    // unknowns. Here we verify the parser does not emit one.)
    const items = parseCnnMentions(RSS_TOPSTORIES, 'NVDA', 'Nvidia', NOW);
    for (const it of items) {
      expect(Object.keys(it)).not.toContain('author');
      expect(Object.keys(it)).not.toContain('username');
    }
  });
});

describe('extractCnnStockPageBlurb', () => {
  it('prefers meta description', () => {
    const { title, blurb } = extractCnnStockPageBlurb(STOCK_PAGE_HTML);
    expect(title).toContain('NVDA');
    expect(blurb).toBe(
      'Nvidia stock rose 8% after strong earnings and updated guidance.',
    );
  });

  it('degrades gracefully when structure is unknown', () => {
    const out = extractCnnStockPageBlurb(STOCK_PAGE_HTML_BROKEN);
    expect(out.blurb).toBeUndefined();
  });

  it('returns {} on empty/non-string', () => {
    expect(extractCnnStockPageBlurb('')).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* Integration tests against MentionStore                                      */
/* -------------------------------------------------------------------------- */

describe('pollCnnMentions', () => {
  let tmp: string;
  let store: MentionStore;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'cnn-mentions-'));
    store = new MentionStore({ root: tmp });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('inserts RSS + page mentions, sends UA, dedups on second run', async () => {
    const fetchImpl = mockFetch({
      'money_topstories.rss': { body: RSS_TOPSTORIES },
      'money_markets.rss': { body: RSS_MARKETS },
      '/markets/stocks/nvda': { body: STOCK_PAGE_HTML },
    });
    const events: MentionNewEvent[] = [];

    const r1 = await pollCnnMentions({
      symbol: 'NVDA',
      name: 'Nvidia',
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      onEvent: (e) => events.push(e),
    });
    // 1 from topstories + 1 from markets + 1 from page = 3
    expect(r1.fetched).toBe(3);
    expect(r1.inserted).toBe(3);
    expect(r1.error).toBeUndefined();
    expect(events).toHaveLength(3);

    // UA header on every request
    for (const call of (fetchImpl as ReturnType<typeof vi.fn>).mock.calls) {
      const init = call[1] as RequestInit | undefined;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers['User-Agent']).toBe(CNN_USER_AGENT);
    }

    // Second run: same content -> dedup -> 0 inserts.
    const events2: MentionNewEvent[] = [];
    const r2 = await pollCnnMentions({
      symbol: 'NVDA',
      name: 'Nvidia',
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      onEvent: (e) => events2.push(e),
    });
    expect(r2.inserted).toBe(0);
    expect(events2).toHaveLength(0);
  });

  it('degrades gracefully when the stock page 404s', async () => {
    const errors: unknown[] = [];
    const fetchImpl = mockFetch({
      'money_topstories.rss': { body: RSS_TOPSTORIES },
      'money_markets.rss': { body: RSS_MARKETS },
      '/markets/stocks/nvda': { status: 404, body: 'not found' },
    });
    const r = await pollCnnMentions({
      symbol: 'NVDA',
      name: 'Nvidia',
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      onError: (e) => errors.push(e),
    });
    // 2 RSS mentions inserted, page skipped.
    expect(r.inserted).toBe(2);
    // Page error reported via onError but not on the aggregate error field
    // (depth is best-effort).
    expect(r.error).toBeUndefined();
    expect(errors.length).toBe(1);
  });

  it('degrades gracefully when the stock page HTML shape is unknown', async () => {
    const fetchImpl = mockFetch({
      'money_topstories.rss': { body: RSS_TOPSTORIES },
      'money_markets.rss': { body: RSS_MARKETS },
      '/markets/stocks/nvda': { body: STOCK_PAGE_HTML_BROKEN },
    });
    const r = await pollCnnMentions({
      symbol: 'NVDA',
      name: 'Nvidia',
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    // Only the 2 RSS mentions land; the page blurb was unrecognisable.
    expect(r.inserted).toBe(2);
    expect(r.error).toBeUndefined();
  });

  it('does not crash the scheduler when an RSS feed throws', async () => {
    const errors: unknown[] = [];
    const fetchImpl = mockFetch({
      'money_topstories.rss': { throw: 'ENETUNREACH' },
      'money_markets.rss': { body: RSS_MARKETS },
      '/markets/stocks/nvda': { body: STOCK_PAGE_HTML },
    });
    const r = await pollCnnMentions({
      symbol: 'NVDA',
      name: 'Nvidia',
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      onError: (e) => errors.push(e),
    });
    // 1 from markets + 1 from page.
    expect(r.inserted).toBe(2);
    expect(r.error).toContain('rss');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('honours skipStockPage=true', async () => {
    const fetchImpl = mockFetch({
      'money_topstories.rss': { body: RSS_TOPSTORIES },
      'money_markets.rss': { body: RSS_MARKETS },
    });
    const r = await pollCnnMentions({
      symbol: 'NVDA',
      name: 'Nvidia',
      store,
      skipStockPage: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(r.inserted).toBe(2);
    // No call to the stock page URL.
    const urls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => String(c[0]),
    );
    expect(urls.some((u) => u.includes('/markets/stocks/'))).toBe(false);
  });

  it('rejects invalid tickers up front', async () => {
    await expect(
      pollCnnMentions({
        symbol: 'not-a-ticker!',
        store,
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toBeTruthy();
  });
});
