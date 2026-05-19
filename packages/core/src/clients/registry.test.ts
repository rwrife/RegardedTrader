import { describe, it, expect, vi } from 'vitest';
import { createMarketDataRegistry } from './registry.js';
import { FinnhubCapabilityError } from './finnhub.js';
import type { MarketDataClient } from './index.js';
import type { MarketDataConfig } from '../schemas/marketData.js';

function fakeClient(overrides: Partial<MarketDataClient> = {}): MarketDataClient {
  return {
    quote: async (s) => ({
      symbol: s,
      price: 1,
      change: 0,
      changePercent: 0,
      volume: 0,
      asOf: new Date().toISOString(),
    }),
    history: async () => [],
    news: async () => [],
    optionsChain: async () => [],
    ...overrides,
  };
}

describe('createMarketDataRegistry', () => {
  it('returns the fallback client when no provider is active', () => {
    const fallback = fakeClient({ quote: vi.fn(fakeClient().quote) });
    const cfg: MarketDataConfig = { providers: {}, activeProvider: null };
    const reg = createMarketDataRegistry(cfg, { fallback });
    expect(reg.client).toBe(fallback);
    expect(reg.activeId).toBeNull();
    expect(reg.liveQuoteSource).toBeNull();
  });

  it('uses the active provider for quotes and exposes its id', async () => {
    const finnhub = fakeClient({ quote: vi.fn(async (s) => ({
      symbol: s,
      price: 42,
      change: 0,
      changePercent: 0,
      volume: 0,
      asOf: new Date().toISOString(),
    })) });
    const cfg: MarketDataConfig = {
      providers: { fin: { kind: 'finnhub', label: 'Finnhub', apiKey: 'k', baseUrl: 'https://x' } },
      activeProvider: 'fin',
    };
    const reg = createMarketDataRegistry(cfg, {
      fallback: fakeClient(),
      buildClient: () => finnhub,
    });
    expect(reg.activeId).toBe('fin');
    const q = await reg.client.quote('AAPL');
    expect(q.price).toBe(42);
  });

  it('does NOT fall back to the secondary on FinnhubCapabilityError — surfaces it', async () => {
    const primary = fakeClient({
      history: vi.fn(async () => {
        throw new FinnhubCapabilityError('history');
      }),
    });
    const fallback = fakeClient({
      history: vi.fn(async () => [
        { t: '2024-01-01', o: 1, h: 2, l: 0.5, c: 1.5, v: 100 },
      ]),
    });
    const cfg: MarketDataConfig = {
      providers: { fin: { kind: 'finnhub', label: 'Finnhub', apiKey: 'k', baseUrl: 'https://x' } },
      activeProvider: 'fin',
    };
    const reg = createMarketDataRegistry(cfg, { fallback, buildClient: () => primary });
    await expect(reg.client.history('AAPL', 30)).rejects.toBeInstanceOf(FinnhubCapabilityError);
    expect(fallback.history).not.toHaveBeenCalled();
  });

  it('does NOT swallow non-capability errors from the primary', async () => {
    const primary = fakeClient({
      news: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const fallback = fakeClient({ news: vi.fn(async () => []) });
    const cfg: MarketDataConfig = {
      providers: { fin: { kind: 'finnhub', label: 'Finnhub', apiKey: 'k', baseUrl: 'https://x' } },
      activeProvider: 'fin',
    };
    const reg = createMarketDataRegistry(cfg, { fallback, buildClient: () => primary });
    await expect(reg.client.news('AAPL')).rejects.toThrow('boom');
    expect(fallback.news).not.toHaveBeenCalled();
  });
});
