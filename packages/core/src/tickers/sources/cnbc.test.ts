import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PoliteFetchClient, type FetchLike } from '../http.js';
import {
  CNBC_QUOTE_LOOKUP_URL,
  createCnbcTickerSource,
  parseCnbcQuotePageHtml,
  parseCnbcQuoteResponse,
} from './cnbc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture(name: string): Promise<string> {
  return readFile(join(__dirname, '__fixtures__', name), 'utf8');
}

describe('parseCnbcQuoteResponse', () => {
  it('parses a valid quote payload', async () => {
    const json = JSON.parse(await loadFixture('cnbc-quote-aapl.json'));
    const parsed = parseCnbcQuoteResponse(json, {
      sourceUrl: `${CNBC_QUOTE_LOOKUP_URL}?symbols=AAPL&output=json`,
      requestedSymbol: 'AAPL',
    });

    expect(parsed).toMatchObject({
      symbol: 'AAPL',
      name: 'Apple Inc',
      exchange: 'NASDAQ',
      assetType: 'STOCK',
      assetSubType: 'Common Stock',
      countryCode: 'US',
    });
  });

  it('returns null for non-zero code rows', async () => {
    const json = JSON.parse(await loadFixture('cnbc-quote-miss.json'));
    const parsed = parseCnbcQuoteResponse(json, {
      sourceUrl: `${CNBC_QUOTE_LOOKUP_URL}?symbols=NOTASYMBOL&output=json`,
      requestedSymbol: 'NOTASYMBOL',
    });
    expect(parsed).toBeNull();
  });
});

describe('parseCnbcQuotePageHtml', () => {
  it('extracts quote data from an embedded JSON snippet in HTML', async () => {
    const html = await loadFixture('cnbc-quote-page-aapl.html');
    const parsed = parseCnbcQuotePageHtml(html, {
      sourceUrl: 'https://www.cnbc.com/quotes/AAPL',
      requestedSymbol: 'AAPL',
    });

    expect(parsed).toMatchObject({
      symbol: 'AAPL',
      name: 'Apple Inc',
      exchange: 'NASDAQ',
      assetType: 'STOCK',
      assetSubType: 'Common Stock',
      countryCode: 'US',
    });
  });
});

describe('createCnbcTickerSource', () => {
  it('exposes expected name/weight and validates weight bounds', () => {
    const client = new PoliteFetchClient({
      fetchImpl: async () => new Response('{}', { status: 200 }),
      sleep: async () => {},
    });

    const src = createCnbcTickerSource({ client });
    expect(src.name).toBe('cnbc');
    expect(src.weight).toBeCloseTo(0.6);

    expect(() => createCnbcTickerSource({ client, weight: -0.1 })).toThrow(/weight/);
    expect(() => createCnbcTickerSource({ client, weight: 1.1 })).toThrow(/weight/);
  });

  it('fetch() maps endpoint JSON into a partial profile', async () => {
    const body = await loadFixture('cnbc-quote-aapl.json');

    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('symbols=AAPL')) {
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const src = createCnbcTickerSource({ client });

    const profile = await src.fetch('AAPL');
    expect(profile).not.toBeNull();
    expect(profile?.symbol).toBe('AAPL');
    expect(profile?.name).toBe('Apple Inc');
    expect(profile?.exchange).toBe('NASDAQ');
    expect(profile?.description).toContain('Common Stock');
    expect(profile?.description).toContain('country US');
    expect(profile?.sourceUrls?.[0]).toContain('quote.htm?symbols=AAPL&output=json');
  });

  it('fetch() falls back to quote-page parsing when quote JSON has code!=0', async () => {
    const missBody = await loadFixture('cnbc-quote-miss.json');
    const pageBody = await loadFixture('cnbc-quote-page-aapl.html');

    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('/quote.htm?symbols=AAPL&output=json')) {
        return new Response(missBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/quotes/AAPL')) {
        return new Response(pageBody, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const src = createCnbcTickerSource({ client });

    const profile = await src.fetch('AAPL');
    expect(profile?.symbol).toBe('AAPL');
    expect(profile?.exchange).toBe('NASDAQ');
    expect(profile?.sourceUrls).toEqual(['https://www.cnbc.com/quotes/AAPL']);
  });

  it('search() tries symbol normalisation candidates (BRK-B -> BRK.B)', async () => {
    const body = JSON.stringify({
      QuickQuoteResult: {
        QuickQuote: [{ symbol: 'BRK.B', code: '0', name: 'Berkshire Hathaway Inc', exchange: 'NYSE' }],
      },
    });

    const seenUrls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.includes('symbols=BRK.B')) {
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(
        JSON.stringify({ QuickQuoteResult: { QuickQuote: [{ symbol: 'BRK-B', code: '1' }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const src = createCnbcTickerSource({ client });

    const results = await src.search('BRK-B');
    expect(results.map((r) => r.symbol)).toContain('BRK.B');
    expect(seenUrls.some((u) => u.includes('symbols=BRK-B'))).toBe(true);
    expect(seenUrls.some((u) => u.includes('symbols=BRK.B'))).toBe(true);
  });
});
