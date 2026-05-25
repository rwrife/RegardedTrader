import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WatchlistStore, type LLM, type WebSearch } from '@regardedtrader/core';
import { createApp } from './app.js';

function fakeWebSearch(): WebSearch {
  return {
    async search() {
      return [
        {
          title: 'NVIDIA Corporation (NVDA)',
          url: 'https://example.com/nvda',
          snippet: 'NVIDIA designs GPUs. NASDAQ.',
        },
      ];
    },
  };
}

function fakeLLM(payload: object): LLM {
  return {
    async complete() {
      return JSON.stringify(payload);
    },
  };
}

const goodReply = {
  match: true,
  profile: {
    symbol: 'NVDA',
    name: 'NVIDIA Corporation',
    exchange: 'NASDAQ',
    sector: 'Technology',
    industry: 'Semiconductors',
    description: 'Designs GPUs and AI chips.',
  },
};

let dir: string;
let server: Server | null = null;
let baseUrl = '';

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
  dir = await mkdtemp(join(tmpdir(), 'rt-server-'));
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('POST /tickers/validate', () => {
  it('validates a symbol, persists it, and returns cached on a second call', async () => {
    const watchlist = new WatchlistStore({ path: join(dir, 'watchlist.json') });
    const { app } = createApp({
      market: {
        quote: async () => ({ symbol: 'NVDA', price: 0, change: 0, changePercent: 0, volume: 0, asOf: '' }),
        history: async () => [],
        news: async () => [],
        optionsChain: async () => [],
      },
      webSearch: fakeWebSearch(),
      watchlist,
      initialConfig: {
        version: 1,
        providers: { fake: { kind: 'openai-compatible', label: 'fake', baseUrl: 'http://x/v1', model: 'm' } },
        activeProvider: 'fake',
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
      },
      llmFromConfig: () => fakeLLM(goodReply),
    });
    baseUrl = await listen(app);

    const r1 = await fetch(`${baseUrl}/tickers/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbols: ['nvda'] }),
    });
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { results: Array<{ ok: boolean; cached?: boolean; profile?: { symbol: string } }> };
    expect(j1.results[0]?.ok).toBe(true);
    expect(j1.results[0]?.cached).toBe(false);
    expect(j1.results[0]?.profile?.symbol).toBe('NVDA');

    const r2 = await fetch(`${baseUrl}/tickers/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbols: ['NVDA'] }),
    });
    const j2 = (await r2.json()) as { results: Array<{ cached?: boolean }> };
    expect(j2.results[0]?.cached).toBe(true);

    const list = await fetch(`${baseUrl}/tickers`);
    const lj = (await list.json()) as { entries: Array<{ profile: { symbol: string } }> };
    expect(lj.entries.map((e) => e.profile.symbol)).toEqual(['NVDA']);

    const del = await fetch(`${baseUrl}/tickers/NVDA`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await (await fetch(`${baseUrl}/tickers`)).json() as { entries: unknown[] }).entries).toEqual([]);
  });

  it('briefing refuses unknown symbols with 422', async () => {
    const watchlist = new WatchlistStore({ path: join(dir, 'watchlist.json') });
    const { app } = createApp({
      market: {
        quote: async () => ({ symbol: 'NVDA', price: 0, change: 0, changePercent: 0, volume: 0, asOf: '' }),
        history: async () => [],
        news: async () => [],
        optionsChain: async () => [],
      },
      webSearch: fakeWebSearch(),
      watchlist,
      initialConfig: {
        version: 1,
        providers: { fake: { kind: 'openai-compatible', label: 'fake', baseUrl: 'http://x/v1', model: 'm' } },
        activeProvider: 'fake',
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
      },
      llmFromConfig: () => fakeLLM(goodReply),
    });
    baseUrl = await listen(app);
    const r = await fetch(`${baseUrl}/briefing/NVDA`);
    expect(r.status).toBe(422);
    const j = (await r.json()) as { error: string };
    expect(j.error).toMatch(/regard add NVDA/);
  });

  it('returns 503 when AI is not configured', async () => {
    const watchlist = new WatchlistStore({ path: join(dir, 'watchlist.json') });
    const { app } = createApp({
      market: {
        quote: async () => ({ symbol: 'NVDA', price: 0, change: 0, changePercent: 0, volume: 0, asOf: '' }),
        history: async () => [],
        news: async () => [],
        optionsChain: async () => [],
      },
      webSearch: fakeWebSearch(),
      watchlist,
      initialConfig: {
        version: 1,
        providers: {},
        activeProvider: null,
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
      },
      llmFromConfig: () => null,
    });
    baseUrl = await listen(app);
    const r = await fetch(`${baseUrl}/tickers/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbols: ['NVDA'] }),
    });
    expect(r.status).toBe(503);
  });
});

describe('POST /config/test', () => {
  const baseProvider = {
    kind: 'openai-compatible' as const,
    label: 'fake',
    baseUrl: 'http://x/v1',
    model: 'gpt-fake',
    apiKey: 'sk-secret-1234',
  };

  async function makeServer(opts: {
    providers?: Record<string, import('@regardedtrader/core').AiProvider>;
    active?: string | null;
    buildLLM?: (p: import('@regardedtrader/core').AiProvider) => LLM;
  }) {
    const watchlist = new WatchlistStore({ path: join(dir, 'watchlist.json') });
    const { app } = createApp({
      market: {
        quote: async () => ({ symbol: '', price: 0, change: 0, changePercent: 0, volume: 0, asOf: '' }),
        history: async () => [],
        news: async () => [],
        optionsChain: async () => [],
      },
      webSearch: fakeWebSearch(),
      watchlist,
      initialConfig: {
        version: 1,
        providers: opts.providers ?? {},
        activeProvider: opts.active ?? null,
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
      },
      llmFromConfig: () => fakeLLM(goodReply),
      buildLLMForProvider: opts.buildLLM,
    });
    baseUrl = await listen(app);
  }

  async function postTest(body: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${baseUrl}/config/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it('returns ok=true with latencyMs and model for the active provider', async () => {
    await makeServer({
      providers: { p1: baseProvider },
      active: 'p1',
      buildLLM: () => ({ async complete() { return 'OK'; } }),
    });
    const { status, json } = await postTest({});
    expect(status).toBe(200);
    const r = json as { ok: true; latencyMs: number; model: string; providerId: string };
    expect(r.ok).toBe(true);
    expect(r.providerId).toBe('p1');
    expect(r.model).toBe('gpt-fake');
    expect(typeof r.latencyMs).toBe('number');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('honors an explicit providerId distinct from the active one', async () => {
    await makeServer({
      providers: {
        p1: baseProvider,
        p2: { ...baseProvider, model: 'other-model' },
      },
      active: 'p1',
      buildLLM: (p) => ({ async complete() { return p.kind === 'openai-compatible' ? p.model : 'OK'; } }),
    });
    const { json } = await postTest({ providerId: 'p2' });
    const r = json as { ok: true; providerId: string; model: string };
    expect(r.ok).toBe(true);
    expect(r.providerId).toBe('p2');
    expect(r.model).toBe('other-model');
  });

  it('returns ok=false code=no_provider when no providerId and no active', async () => {
    await makeServer({});
    const { json } = await postTest({});
    const r = json as { ok: false; error: { code: string } };
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('no_provider');
  });

  it('returns ok=false code=unknown_provider for missing ids', async () => {
    await makeServer({ providers: { p1: baseProvider }, active: 'p1' });
    const { json } = await postTest({ providerId: 'nope' });
    const r = json as { ok: false; providerId: string; error: { code: string } };
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('unknown_provider');
    expect(r.providerId).toBe('nope');
  });

  it('returns ok=false code=empty_response when provider returns blank', async () => {
    await makeServer({
      providers: { p1: baseProvider },
      active: 'p1',
      buildLLM: () => ({ async complete() { return '   '; } }),
    });
    const { json } = await postTest({});
    const r = json as { ok: false; error: { code: string } };
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('empty_response');
  });

  it('returns ok=false code=provider_error and never leaks the API key', async () => {
    await makeServer({
      providers: { p1: baseProvider },
      active: 'p1',
      buildLLM: () => ({ async complete() { throw new Error('401 from server: bad key sk-secret-1234'); } }),
    });
    const { json } = await postTest({});
    const r = json as { ok: false; error: { code: string; message: string } };
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('provider_error');
    expect(r.error.message).not.toContain('sk-secret-1234');
    expect(r.error.message).toContain('***');
  });
});
