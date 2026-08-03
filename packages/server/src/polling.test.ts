import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MarketDataClient, WatchlistEntry } from '@regardedtrader/core';
import { PollingCoordinator } from './polling.js';

function makeClient(overrides: Partial<MarketDataClient> = {}): MarketDataClient {
  return {
    quote: async (symbol: string) => ({
      symbol,
      price: 100,
      change: 1,
      changePercent: 1,
      volume: 1000,
      asOf: new Date().toISOString(),
    }),
    history: async () => [],
    news: async () => [],
    optionsChain: async () => [],
    ...overrides,
  };
}

describe('PollingCoordinator lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts quote polling only after watchlist symbols are present', async () => {
    vi.useFakeTimers();
    const watchlist = {
      list: vi.fn<() => Promise<WatchlistEntry[]>>().mockResolvedValue([]),
    };
    const client = makeClient({ quote: vi.fn(makeClient().quote) });
    const polling = new PollingCoordinator(watchlist, () => client, {
      quoteEveryMs: 1000,
      newsEveryMs: 1000,
    });

    polling.start();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(client.quote).not.toHaveBeenCalled();

    watchlist.list.mockResolvedValueOnce([
      {
        addedAt: new Date().toISOString(),
        profile: {
          symbol: 'AAPL',
          name: 'Apple Inc.',
          exchange: 'NASDAQ',
          sector: 'Technology',
          industry: 'Consumer Electronics',
          description: 'Test',
          sources: ['https://example.com'],
          validatedAt: new Date().toISOString(),
        },
      },
    ]);
    await polling.refreshSymbolsFromWatchlist();
    await vi.advanceTimersByTimeAsync(1);

    expect(client.quote).toHaveBeenCalled();
  });

  it('unregisters symbols and stops polling when watchlist is empty', async () => {
    vi.useFakeTimers();
    const watchlist = {
      list: async () => [] as WatchlistEntry[],
    };
    const quote = vi.fn(makeClient().quote);
    const client = makeClient({ quote });
    const polling = new PollingCoordinator(watchlist, () => client, {
      quoteEveryMs: 1000,
      newsEveryMs: 1000,
    });

    polling.start();
    polling.registerSymbol('AAPL');
    await vi.advanceTimersByTimeAsync(1_200);
    const before = quote.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    polling.unregisterSymbol('AAPL');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(quote.mock.calls.length).toBe(before);
  });

  it('waits up to timeout for in-flight jobs on graceful stop', async () => {
    vi.useFakeTimers();
    const watchlist = {
      list: async () => [] as WatchlistEntry[],
    };
    let resolveQuote: (() => void) | null = null;
    const quote = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<MarketDataClient['quote']>>>((resolve) => {
          resolveQuote = () =>
            resolve({
              symbol: 'AAPL',
              price: 100,
              change: 0,
              changePercent: 0,
              volume: 1,
              asOf: new Date().toISOString(),
            });
        }),
    );
    const client = makeClient({ quote });
    const polling = new PollingCoordinator(watchlist, () => client, {
      quoteEveryMs: 1000,
      newsEveryMs: 1000,
    });

    polling.start();
    polling.registerSymbol('AAPL');
    await vi.advanceTimersByTimeAsync(1);
    const stopPromise = polling.stopGracefully(50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(stopPromise).resolves.toBeUndefined();
  });
});
