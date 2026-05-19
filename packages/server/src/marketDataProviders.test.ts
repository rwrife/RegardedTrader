/**
 * Server-side tests for the pluggable market-data provider endpoints (#91).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WatchlistStore, DEFAULT_CONFIG } from '@regardedtrader/core';
import { createApp } from './app.js';

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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rt-md-providers-'));
  // Make config writes go somewhere ephemeral so the test doesn't clobber
  // the developer's real ~/.regardedtrader/config.json.
  process.env.REGARDEDTRADER_HOME = dir;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  delete process.env.REGARDEDTRADER_HOME;
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('/config/market-data', () => {
  it('round-trips upsert → activate → delete and redacts the api key', async () => {
    const { app } = createApp({
      market: noopMarket(),
      webSearch: { async search() { return []; } },
      watchlist: new WatchlistStore({ path: join(dir, 'wl.json') }),
      initialConfig: DEFAULT_CONFIG,
      llmFromConfig: () => null,
    });
    const url = await listen(app);

    // Upsert: adding the first provider should auto-activate it.
    const up = await fetch(`${url}/config/market-data/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'fin',
        provider: {
          kind: 'finnhub',
          label: 'Finnhub',
          apiKey: 'sk-supersecret-12345',
          baseUrl: 'https://finnhub.io/api/v1',
        },
      }),
    });
    expect(up.status).toBe(200);
    const upBody = (await up.json()) as {
      activeMarketProvider: string;
      config: { marketData: { providers: Record<string, { apiKey?: string }> } };
    };
    expect(upBody.activeMarketProvider).toBe('fin');
    // Redaction: the api key should be masked, not echoed back in full.
    const echoed = upBody.config.marketData.providers.fin?.apiKey;
    expect(echoed).toBeDefined();
    expect(echoed).not.toBe('sk-supersecret-12345');
    expect(echoed).toMatch(/••••/);

    // Deactivate by passing null.
    const deact = await fetch(`${url}/config/market-data/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: null }),
    });
    expect(deact.status).toBe(200);
    expect(((await deact.json()) as { activeMarketProvider: string | null }).activeMarketProvider).toBeNull();

    // Activating an unknown id should 404, not crash.
    const bad = await fetch(`${url}/config/market-data/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'nope' }),
    });
    expect(bad.status).toBe(404);

    // Delete the provider.
    const del = await fetch(`${url}/config/market-data/providers/fin`, { method: 'DELETE' });
    expect(del.status).toBe(200);
  });

  it('GET /tickers/:symbol/quote returns 503 with a helpful hint when no provider is configured', async () => {
    const { app } = createApp({
      market: noopMarket(),
      webSearch: { async search() { return []; } },
      watchlist: new WatchlistStore({ path: join(dir, 'wl.json') }),
      initialConfig: DEFAULT_CONFIG,
      llmFromConfig: () => null,
      // Intentionally no liveQuoteSource and no marketData provider in cfg.
    });
    const url = await listen(app);
    const r = await fetch(`${url}/tickers/AAPL/quote`);
    expect(r.status).toBe(503);
    const body = (await r.json()) as { error: string; hint?: string };
    expect(body.error).toMatch(/no market-data provider/i);
    expect(body.hint).toMatch(/Settings/);
  });
});
