import { describe, expect, it } from 'vitest';
import { TickerProfile } from './ticker.js';

describe('schemas/ticker', () => {
  it('accepts legacy source tags and normalizes them to structured attributions', () => {
    const parsed = TickerProfile.parse({
      symbol: 'AAPL',
      name: 'Apple Inc.',
      exchange: 'NASDAQ',
      type: null,
      currency: null,
      country: null,
      sector: 'Technology',
      industry: 'Consumer Electronics',
      cik: null,
      isin: null,
      cusip: null,
      website: null,
      description: 'Designs and sells consumer electronics.',
      logoUrl: null,
      sourceUrls: ['https://finance.yahoo.com/quote/AAPL'],
      validatedAt: '2026-08-10T00:00:00.000Z',
      confidence: 0.9,
      sources: ['yahoo:https://finance.yahoo.com/quote/AAPL'],
      notes: [],
    });

    expect(parsed.sources).toEqual([
      {
        name: 'yahoo',
        url: 'https://finance.yahoo.com/quote/AAPL',
        confidence: 0.5,
      },
    ]);
    expect(parsed.resolvedAt).toBeUndefined();
  });

  it('treats legacy bare URLs as legacy attributions (not `https` source names)', () => {
    const parsed = TickerProfile.parse({
      symbol: 'MSFT',
      name: 'Microsoft Corporation',
      exchange: 'NASDAQ',
      type: null,
      currency: null,
      country: null,
      sector: 'Technology',
      industry: 'Software',
      cik: null,
      isin: null,
      cusip: null,
      website: null,
      description: 'Builds software and cloud services.',
      logoUrl: null,
      sourceUrls: ['https://finance.yahoo.com/quote/MSFT'],
      validatedAt: '2026-08-10T00:00:00.000Z',
      confidence: 0.9,
      sources: ['https://finance.yahoo.com/quote/MSFT'],
      notes: [],
    });

    expect(parsed.sources).toEqual([
      {
        name: 'legacy',
        url: 'https://finance.yahoo.com/quote/MSFT',
        confidence: 0.5,
      },
    ]);
  });

  it('rejects descriptions longer than 600 characters', () => {
    const tooLong = 'x'.repeat(601);

    expect(() =>
      TickerProfile.parse({
        symbol: 'MSFT',
        name: 'Microsoft Corporation',
        exchange: 'NASDAQ',
        type: null,
        currency: null,
        country: null,
        sector: null,
        industry: null,
        cik: null,
        isin: null,
        cusip: null,
        website: null,
        description: tooLong,
        logoUrl: null,
        sourceUrls: ['https://finance.yahoo.com/quote/MSFT'],
        validatedAt: '2026-08-10T00:00:00.000Z',
        resolvedAt: '2026-08-10T00:00:00.000Z',
        confidence: 0.8,
        sources: [
          {
            name: 'yahoo',
            url: 'https://finance.yahoo.com/quote/MSFT',
            confidence: 0.8,
          },
        ],
        notes: [],
      }),
    ).toThrow(/600/);
  });
});
