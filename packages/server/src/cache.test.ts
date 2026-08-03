import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { DEFAULT_CONFIG, SQLiteCache, WatchlistStore } from '@regardedtrader/core';
import { createApp } from './app.js';

let server: Server | null = null;

async function listen(handler: import('express').Express): Promise<string> {
  return new Promise((resolve) => {
    const s = handler.listen(0, '127.0.0.1', () => {
      const addr = s.address() as AddressInfo;
      server = s;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

function noopMarket(): import('@regardedtrader/core').MarketDataClient {
  return {
    quote: async () => ({
      symbol: 'X',
      price: 0,
      change: 0,
      changePercent: 0,
      volume: 0,
      asOf: new Date().toISOString(),
    }),
    history: async () => [],
    news: async () => [],
    optionsChain: async () => [],
  };
}

describe('cache endpoints', () => {
  it('clears cache entries via POST /cache/clear', async () => {
    const cache = new SQLiteCache({
      dbPath: ':memory:',
      namespaceTtls: { quotes: 30_000, history: 300_000, chain: 60_000, news: 300_000 },
    });
    await cache.set('quotes', 'NVDA', { price: 123 });
    const { app } = createApp({
      market: noopMarket(),
      cache,
      webSearch: { async search() { return []; } },
      watchlist: new WatchlistStore(),
      initialConfig: DEFAULT_CONFIG,
      llmFromConfig: () => null,
    });
    const url = await listen(app);
    const res = await fetch(`${url}/cache/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deleted: number };
    expect(json.deleted).toBeGreaterThan(0);
    await expect(cache.get('quotes', 'NVDA')).resolves.toBeUndefined();
    await cache.close();
  });

  it('updates cache.enabled via POST /config/cache', async () => {
    const cache = new SQLiteCache({
      dbPath: ':memory:',
      namespaceTtls: { quotes: 30_000, history: 300_000, chain: 60_000, news: 300_000 },
      enabled: true,
    });
    const { app } = createApp({
      market: noopMarket(),
      cache,
      webSearch: { async search() { return []; } },
      watchlist: new WatchlistStore(),
      initialConfig: DEFAULT_CONFIG,
      llmFromConfig: () => null,
    });
    const url = await listen(app);
    const res = await fetch(`${url}/config/cache`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { config: { cache: { enabled: boolean } } };
    expect(json.config.cache.enabled).toBe(false);
    expect(cache.isEnabled()).toBe(false);
    await cache.close();
  });
});
