import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WatchlistStore, DEFAULT_CONFIG } from '@regardedtrader/core';
import { createApp } from './app.js';
import type { YahooQuoteLike } from './liveQuote.js';

let dir: string;
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rt-livequote-'));
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  if (dir) await rm(dir, { recursive: true, force: true });
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

function baseConfig(): import('@regardedtrader/core').AppConfig {
  return DEFAULT_CONFIG;
}

describe('GET /tickers/:symbol/quote', () => {
  it('returns a Zod-validated live quote and coalesces with an in-memory cache', async () => {
    const source = vi.fn(async (_symbol: string): Promise<YahooQuoteLike> => ({
      symbol: 'NVDA',
      regularMarketPrice: 123.45,
      regularMarketChange: 1.23,
      regularMarketChangePercent: 1.01,
      currency: 'USD',
      marketState: 'REGULAR',
      regularMarketTime: new Date('2024-06-12T15:30:00Z'),
    }));
    let now = 1_000_000;
    const { app } = createApp({
      market: noopMarket(),
      webSearch: { async search() { return []; } },
      watchlist: new WatchlistStore({ path: join(dir, 'wl.json') }),
      initialConfig: baseConfig(),
      llmFromConfig: () => null,
      liveQuoteSource: source,
      now: () => now,
    });
    const url = await listen(app);

    const r1 = await fetch(`${url}/tickers/NVDA/quote`);
    expect(r1.status).toBe(200);
    const body = (await r1.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      symbol: 'NVDA',
      price: 123.45,
      change: 1.23,
      changePercent: 1.01,
      currency: 'USD',
      marketState: 'REGULAR',
    });
    expect(typeof body.asOf).toBe('string');

    // Second call within 5s of the first should be served from cache and
    // therefore not call the source again.
    now += 1_000;
    const r2 = await fetch(`${url}/tickers/NVDA/quote`);
    expect(r2.status).toBe(200);
    expect(source).toHaveBeenCalledTimes(1);

    // Advance past TTL — source should be hit again.
    now += 10_000;
    const r3 = await fetch(`${url}/tickers/NVDA/quote`);
    expect(r3.status).toBe(200);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('normalizes an unknown marketState to CLOSED', async () => {
    const source = vi.fn(async (_symbol: string): Promise<YahooQuoteLike> => ({
      regularMarketPrice: 10,
      regularMarketChange: 0,
      regularMarketChangePercent: 0,
      currency: 'USD',
      marketState: 'WEIRD',
      regularMarketTime: new Date(),
    }));
    const { app } = createApp({
      market: noopMarket(),
      webSearch: { async search() { return []; } },
      watchlist: new WatchlistStore({ path: join(dir, 'wl.json') }),
      initialConfig: baseConfig(),
      llmFromConfig: () => null,
      liveQuoteSource: source,
    });
    const url = await listen(app);
    const r = await fetch(`${url}/tickers/AAPL/quote`);
    const body = (await r.json()) as { marketState: string };
    expect(body.marketState).toBe('CLOSED');
  });
});
