import { describe, expect, it } from 'vitest';
import { ReconcileConflictError, reconcile } from './reconcile.js';

describe('tickers/reconcile', () => {
  it('returns a stable profile when all sources unanimously agree', () => {
    const profile = reconcile(
      [
        {
          source: { name: 'sec', weight: 0.9 },
          partial: {
            symbol: 'AAPL',
            name: 'Apple Inc.',
            exchange: 'NASDAQ',
            sector: 'Technology',
            industry: 'Consumer Electronics',
            description: 'Designs and sells consumer electronics.',
            sourceUrls: ['https://www.sec.gov/example/aapl'],
          },
        },
        {
          source: { name: 'yahoo', weight: 0.7 },
          partial: {
            symbol: 'AAPL',
            name: 'Apple Inc.',
            exchange: 'NASDAQ',
            sector: 'Technology',
            industry: 'Consumer Electronics',
            description: 'Designs and sells consumer electronics.',
            sourceUrls: ['https://finance.yahoo.com/quote/AAPL'],
          },
        },
      ],
      {
        totalWeight: 1.6,
        validatedAt: '2026-07-27T00:00:00.000Z',
      },
    );

    expect(profile.symbol).toBe('AAPL');
    expect(profile.name).toBe('Apple Inc.');
    expect(profile.exchange).toBe('NASDAQ');
    expect(profile.resolvedAt).toBe('2026-07-27T00:00:00.000Z');
    expect(profile.notes).toEqual([]);
    expect(profile.confidence).toBeCloseTo(1);
  });

  it('handles a single-source profile and fills missing optional fields as null', () => {
    const profile = reconcile(
      [
        {
          source: { name: 'sec', weight: 0.9 },
          partial: {
            symbol: 'TSM',
            name: 'Taiwan Semiconductor Manufacturing Company Limited',
            exchange: 'NYSE',
            sourceUrls: ['https://www.sec.gov/example/tsm'],
          },
        },
      ],
      {
        totalWeight: 1.8,
        validatedAt: '2026-07-27T00:00:00.000Z',
      },
    );

    expect(profile.symbol).toBe('TSM');
    expect(profile.sector).toBeNull();
    expect(profile.industry).toBeNull();
    expect(profile.description).toBeNull();
    expect(profile.type).toBeNull();
    expect(profile.currency).toBeNull();
    expect(profile.country).toBeNull();
    expect(profile.cik).toBeNull();
    expect(profile.isin).toBeNull();
    expect(profile.cusip).toBeNull();
    expect(profile.website).toBeNull();
    expect(profile.logoUrl).toBeNull();
    // contributingWeight(0.9) / totalWeight(1.8) = 0.5, coverageScale=0.7
    expect(profile.confidence).toBeCloseTo(0.35);
  });

  it('throws when no source provides the required identity fields', () => {
    expect(() =>
      reconcile(
        [
          {
            source: { name: 'only-source', weight: 1 },
            partial: {
              symbol: 'AAPL',
              sourceUrls: ['https://example.com/aapl'],
            },
          },
        ],
        {
          totalWeight: 1,
          validatedAt: '2026-07-27T00:00:00.000Z',
        },
      ),
    ).toThrow(/missing required field/);
  });

  it('normalizes company suffixes before voting on name', () => {
    const profile = reconcile(
      [
        {
          source: { name: 'sec', weight: 0.8 },
          partial: {
            symbol: 'NVDA',
            name: 'NVIDIA Corp.',
            exchange: 'NASDAQ',
            sourceUrls: ['https://www.sec.gov/example/nvda'],
          },
        },
        {
          source: { name: 'yahoo', weight: 0.6 },
          partial: {
            symbol: 'NVDA',
            name: 'NVIDIA Corporation',
            exchange: 'NASDAQ',
            sourceUrls: ['https://finance.yahoo.com/quote/NVDA'],
          },
        },
      ],
      {
        totalWeight: 1.4,
        validatedAt: '2026-07-27T00:00:00.000Z',
      },
    );

    expect(profile.symbol).toBe('NVDA');
    expect(profile.name).toBe('NVIDIA Corp.');
    expect(profile.notes.some((note) => note.startsWith('name disagreement'))).toBe(false);
    expect(profile.sources).toEqual([
      {
        name: 'sec',
        url: 'https://www.sec.gov/example/nvda',
        confidence: 0.5714285714285715,
      },
      {
        name: 'yahoo',
        url: 'https://finance.yahoo.com/quote/NVDA',
        confidence: 0.4285714285714286,
      },
    ]);
  });

  it('records dispute notes while selecting highest-weight scalar values', () => {
    const profile = reconcile(
      [
        {
          source: { name: 'source-a', weight: 0.6 },
          partial: {
            symbol: 'MSFT',
            name: 'Microsoft Corporation',
            exchange: 'NASDAQ',
            sector: 'Technology',
            sourceUrls: ['https://example.com/a/msft'],
          },
        },
        {
          source: { name: 'source-b', weight: 0.4 },
          partial: {
            symbol: 'MSFT',
            name: 'Microsoft Corporation',
            exchange: 'NASDAQ',
            sector: 'Tech',
            sourceUrls: ['https://example.com/b/msft'],
          },
        },
      ],
      {
        totalWeight: 1,
        validatedAt: '2026-07-27T00:00:00.000Z',
        conflictThreshold: 0.55,
      },
    );

    expect(profile.sector).toBe('Technology');
    expect(profile.notes.some((note) => note.startsWith('sector disagreement'))).toBe(true);
    expect(profile.confidence).toBeCloseTo(0.8);
  });

  it('throws structured conflict errors when identity fields have no clear winner', () => {
    expect(() =>
      reconcile(
        [
          {
            source: { name: 'alpha', weight: 0.51 },
            partial: {
              symbol: 'AAPL',
              name: 'Apple Inc.',
              exchange: 'NASDAQ',
              sourceUrls: ['https://example.com/aapl'],
            },
          },
          {
            source: { name: 'beta', weight: 0.49 },
            partial: {
              symbol: 'MSFT',
              name: 'Microsoft Corporation',
              exchange: 'NASDAQ',
              sourceUrls: ['https://example.com/msft'],
            },
          },
        ],
        {
          totalWeight: 1,
          validatedAt: '2026-07-27T00:00:00.000Z',
          conflictThreshold: 0.8,
        },
      ),
    ).toThrowError(ReconcileConflictError);

    try {
      reconcile(
        [
          {
            source: { name: 'alpha', weight: 0.51 },
            partial: {
              symbol: 'AAPL',
              name: 'Apple Inc.',
              exchange: 'NASDAQ',
              sourceUrls: ['https://example.com/aapl'],
            },
          },
          {
            source: { name: 'beta', weight: 0.49 },
            partial: {
              symbol: 'MSFT',
              name: 'Microsoft Corporation',
              exchange: 'NASDAQ',
              sourceUrls: ['https://example.com/msft'],
            },
          },
        ],
        {
          totalWeight: 1,
          validatedAt: '2026-07-27T00:00:00.000Z',
          conflictThreshold: 0.8,
        },
      );
    } catch (error) {
      const err = error as ReconcileConflictError;
      expect(err.conflicts.some((conflict) => conflict.field === 'symbol')).toBe(true);
      expect(err.notes.length).toBeGreaterThan(0);
    }
  });
});
