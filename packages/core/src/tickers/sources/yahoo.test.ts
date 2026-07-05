import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createYahooTickerSource,
  parseYahooSearch,
  parseYahooQuoteSummary,
  YAHOO_SEARCH_URL,
  YAHOO_QUOTE_SUMMARY_BASE,
} from './yahoo.js';
import { PoliteFetchClient, type FetchLike } from '../http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture(name: string): Promise<string> {
  return readFile(join(__dirname, '__fixtures__', name), 'utf8');
}

describe('parseYahooSearch', () => {
  it('extracts equities from the recorded Apple search fixture and drops non-equities', async () => {
    const json = JSON.parse(await loadFixture('yahoo-search-apple.json'));
    const results = parseYahooSearch(json, { query: 'apple' });

    // 2 equities (AAPL + APLE); the OPTION row is dropped.
    expect(results.length).toBe(2);
    const [aapl, aple] = results;

    expect(aapl?.symbol).toBe('AAPL');
    expect(aapl?.name).toBe('Apple Inc.');
    expect(aapl?.exchange).toBe('NASDAQ');
    expect(aapl?.sector).toBe('Technology');
    expect(aapl?.industry).toBe('Consumer Electronics');
    expect(aapl?.sourceUrls).toEqual([
      `${YAHOO_SEARCH_URL}?q=apple&quotesCount=10&newsCount=0`,
    ]);

    expect(aple?.symbol).toBe('APLE');
    expect(aple?.exchange).toBe('NASDAQ');
    expect(aple?.name).toBe('Apple Hospitality REIT, Inc.');
  });

  it('returns [] and warns when the response is not an object', () => {
    const warns: string[] = [];
    const out = parseYahooSearch('not-json', {
      query: 'x',
      logger: { warn: (m) => warns.push(m) },
    });
    expect(out).toEqual([]);
    expect(warns.some((w) => w.includes('not an object'))).toBe(true);
  });

  it('returns [] and warns when quotes[] is missing', () => {
    const warns: string[] = [];
    const out = parseYahooSearch(
      { foo: 'bar' },
      { query: 'x', logger: { warn: (m) => warns.push(m) } },
    );
    expect(out).toEqual([]);
    expect(warns.some((w) => w.includes('missing quotes'))).toBe(true);
  });

  it('drops malformed rows without throwing', () => {
    const warns: string[] = [];
    const out = parseYahooSearch(
      {
        quotes: [
          null,
          { quoteType: 'EQUITY' }, // missing everything else
          { quoteType: 'EQUITY', symbol: 'GOOD', longname: 'Good Co', exchDisp: 'NYSE' },
          { quoteType: 'EQUITY', symbol: 'lower', longname: 'Lower Co', exchDisp: 'NYSE' },
          {
            quoteType: 'EQUITY',
            symbol: 'BAD SYMBOL WITH SPACE',
            longname: 'X',
            exchDisp: 'NYSE',
          },
          { quoteType: 'ETF', symbol: 'SPY', longname: 'SPDR S&P 500', exchDisp: 'NYSEArca' },
        ],
      },
      { query: 'q', logger: { warn: (m) => warns.push(m) } },
    );
    // GOOD survives; the "lower" row is normalised to LOWER; ETF/OPTION/incomplete dropped.
    expect(out.map((r) => r.symbol).sort()).toEqual(['GOOD', 'LOWER']);
  });

  it('normalises exchange codes across the alias table', () => {
    const out = parseYahooSearch(
      {
        quotes: [
          { quoteType: 'EQUITY', symbol: 'AAA', longname: 'A', exchange: 'NMS' },
          { quoteType: 'EQUITY', symbol: 'BBB', longname: 'B', exchange: 'NYQ' },
          { quoteType: 'EQUITY', symbol: 'CCC', longname: 'C', exchange: 'PCX' },
        ],
      },
      { query: 'q' },
    );
    expect(out.map((r) => r.exchange)).toEqual(['NASDAQ', 'NYSE', 'NYSEARCA']);
  });
});

describe('parseYahooQuoteSummary', () => {
  it('parses the recorded AAPL quoteSummary fixture', async () => {
    const json = JSON.parse(await loadFixture('yahoo-quote-summary-AAPL.json'));
    const profile = parseYahooQuoteSummary(json, { symbol: 'AAPL' });
    expect(profile).not.toBeNull();
    expect(profile?.symbol).toBe('AAPL');
    expect(profile?.name).toBe('Apple Inc.');
    expect(profile?.exchange).toBe('NASDAQ');
    expect(profile?.sector).toBe('Technology');
    expect(profile?.industry).toBe('Consumer Electronics');
    expect(profile?.description).toContain('smartphones');
    expect(profile?.sourceUrls?.[0]).toBe(
      `${YAHOO_QUOTE_SUMMARY_BASE}/AAPL?modules=assetProfile,summaryDetail,price`,
    );
  });

  it('returns null on upstream error envelope', async () => {
    const json = JSON.parse(await loadFixture('yahoo-quote-summary-error.json'));
    const warns: string[] = [];
    const profile = parseYahooQuoteSummary(json, {
      symbol: 'ZZZZ',
      logger: { warn: (m) => warns.push(m) },
    });
    expect(profile).toBeNull();
    expect(warns.some((w) => w.includes('upstream error'))).toBe(true);
  });

  it('returns null when the response is not an object', () => {
    const warns: string[] = [];
    expect(
      parseYahooQuoteSummary(42, { symbol: 'X', logger: { warn: (m) => warns.push(m) } }),
    ).toBeNull();
    expect(warns.some((w) => w.includes('not an object'))).toBe(true);
  });

  it('returns null when quoteSummary envelope is absent', () => {
    const warns: string[] = [];
    expect(
      parseYahooQuoteSummary(
        { foo: 'bar' },
        { symbol: 'X', logger: { warn: (m) => warns.push(m) } },
      ),
    ).toBeNull();
    expect(warns.some((w) => w.includes('missing envelope'))).toBe(true);
  });

  it('returns null when result[] is empty', () => {
    expect(
      parseYahooQuoteSummary(
        { quoteSummary: { result: [], error: null } },
        { symbol: 'X' },
      ),
    ).toBeNull();
  });

  it('drops non-equity quoteTypes', () => {
    const warns: string[] = [];
    const json = {
      quoteSummary: {
        result: [
          {
            price: {
              symbol: 'SPY',
              longName: 'SPDR S&P 500 ETF Trust',
              fullExchangeName: 'NYSEArca',
              quoteType: 'ETF',
            },
          },
        ],
        error: null,
      },
    };
    expect(
      parseYahooQuoteSummary(json, {
        symbol: 'SPY',
        logger: { warn: (m) => warns.push(m) },
      }),
    ).toBeNull();
    expect(warns.some((w) => w.includes('not an equity'))).toBe(true);
  });

  it('returns null when name is missing', () => {
    const warns: string[] = [];
    const json = {
      quoteSummary: {
        result: [
          {
            price: { symbol: 'XXX', fullExchangeName: 'NYSE', quoteType: 'EQUITY' },
          },
        ],
        error: null,
      },
    };
    expect(
      parseYahooQuoteSummary(json, {
        symbol: 'XXX',
        logger: { warn: (m) => warns.push(m) },
      }),
    ).toBeNull();
    expect(warns.some((w) => w.includes('missing name'))).toBe(true);
  });

  it('returns null when no recognisable exchange is present', () => {
    const warns: string[] = [];
    const json = {
      quoteSummary: {
        result: [
          {
            price: { symbol: 'YYY', longName: 'Y Co', quoteType: 'EQUITY' },
          },
        ],
        error: null,
      },
    };
    expect(
      parseYahooQuoteSummary(json, {
        symbol: 'YYY',
        logger: { warn: (m) => warns.push(m) },
      }),
    ).toBeNull();
    expect(warns.some((w) => w.includes('recognisable exchange'))).toBe(true);
  });

  it('falls back to shortName when longName is absent and preserves optional fields', () => {
    const json = {
      quoteSummary: {
        result: [
          {
            price: {
              symbol: 'SHRT',
              shortName: 'ShortCo',
              fullExchangeName: 'NYSE',
              quoteType: 'EQUITY',
            },
          },
        ],
        error: null,
      },
    };
    const profile = parseYahooQuoteSummary(json, { symbol: 'SHRT' });
    expect(profile?.name).toBe('ShortCo');
    expect(profile?.sector).toBeUndefined();
    expect(profile?.industry).toBeUndefined();
    expect(profile?.description).toBeUndefined();
  });
});

describe('createYahooTickerSource', () => {
  it('exposes the expected name/weight and rejects out-of-range weights', () => {
    const client = new PoliteFetchClient({
      fetchImpl: async () => new Response('{}', { status: 200 }),
      sleep: async () => {},
    });
    const src = createYahooTickerSource({ client });
    expect(src.name).toBe('yahoo');
    expect(src.weight).toBeCloseTo(0.9);

    expect(() => createYahooTickerSource({ client, weight: -0.1 })).toThrow(/weight/);
    expect(() => createYahooTickerSource({ client, weight: 1.5 })).toThrow(/weight/);
    expect(createYahooTickerSource({ client, weight: 0.5 }).weight).toBeCloseTo(0.5);
  });

  it('search() hits the search URL with the right query params and parses the body', async () => {
    const body = await loadFixture('yahoo-search-apple.json');
    let seenUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      seenUrl = String(input);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const src = createYahooTickerSource({ client });
    const results = await src.search('apple');

    expect(seenUrl).toContain('/v1/finance/search');
    expect(seenUrl).toContain('q=apple');
    expect(seenUrl).toContain('quotesCount=10');
    expect(seenUrl).toContain('newsCount=0');
    expect(results.length).toBe(2);
    expect(results[0]?.symbol).toBe('AAPL');
  });

  it('search() short-circuits on empty/whitespace queries without hitting HTTP', async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return new Response('{}', { status: 200 });
    };
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const src = createYahooTickerSource({ client });
    expect(await src.search('   ')).toEqual([]);
    expect(called).toBe(false);
  });

  it('search() throws on non-2xx', async () => {
    const fetchImpl: FetchLike = async () => new Response('nope', { status: 503 });
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const src = createYahooTickerSource({ client });
    await expect(src.search('apple')).rejects.toThrow(/HTTP 5\d\d/);
  });

  it('search() throws on non-JSON body', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('<html>oops</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const src = createYahooTickerSource({ client });
    await expect(src.search('apple')).rejects.toThrow(/invalid JSON/);
  });

  it('fetch() hits the quoteSummary URL and parses the body', async () => {
    const body = await loadFixture('yahoo-quote-summary-AAPL.json');
    let seenUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      seenUrl = String(input);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const src = createYahooTickerSource({ client });
    const profile = await src.fetch('aapl');
    expect(seenUrl).toContain('/v10/finance/quoteSummary/AAPL');
    expect(seenUrl).toContain('modules=assetProfile,summaryDetail,price');
    expect(profile?.symbol).toBe('AAPL');
  });

  it('fetch() returns null on 404 without throwing', async () => {
    const fetchImpl: FetchLike = async () => new Response('nope', { status: 404 });
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const src = createYahooTickerSource({ client });
    expect(await src.fetch('ZZZZZ')).toBeNull();
  });

  it('fetch() throws on other non-2xx statuses', async () => {
    const fetchImpl: FetchLike = async () => new Response('nope', { status: 500 });
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const src = createYahooTickerSource({ client });
    await expect(src.fetch('AAPL')).rejects.toThrow(/HTTP 500/);
  });

  it('fetch() short-circuits on empty symbol without hitting HTTP', async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return new Response('{}', { status: 200 });
    };
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const src = createYahooTickerSource({ client });
    expect(await src.fetch('   ')).toBeNull();
    expect(called).toBe(false);
  });
});
