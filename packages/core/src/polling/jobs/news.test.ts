import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../store.js';
import {
  pollNews,
  parseYahooNews,
  parseNasdaqNews,
  parseGoogleNews,
  parseRssItems,
  yahooNewsUrl,
  nasdaqNewsUrl,
  googleNewsUrl,
  NewsPollerItem,
  type NewsNewEvent,
} from './news.js';

function mockFetch(handlers: Record<string, { ok?: boolean; status?: number; body: string }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const key of Object.keys(handlers)) {
      if (url.includes(key)) {
        const h = handlers[key];
        if (!h) continue;
        return new Response(h.body, {
          status: h.status ?? 200,
        });
      }
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

const YAHOO_BODY = JSON.stringify({
  news: [
    {
      title: 'NVDA hits a new high',
      link: 'https://finance.yahoo.com/article/nvda-1',
      publisher: 'Yahoo Finance',
      providerPublishTime: Math.floor(new Date('2026-05-15T10:00:00Z').getTime() / 1000),
      summary: 'Stock did a thing.',
    },
    {
      // Missing link → dropped by parser.
      title: 'No link here',
      publisher: 'Yahoo Finance',
    },
  ],
});

const NASDAQ_BODY = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title><![CDATA[NVDA analyst upgrade]]></title>
    <link>https://www.nasdaq.com/articles/nvda-2</link>
    <pubDate>Wed, 14 May 2026 09:00:00 GMT</pubDate>
    <description>Analysts &amp; raised PT.</description>
  </item>
  <item>
    <title>Skipped — no link</title>
    <pubDate>Wed, 14 May 2026 09:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const GOOGLE_BODY = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title>NVDA in the news</title>
    <link>https://news.google.com/articles/nvda-3</link>
    <pubDate>Tue, 13 May 2026 15:30:00 GMT</pubDate>
    <description><![CDATA[Press wrap-up]]></description>
  </item>
</channel></rss>`;

describe('news poller — URL builders', () => {
  it('builds Yahoo / Nasdaq / Google URLs from a symbol', () => {
    expect(yahooNewsUrl('nvda')).toContain('q=NVDA');
    expect(yahooNewsUrl('nvda')).toContain('newsCount=20');
    expect(nasdaqNewsUrl('aapl')).toContain('symbol=AAPL');
    expect(googleNewsUrl('msft')).toContain('q=MSFT%20stock');
  });
});

describe('news poller — parsers', () => {
  it('parses Yahoo JSON into validated items, skipping malformed ones', () => {
    const out = parseYahooNews(JSON.parse(YAHOO_BODY), 'nvda');
    expect(out).toHaveLength(1);
    const first = out[0]!;
    expect(first.title).toBe('NVDA hits a new high');
    expect(first.url).toBe('https://finance.yahoo.com/article/nvda-1');
    expect(first.source).toBe('yahoo');
    expect(first.tickers).toEqual(['NVDA']);
    expect(first.publishedAt).toBe('2026-05-15T10:00:00.000Z');
    // Schema-validated.
    expect(NewsPollerItem.safeParse(first).success).toBe(true);
  });

  it('returns [] for malformed Yahoo payloads', () => {
    expect(parseYahooNews({ unexpected: true }, 'nvda')).toEqual([]);
    expect(parseYahooNews(null, 'nvda')).toEqual([]);
  });

  it('parses Nasdaq RSS, handling CDATA and entities', () => {
    const out = parseNasdaqNews(NASDAQ_BODY, 'nvda');
    expect(out).toHaveLength(1);
    const nas = out[0]!;
    expect(nas.title).toBe('NVDA analyst upgrade');
    expect(nas.summary).toBe('Analysts & raised PT.');
    expect(nas.source).toBe('nasdaq');
    expect(nas.publishedAt).toBe('2026-05-14T09:00:00.000Z');
  });

  it('parses Google News RSS', () => {
    const out = parseGoogleNews(GOOGLE_BODY, 'nvda');
    expect(out).toHaveLength(1);
    const g = out[0]!;
    expect(g.title).toBe('NVDA in the news');
    expect(g.source).toBe('google-news');
    expect(g.summary).toBe('Press wrap-up');
  });

  it('parseRssItems also handles Atom-style <entry> with href link', () => {
    const atom = `<feed>
      <entry>
        <title>Atom story</title>
        <link href="https://example.com/atom-1" />
        <updated>2026-05-12T08:00:00Z</updated>
        <summary>An atom summary</summary>
      </entry>
    </feed>`;
    const items = parseRssItems(atom);
    expect(items).toHaveLength(1);
    const at = items[0]!;
    expect(at.link).toBe('https://example.com/atom-1');
    expect(at.title).toBe('Atom story');
  });
});

describe('news poller — pollNews', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'regard-newspoll-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('fetches, validates, persists, and emits news.new', async () => {
    const store = new SnapshotStore({ root });
    const events: NewsNewEvent[] = [];
    const fetchImpl = mockFetch({
      'query2.finance.yahoo.com': { body: YAHOO_BODY },
      'nasdaq.com': { body: NASDAQ_BODY },
      'news.google.com': { body: GOOGLE_BODY },
    });

    const result = await pollNews({
      symbol: 'NVDA',
      store,
      fetchImpl,
      onEvent: (e) => events.push(e),
    });

    expect(result.fetched).toBe(3);
    expect(result.inserted).toBe(3);
    expect(result.bySource.yahoo.inserted).toBe(1);
    expect(result.bySource.nasdaq.inserted).toBe(1);
    expect(result.bySource['google-news'].inserted).toBe(1);
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e.type).toBe('news.new');
      expect(e.symbol).toBe('NVDA');
      expect(NewsPollerItem.safeParse(e.item).success).toBe(true);
    }
  });

  it('dedups across calls via the store url-hash window', async () => {
    const store = new SnapshotStore({ root });
    const fetchImpl = mockFetch({
      'query2.finance.yahoo.com': { body: YAHOO_BODY },
      'nasdaq.com': { body: NASDAQ_BODY },
      'news.google.com': { body: GOOGLE_BODY },
    });

    const a = await pollNews({ symbol: 'NVDA', store, fetchImpl });
    expect(a.inserted).toBe(3);

    // Same payloads, second poll → everything dropped by the store dedup.
    const b = await pollNews({ symbol: 'NVDA', store, fetchImpl });
    expect(b.fetched).toBe(3);
    expect(b.inserted).toBe(0);
  });

  it('honors per-source on/off toggles (skips disabled sources entirely)', async () => {
    const store = new SnapshotStore({ root });
    const fetchImpl = mockFetch({
      'query2.finance.yahoo.com': { body: YAHOO_BODY },
      'nasdaq.com': { body: NASDAQ_BODY },
      'news.google.com': { body: GOOGLE_BODY },
    });

    const r = await pollNews({
      symbol: 'NVDA',
      store,
      fetchImpl,
      sources: { nasdaq: false, 'google-news': false },
    });
    expect(r.bySource.yahoo.inserted).toBe(1);
    expect(r.bySource.nasdaq.fetched).toBe(0);
    expect(r.bySource['google-news'].fetched).toBe(0);
    // Two of the three URLs should never have been hit.
    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const urls = calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('nasdaq.com'))).toBe(false);
    expect(urls.some((u) => u.includes('news.google.com'))).toBe(false);
  });

  it('continues past a failing source and reports the error', async () => {
    const store = new SnapshotStore({ root });
    const errors: Array<{ source: string; msg: string }> = [];
    const fetchImpl = mockFetch({
      'query2.finance.yahoo.com': { body: 'kaboom', status: 503 },
      'nasdaq.com': { body: NASDAQ_BODY },
      'news.google.com': { body: GOOGLE_BODY },
    });

    const r = await pollNews({
      symbol: 'NVDA',
      store,
      fetchImpl,
      onError: (src, err) => errors.push({ source: src, msg: (err as Error).message }),
    });

    expect(r.bySource.yahoo.error).toContain('HTTP 503');
    expect(r.bySource.nasdaq.inserted).toBe(1);
    expect(r.bySource['google-news'].inserted).toBe(1);
    expect(errors.find((e) => e.source === 'yahoo')).toBeTruthy();
  });

  it('in-batch dedups when two sources return the same URL', async () => {
    const store = new SnapshotStore({ root });
    const dupYahoo = JSON.stringify({
      news: [
        {
          title: 'Shared headline',
          link: 'https://news.example.com/shared',
          providerPublishTime: Math.floor(Date.parse('2026-05-15T10:00:00Z') / 1000),
        },
      ],
    });
    const dupGoogle = `<rss><channel>
      <item>
        <title>Shared headline</title>
        <link>https://news.example.com/shared</link>
        <pubDate>Wed, 15 May 2026 10:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;

    const fetchImpl = mockFetch({
      'query2.finance.yahoo.com': { body: dupYahoo },
      'nasdaq.com': { body: '<rss><channel></channel></rss>' },
      'news.google.com': { body: dupGoogle },
    });

    const r = await pollNews({ symbol: 'NVDA', store, fetchImpl });
    expect(r.fetched).toBe(1);
    expect(r.inserted).toBe(1);
  });
});
