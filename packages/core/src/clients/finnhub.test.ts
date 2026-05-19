import { describe, it, expect, vi } from 'vitest';
import { FinnhubClient, FinnhubCapabilityError, type FinnhubQuoteResponse } from './finnhub.js';

function mockFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('FinnhubClient', () => {
  const apiKey = 'test-key';

  it('maps /quote response onto the Quote schema and includes the token query param', async () => {
    const captured: string[] = [];
    const c = new FinnhubClient({
      apiKey,
      fetchImpl: mockFetch((url) => {
        captured.push(url);
        return jsonResponse({
          c: 123.45,
          d: 1.23,
          dp: 1.01,
          h: 124,
          l: 122,
          o: 122.5,
          pc: 122.22,
          t: 1_700_000_000,
        } satisfies FinnhubQuoteResponse);
      }),
    });
    const q = await c.quote('NVDA');
    expect(q).toEqual({
      symbol: 'NVDA',
      price: 123.45,
      change: 1.23,
      changePercent: 1.01,
      volume: 0,
      asOf: new Date(1_700_000_000_000).toISOString(),
    });
    expect(captured[0]).toContain('/quote?symbol=NVDA&token=test-key');
  });

  it('rejects all-zero responses as unknown-symbol', async () => {
    const c = new FinnhubClient({
      apiKey,
      fetchImpl: mockFetch(() => jsonResponse({ c: 0, d: 0, dp: 0, h: 0, l: 0, o: 0, pc: 0, t: 0 })),
    });
    await expect(c.quote('NOPE')).rejects.toThrow(/unknown symbol/i);
  });

  it('surfaces 429 with a clear message', async () => {
    const c = new FinnhubClient({
      apiKey,
      fetchImpl: mockFetch(() => new Response('rate limit', { status: 429 })),
    });
    await expect(c.quote('AAPL')).rejects.toThrow(/429/);
  });

  it('throws FinnhubCapabilityError for history (paid endpoint)', async () => {
    const c = new FinnhubClient({ apiKey, fetchImpl: mockFetch(() => jsonResponse({})) });
    await expect(c.history('AAPL', 30)).rejects.toBeInstanceOf(FinnhubCapabilityError);
  });

  it('maps /company-news onto NewsItem shape and asks for the last 14 days', async () => {
    const captured: string[] = [];
    const now = new Date('2024-06-15T00:00:00Z').getTime();
    const c = new FinnhubClient({
      apiKey,
      now: () => now,
      fetchImpl: mockFetch((url) => {
        captured.push(url);
        return jsonResponse([
          {
            category: 'earnings',
            datetime: 1_718_000_000,
            headline: 'Earnings beat',
            id: 1,
            image: '',
            related: 'AAPL',
            source: 'Reuters',
            summary: '',
            url: 'https://example.com/news',
          },
        ]);
      }),
    });
    const items = await c.news('AAPL');
    expect(items[0]).toMatchObject({
      title: 'Earnings beat',
      source: 'Reuters',
      url: 'https://example.com/news',
    });
    // 2024-06-15 minus 14 days = 2024-06-01
    expect(captured[0]).toContain('from=2024-06-01');
    expect(captured[0]).toContain('to=2024-06-15');
  });

  it('liveQuoteSource returns a Yahoo-shaped payload for the existing projector', async () => {
    const c = new FinnhubClient({
      apiKey,
      fetchImpl: mockFetch(() =>
        jsonResponse({ c: 100, d: 2, dp: 2.04, h: 101, l: 98, o: 99, pc: 98, t: 1_700_000_000 }),
      ),
    });
    const raw = await c.liveQuoteSource('TSLA');
    expect(raw.regularMarketPrice).toBe(100);
    expect(raw.regularMarketChangePercent).toBeCloseTo(2.04);
    expect(raw.marketState).toBe('REGULAR');
    expect(raw.regularMarketTime).toBeInstanceOf(Date);
  });

  it('refuses construction without an apiKey', () => {
    // @ts-expect-error intentionally invalid
    expect(() => new FinnhubClient({ apiKey: '' })).toThrow(/apiKey is required/);
  });
});
