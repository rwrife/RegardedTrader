import { describe, it, expect } from 'vitest';
import { TickerResolver, TickerResolutionError, reconcile } from './resolver.js';
import type { TickerSource } from './source.js';
import type { PartialTickerProfile } from '../schemas/ticker.js';

class MockSource implements TickerSource {
  constructor(
    public readonly name: string,
    public readonly weight: number,
    private readonly behavior: {
      fetchResult?: PartialTickerProfile | null;
      searchResult?: PartialTickerProfile[];
      throwOn?: 'fetch' | 'search' | 'both';
      delayMs?: number;
    } = {},
  ) {}

  private async maybeDelay(): Promise<void> {
    if (this.behavior.delayMs) {
      await new Promise((r) => setTimeout(r, this.behavior.delayMs));
    }
  }

  async fetch(symbol: string): Promise<PartialTickerProfile | null> {
    await this.maybeDelay();
    if (this.behavior.throwOn === 'fetch' || this.behavior.throwOn === 'both') {
      throw new Error(`${this.name} fetch failed for ${symbol}`);
    }
    return this.behavior.fetchResult ?? null;
  }

  async search(query: string): Promise<PartialTickerProfile[]> {
    await this.maybeDelay();
    if (this.behavior.throwOn === 'search' || this.behavior.throwOn === 'both') {
      throw new Error(`${this.name} search failed for ${query}`);
    }
    return this.behavior.searchResult ?? [];
  }
}

const FIXED_NOW = () => new Date('2026-05-12T09:00:00.000Z');

describe('TickerResolver', () => {
  it('resolves a single source successfully', async () => {
    const src = new MockSource('yahoo', 0.6, {
      fetchResult: {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        exchange: 'NASDAQ',
        sector: 'Technology',
        industry: 'Consumer Electronics',
        description: 'Designs and sells consumer electronics.',
        sourceUrls: ['https://finance.yahoo.com/quote/AAPL'],
      },
    });
    const resolver = new TickerResolver([src], { now: FIXED_NOW });
    const profile = await resolver.resolve('AAPL');
    expect(profile.symbol).toBe('AAPL');
    expect(profile.name).toBe('Apple Inc.');
    expect(profile.exchange).toBe('NASDAQ');
    expect(profile.sources).toEqual(['yahoo']);
    expect(profile.confidence).toBeCloseTo(1);
    expect(profile.validatedAt).toBe('2026-05-12T09:00:00.000Z');
  });

  it('reconciles partials from multiple sources, preferring highest weight for fields', async () => {
    const yahoo = new MockSource('yahoo', 0.6, {
      fetchResult: {
        symbol: 'MSFT',
        name: 'Microsoft Corporation',
        exchange: 'NASDAQ',
        sector: 'Technology',
        sourceUrls: ['https://finance.yahoo.com/quote/MSFT'],
      },
    });
    const sec = new MockSource('sec', 0.9, {
      fetchResult: {
        symbol: 'MSFT',
        name: 'MICROSOFT CORP',
        exchange: 'NASDAQ',
        industry: 'Software',
        sourceUrls: ['https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000789019'],
      },
    });
    const resolver = new TickerResolver([yahoo, sec], { now: FIXED_NOW });
    const profile = await resolver.resolve('MSFT');
    // SEC has higher weight, so its `name` wins.
    expect(profile.name).toBe('MICROSOFT CORP');
    // Sector only came from yahoo.
    expect(profile.sector).toBe('Technology');
    // Industry only came from sec.
    expect(profile.industry).toBe('Software');
    // Sources are listed in contribution order.
    expect(new Set(profile.sources)).toEqual(new Set(['yahoo', 'sec']));
    // sourceUrls are de-duped union.
    expect(profile.sourceUrls).toHaveLength(2);
    expect(profile.confidence).toBeCloseTo(1);
  });

  it('still resolves when some sources error or return missing, reducing confidence', async () => {
    const yahoo = new MockSource('yahoo', 0.6, {
      fetchResult: {
        symbol: 'TSLA',
        name: 'Tesla, Inc.',
        exchange: 'NASDAQ',
        sourceUrls: ['https://finance.yahoo.com/quote/TSLA'],
      },
    });
    const sec = new MockSource('sec', 0.9, { throwOn: 'fetch' });
    const nasdaq = new MockSource('nasdaq', 0.5, { fetchResult: null });
    const resolver = new TickerResolver([yahoo, sec, nasdaq], { now: FIXED_NOW });
    const profile = await resolver.resolve('TSLA');
    expect(profile.symbol).toBe('TSLA');
    expect(profile.sources).toEqual(['yahoo']);
    // confidence = 0.6 / (0.6 + 0.9 + 0.5) = 0.3
    expect(profile.confidence).toBeCloseTo(0.3, 5);
  });

  it('throws TickerResolutionError with per-source diagnostics when no source succeeds', async () => {
    const sec = new MockSource('sec', 0.9, { throwOn: 'fetch' });
    const nasdaq = new MockSource('nasdaq', 0.5, { fetchResult: null });
    const resolver = new TickerResolver([sec, nasdaq], { now: FIXED_NOW });
    await expect(resolver.resolve('ZZZZ')).rejects.toMatchObject({
      name: 'TickerResolutionError',
    });
    try {
      await resolver.resolve('ZZZZ');
    } catch (err) {
      expect(err).toBeInstanceOf(TickerResolutionError);
      const e = err as TickerResolutionError;
      expect(e.input).toBe('ZZZZ');
      expect(e.outcomes).toHaveLength(2);
      const byName = Object.fromEntries(e.outcomes.map((o) => [o.source, o]));
      expect(byName.sec!.ok).toBe(false);
      expect(byName.sec!.reason).toBe('error');
      expect(byName.nasdaq!.ok).toBe(false);
      expect(byName.nasdaq!.reason).toBe('missing');
    }
  });

  it('enforces a global timeout across all sources', async () => {
    const slow = new MockSource('slow', 1, {
      fetchResult: { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', sourceUrls: [] },
      delayMs: 200,
    });
    const resolver = new TickerResolver([slow], { timeoutMs: 20, now: FIXED_NOW });
    await expect(resolver.resolve('AAPL')).rejects.toBeInstanceOf(TickerResolutionError);
    try {
      await resolver.resolve('AAPL');
    } catch (err) {
      const outcomes = (err as TickerResolutionError).outcomes;
      expect(outcomes[0]!.reason).toBe('timeout');
    }
  });

  it('falls back to search() when input is not a likely symbol', async () => {
    const yahoo = new MockSource('yahoo', 0.6, {
      searchResult: [
        {
          symbol: 'NVDA',
          name: 'NVIDIA Corporation',
          exchange: 'NASDAQ',
          sourceUrls: ['https://finance.yahoo.com/quote/NVDA'],
        },
      ],
    });
    const resolver = new TickerResolver([yahoo], { now: FIXED_NOW });
    const profile = await resolver.resolve('nvidia corporation');
    expect(profile.symbol).toBe('NVDA');
  });

  it('rejects empty input and empty-source configuration', async () => {
    const resolver = new TickerResolver([], { now: FIXED_NOW });
    await expect(resolver.resolve('AAPL')).rejects.toBeInstanceOf(TickerResolutionError);
    const yahoo = new MockSource('yahoo', 0.6, {
      fetchResult: { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', sourceUrls: [] },
    });
    const r2 = new TickerResolver([yahoo], { now: FIXED_NOW });
    await expect(r2.resolve('   ')).rejects.toBeInstanceOf(TickerResolutionError);
  });
});

describe('reconcile', () => {
  it('fails if no partial supplies name or exchange', () => {
    expect(() =>
      reconcile(
        [
          {
            partial: { symbol: 'AAPL', sourceUrls: [] },
            weight: 1,
            sourceName: 'x',
          },
        ],
        1,
        '2026-05-12T09:00:00.000Z',
      ),
    ).toThrow();
  });

  it('breaks ties on symbol by weighted vote', () => {
    const profile = reconcile(
      [
        {
          partial: { symbol: 'BRK.A', name: 'Berkshire Hathaway', exchange: 'NYSE', sourceUrls: [] },
          weight: 0.4,
          sourceName: 'a',
        },
        {
          partial: { symbol: 'BRK-A', name: 'Berkshire Hathaway', exchange: 'NYSE', sourceUrls: [] },
          weight: 0.9,
          sourceName: 'b',
        },
      ],
      1.3,
      '2026-05-12T09:00:00.000Z',
    );
    expect(profile.symbol).toBe('BRK-A');
  });
});
