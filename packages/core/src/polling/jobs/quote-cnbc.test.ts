import { describe, expect, it, vi } from 'vitest';
import { createCnbcQuoteSource } from './quote-cnbc.js';

function mockJson(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('createCnbcQuoteSource', () => {
  it('parses a single-quote JSON payload', async () => {
    const fetchImpl = mockJson({
      QuickQuoteResult: {
        QuickQuote: {
          symbol: 'NVDA',
          last: '1187.50',
          change: '12.34',
          change_pct: '1.05',
          volume: '123456789',
          FundamentalData: { mktcap: '29191000000000' },
        },
      },
    });
    const src = createCnbcQuoteSource({ fetchImpl });
    const q = await src.quote('nvda');
    expect(q.symbol).toBe('NVDA');
    expect(q.price).toBeCloseTo(1187.5);
    expect(q.change).toBeCloseTo(12.34);
    expect(q.changePercent).toBeCloseTo(1.05);
    expect(q.volume).toBe(123_456_789);
    expect(q.marketCap).toBe(29191000000000);
  });

  it('handles array-shaped QuickQuote payloads', async () => {
    const fetchImpl = mockJson({
      QuickQuoteResult: {
        QuickQuote: [
          {
            symbol: 'AAPL',
            last: 250,
            change: 1,
            change_pct: 0.4,
            volume: 1000,
          },
        ],
      },
    });
    const q = await createCnbcQuoteSource({ fetchImpl }).quote('AAPL');
    expect(q.price).toBe(250);
    expect(q.volume).toBe(1000);
    expect(q.marketCap).toBeUndefined();
  });

  it('throws on non-200', async () => {
    const fetchImpl = mockJson({}, 503);
    await expect(
      createCnbcQuoteSource({ fetchImpl }).quote('NVDA'),
    ).rejects.toThrow(/cnbc quote HTTP 503/);
  });

  it('throws on missing rows', async () => {
    const fetchImpl = mockJson({ QuickQuoteResult: { QuickQuote: [] } });
    await expect(
      createCnbcQuoteSource({ fetchImpl }).quote('NVDA'),
    ).rejects.toThrow(/no rows/);
  });

  it('throws on malformed response', async () => {
    const fetchImpl = mockJson({ nope: true });
    await expect(
      createCnbcQuoteSource({ fetchImpl }).quote('NVDA'),
    ).rejects.toThrow(/malformed/);
  });
});
