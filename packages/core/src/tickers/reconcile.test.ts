import { describe, expect, it } from 'vitest';
import { ReconcileConflictError, reconcile } from './reconcile.js';

describe('tickers/reconcile', () => {
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
      'sec:https://www.sec.gov/example/nvda',
      'yahoo:https://finance.yahoo.com/quote/NVDA',
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
