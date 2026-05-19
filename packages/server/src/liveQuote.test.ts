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

  it('serves the last cached value when the upstream throws (e.g. Yahoo 429)', async () => {
    let n = 0;
    const source = vi.fn(async (_symbol: string): Promise<YahooQuoteLike> => {
      n += 1;
      if (n === 1) {
        return {
          symbol: 'AAPL',
          regularMarketPrice: 200,
          regularMarketChange: 1,
          regularMarketChangePercent: 0.5,
          currency: 'USD',
          marketState: 'REGULAR',
          regularMarketTime: new Date('2024-06-12T15:30:00Z'),
        };
      }
      throw new Error(
        'invalid json response body ... reason: Unexpected token \'T\', "Too Many Requests',
      );
    });
    let now = 2_000_000;
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

    // Prime the cache with a successful first call.
    const r1 = await fetch(`${url}/tickers/AAPL/quote`);
    expect(r1.status).toBe(200);

    // Advance past the 5s coalescing TTL so the next request actually hits
    // the source (which is now configured to throw).
    now += 10_000;
    const r2 = await fetch(`${url}/tickers/AAPL/quote`);
    if (r2.status !== 200) {
      const txt = await r2.text();
      throw new Error(`expected 200, got ${r2.status}: ${txt}`);
    }
    expect(r2.status).toBe(200);
    expect(r2.headers.get('x-quote-stale')).toBe('1');
    const body = (await r2.json()) as { symbol: string; price: number };
    expect(body.symbol).toBe('AAPL');
    expect(body.price).toBe(200);
  });

  it('dedupes concurrent in-flight requests for the same symbol', async () => {
    let pending: ((v: YahooQuoteLike) => void) | null = null;
    const source = vi.fn(
      (_symbol: string): Promise<YahooQuoteLike> =>
        new Promise<YahooQuoteLike>((resolve) => {
          pending = resolve;
        }),
    );
    const { app } = createApp({
      market: noopMarket(),
      webSearch: { async search() { return []; } },
      watchlist: new WatchlistStore({ path: join(dir, 'wl.json') }),
      initialConfig: baseConfig(),
      llmFromConfig: () => null,
      liveQuoteSource: source,
    });
    const url = await listen(app);

    const p1 = fetch(`${url}/tickers/MSFT/quote`);
    const p2 = fetch(`${url}/tickers/MSFT/quote`);
    // Give Express a tick to dispatch both handlers.
    await new Promise((r) => setTimeout(r, 25));
    expect(source).toHaveBeenCalledTimes(1);
    pending!({
      symbol: 'MSFT',
      regularMarketPrice: 300,
      regularMarketChange: 0,
      regularMarketChangePercent: 0,
      currency: 'USD',
      marketState: 'REGULAR',
      regularMarketTime: new Date('2024-06-12T15:30:00Z'),
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
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

  it('includes a computed rating derived from changePercent and volumeRatio', async () => {
    const source = vi.fn(async (_symbol: string): Promise<YahooQuoteLike> => ({
      symbol: 'GME',
      regularMarketPrice: 50,
      regularMarketChange: 12,
      regularMarketChangePercent: 25, // big rip
      regularMarketVolume: 30_000_000,
      averageDailyVolume10Day: 5_000_000, // 6× avg
      currency: 'USD',
      marketState: 'REGULAR',
      regularMarketTime: new Date('2024-06-12T15:30:00Z'),
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
    const r = await fetch(`${url}/tickers/GME/quote`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      rating?: { rating: string; score: number; reasons: string[]; symbol: string };
    };
    expect(body.rating).toBeDefined();
    expect(body.rating!.symbol).toBe('GME');
    expect(body.rating!.rating).toBe('YOLO');
    expect(body.rating!.score).toBeGreaterThanOrEqual(85);
    expect(body.rating!.reasons.some((s) => s.includes('25.0% today'))).toBe(true);
    expect(body.rating!.reasons.some((s) => s.includes('6.0× avg volume'))).toBe(
      true,
    );
  });
});
