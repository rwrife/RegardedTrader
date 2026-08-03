import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  BriefingStore,
  MentionStore,
  WatchlistStore,
  PaperStore,
  type BriefingStorePort,
  type LLM,
  type TradePlan,
  type WebSearch,
} from '@regardedtrader/core';
import { createApp } from './app.js';
import { SERVER_VERSION } from './version.js';

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

const noMatchReply = {
  match: false,
  reason: 'Could not confidently map this symbol to a tradable US equity.',
  suggestions: [{ symbol: 'NVDA', name: 'NVIDIA Corporation' }],
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
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
        polling: { sentimentSources: { reddit: { enabled: true, weight: 1 }, stocktwits: { enabled: true, weight: 0.7 }, hn: { enabled: true, weight: 0.4 }, cnn: { enabled: true, weight: 1.2 }, 'google-news': { enabled: true, weight: 1.1 }, googleNewsOpinion: { enabled: true, weight: 0.9 } } },
      },
      llmFromConfig: () => fakeLLM(goodReply),
    });

    describe('paper orders API', () => {
      const plan: TradePlan = {
        name: 'Long call',
        thesis: 'Upside continuation',
        legs: [
          {
            action: 'buy',
            qty: 1,
            contract: {
              symbol: 'NVDA260918C00125000',
              underlying: 'NVDA',
              expiry: '2026-09-18',
              strike: 125,
              type: 'call',
              bid: 5,
              ask: 5.4,
              last: 5.2,
              volume: 100,
              openInterest: 500,
              iv: 0.42,
            },
          },
        ],
        maxLoss: 540,
        maxGain: null,
        breakEvens: [130.4],
      };

      async function boot(): Promise<void> {
        const watchlist = new WatchlistStore({ path: join(dir, 'watchlist.json') });
        const { app } = createApp({
          market: {
            quote: async () => ({ symbol: 'NVDA', price: 131, change: 0, changePercent: 0, volume: 0, asOf: '' }),
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
            risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
            server: { host: '127.0.0.1', port: 4317 },
            marketData: { providers: {}, activeProvider: null },
          },
          llmFromConfig: () => null,
          paperStore: new PaperStore({ homeDir: dir }),
        });
        baseUrl = await listen(app);
      }

      it('rejects submits when paper !== true', async () => {
        await boot();
        const r = await fetch(`${baseUrl}/paper/orders`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paper: false, planId: 'plan-1', plan }),
        });
        expect(r.status).toBe(400);
        expect((await r.json()) as { error: string }).toMatchObject({
          error: 'Paper mode must be explicitly enabled (paper=true).',
        });
      });

      it('submits a paper order and lists orders + positions', async () => {
        await boot();
        const submit = await fetch(`${baseUrl}/paper/orders`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paper: true, planId: 'plan-2', plan }),
        });
        expect(submit.status).toBe(200);
        const fill = (await submit.json()) as { planId: string; symbol: string; netPremiumUsd: number };
        expect(fill.planId).toBe('plan-2');
        expect(fill.symbol).toBe('NVDA');
        expect(fill.netPremiumUsd).toBe(520);

        const orders = await fetch(`${baseUrl}/paper/orders`);
        expect(orders.status).toBe(200);
        const o = (await orders.json()) as { orders: Array<{ planId: string }> };
        expect(o.orders.map((x) => x.planId)).toEqual(['plan-2']);

        const positions = await fetch(`${baseUrl}/paper/positions`);
        expect(positions.status).toBe(200);
        const p = (await positions.json()) as { positions: Array<{ planId: string }> };
        expect(p.positions.map((x) => x.planId)).toEqual(['plan-2']);
      });
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

  it('GET /tickers/resolve resolves without persisting, and POST /tickers persists', async () => {
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
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
        polling: { sentimentSources: { reddit: { enabled: true, weight: 1 }, stocktwits: { enabled: true, weight: 0.7 }, hn: { enabled: true, weight: 0.4 }, cnn: { enabled: true, weight: 1.2 }, 'google-news': { enabled: true, weight: 1.1 }, googleNewsOpinion: { enabled: true, weight: 0.9 } } },
      },
      llmFromConfig: () => fakeLLM(goodReply),
    });
    baseUrl = await listen(app);

    const resolveRes = await fetch(`${baseUrl}/tickers/resolve?q=${encodeURIComponent('nvidia')}`);
    expect(resolveRes.status).toBe(200);
    const resolved = (await resolveRes.json()) as { symbol: string; name: string };
    expect(resolved.symbol).toBe('NVDA');
    expect(resolved.name).toMatch(/NVIDIA/i);

    const beforePersist = (await (await fetch(`${baseUrl}/tickers`)).json() as { entries: unknown[] }).entries;
    expect(beforePersist).toEqual([]);

    const addRes = await fetch(`${baseUrl}/tickers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'nvidia' }),
    });
    expect(addRes.status).toBe(200);
    const added = (await addRes.json()) as { ok: boolean; profile?: { symbol: string } };
    expect(added.ok).toBe(true);
    expect(added.profile?.symbol).toBe('NVDA');

    const afterPersist = await fetch(`${baseUrl}/tickers`);
    const list = (await afterPersist.json()) as { entries: Array<{ profile: { symbol: string } }> };
    expect(list.entries.map((e) => e.profile.symbol)).toEqual(['NVDA']);
  });

  it('GET /tickers/resolve and POST /tickers return 404 when no match is found', async () => {
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
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
        polling: { sentimentSources: { reddit: { enabled: true, weight: 1 }, stocktwits: { enabled: true, weight: 0.7 }, hn: { enabled: true, weight: 0.4 }, cnn: { enabled: true, weight: 1.2 }, 'google-news': { enabled: true, weight: 1.1 }, googleNewsOpinion: { enabled: true, weight: 0.9 } } },
      },
      llmFromConfig: () => fakeLLM(noMatchReply),
    });
    baseUrl = await listen(app);

    const resolveRes = await fetch(`${baseUrl}/tickers/resolve?q=${encodeURIComponent('ZZZZ')}`);
    expect(resolveRes.status).toBe(404);

    const addRes = await fetch(`${baseUrl}/tickers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: 'ZZZZ' }),
    });
    expect(addRes.status).toBe(404);
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
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
        polling: { sentimentSources: { reddit: { enabled: true, weight: 1 }, stocktwits: { enabled: true, weight: 0.7 }, hn: { enabled: true, weight: 0.4 }, cnn: { enabled: true, weight: 1.2 }, 'google-news': { enabled: true, weight: 1.1 }, googleNewsOpinion: { enabled: true, weight: 0.9 } } },
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
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
        polling: { sentimentSources: { reddit: { enabled: true, weight: 1 }, stocktwits: { enabled: true, weight: 0.7 }, hn: { enabled: true, weight: 0.4 }, cnn: { enabled: true, weight: 1.2 }, 'google-news': { enabled: true, weight: 1.1 }, googleNewsOpinion: { enabled: true, weight: 0.9 } } },
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

describe('Sentiment routes + SSE (#39)', () => {
  const nowIso = '2026-07-01T15:00:00.000Z';
  let prevToken: string | undefined;

  beforeEach(() => {
    prevToken = process.env.REGARDEDTRADER_AUTH_TOKEN;
    process.env.REGARDEDTRADER_AUTH_TOKEN = 'dash-token-39';
  });
  afterEach(() => {
    if (prevToken === undefined) delete process.env.REGARDEDTRADER_AUTH_TOKEN;
    else process.env.REGARDEDTRADER_AUTH_TOKEN = prevToken;
  });

  async function makeSentimentApp() {
    const watchlist = new WatchlistStore({ path: join(dir, 'watchlist.json') });
    const mentions = new MentionStore({ root: join(dir, 'snapshots') });
    await mentions.appendScoredMention({
      source: 'reddit',
      sourceId: 'r1',
      symbol: 'NVDA',
      url: 'https://example.com/reddit/r1',
      title: 'Bullish flow',
      text: 'Strong demand setup',
      publishedAt: '2026-07-01T14:30:00.000Z',
      fetchedAt: '2026-07-01T14:31:00.000Z',
      sentiment: { score: 0.7, confidence: 0.8, label: 'bullish' },
      scoredAt: '2026-07-01T14:31:30.000Z',
    });
    await mentions.appendSentiment({
      symbol: 'NVDA',
      asOf: nowIso,
      score: 0.52,
      confidence: 0.76,
      volume: 11,
      bySource: {
        reddit: { score: 0.7, confidence: 0.8, volume: 5 },
        'google-news': { score: 0.3, confidence: 0.7, volume: 6 },
      },
    });
    return createApp({
      market: {
        quote: async () => ({ symbol: 'NVDA', price: 0, change: 0, changePercent: 0, volume: 0, asOf: '' }),
        history: async () => [],
        news: async () => [],
        optionsChain: async () => [],
      },
      webSearch: fakeWebSearch(),
      watchlist,
      mentions,
      initialConfig: {
        version: 1,
        providers: {},
        activeProvider: null,
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
        polling: { sentimentSources: { reddit: { enabled: true, weight: 1 }, stocktwits: { enabled: true, weight: 0.7 }, hn: { enabled: true, weight: 0.4 }, cnn: { enabled: true, weight: 1.2 }, 'google-news': { enabled: true, weight: 1.1 }, googleNewsOpinion: { enabled: true, weight: 0.9 } } },
      },
      llmFromConfig: () => null,
    });
  }

  it('requires dashboard auth token on sentiment/mentions endpoints', async () => {
    const { app } = await makeSentimentApp();
    baseUrl = await listen(app);

    const denied = await fetch(`${baseUrl}/sentiment/NVDA/latest`);
    expect(denied.status).toBe(401);

    const allowed = await fetch(`${baseUrl}/sentiment/NVDA/latest?t=dash-token-39`);
    expect(allowed.status).toBe(200);
  });

  it('serves latest and ranged sentiment snapshots plus mention filtering', async () => {
    const { app } = await makeSentimentApp();
    baseUrl = await listen(app);

    const latest = await fetch(`${baseUrl}/sentiment/NVDA/latest`, {
      headers: { Authorization: 'Bearer dash-token-39' },
    });
    expect(latest.status).toBe(200);
    const latestJson = (await latest.json()) as { symbol: string; score: number; volume: number };
    expect(latestJson.symbol).toBe('NVDA');
    expect(latestJson.score).toBeCloseTo(0.52);
    expect(latestJson.volume).toBe(11);

    const ranged = await fetch(
      `${baseUrl}/sentiment/NVDA?since=2026-07-01T14:00:00.000Z&until=2026-07-01T16:00:00.000Z`,
      { headers: { Authorization: 'dash-token-39' } },
    );
    expect(ranged.status).toBe(200);
    const rangedJson = (await ranged.json()) as { items: Array<{ asOf: string }> };
    expect(rangedJson.items).toHaveLength(1);
    expect(rangedJson.items[0]?.asOf).toBe(nowIso);

    const mentions = await fetch(
      `${baseUrl}/mentions/NVDA?source=reddit&limit=5&since=2026-07-01T14:00:00.000Z`,
      { headers: { Authorization: 'dash-token-39' } },
    );
    expect(mentions.status).toBe(200);
    const mentionsJson = (await mentions.json()) as { items: Array<{ source: string }> };
    expect(mentionsJson.items.length).toBeGreaterThan(0);
    expect(mentionsJson.items.every((x) => x.source === 'reddit')).toBe(true);
  });

  it('streams sentiment.update events over SSE and exposes source health in /health', async () => {
    const { app, emitSentimentUpdate } = await makeSentimentApp();
    baseUrl = await listen(app);
    const ac = new AbortController();
    const sse = await fetch(`${baseUrl}/events?t=dash-token-39`, { signal: ac.signal });
    expect(sse.status).toBe(200);

    emitSentimentUpdate('NVDA', {
      symbol: 'NVDA',
      asOf: '2026-07-01T16:00:00.000Z',
      score: 0.6,
      confidence: 0.8,
      volume: 12,
      bySource: {},
    });

    const reader = sse.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let text = '';
    const started = Date.now();
    while (Date.now() - started < 1500 && !text.includes('event: sentiment.update')) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    expect(text).toContain('event: sentiment.update');
    expect(text).toContain('"symbol":"NVDA"');
    ac.abort();

    const m = await fetch(`${baseUrl}/mentions/NVDA?source=reddit`, {
      headers: { Authorization: 'dash-token-39' },
    });
    expect(m.status).toBe(200);
    const health = await fetch(`${baseUrl}/health`);
    const healthJson = (await health.json()) as {
      sentimentSources: { reddit: { lastSuccess: string | null; lastError: string | null } };
    };
    expect(healthJson.sentimentSources.reddit.lastSuccess).toBeTruthy();
    expect(healthJson.sentimentSources.reddit.lastError).toBeNull();
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
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
        polling: { sentimentSources: { reddit: { enabled: true, weight: 1 }, stocktwits: { enabled: true, weight: 0.7 }, hn: { enabled: true, weight: 0.4 }, cnn: { enabled: true, weight: 1.2 }, 'google-news': { enabled: true, weight: 1.1 }, googleNewsOpinion: { enabled: true, weight: 0.9 } } },
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

describe('GET /version (#179)', () => {
  function makeMinimalApp() {
    return createApp({
      market: {
        quote: async () => ({ symbol: 'X', price: 0, change: 0, changePercent: 0, volume: 0, asOf: '' }),
        history: async () => [],
        news: async () => [],
        optionsChain: async () => [],
      },
      webSearch: fakeWebSearch(),
      watchlist: new WatchlistStore({ path: join(dir, 'watchlist.json') }),
      initialConfig: {
        version: 1,
        providers: {},
        activeProvider: null,
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
        polling: { sentimentSources: { reddit: { enabled: true, weight: 1 }, stocktwits: { enabled: true, weight: 0.7 }, hn: { enabled: true, weight: 0.4 }, cnn: { enabled: true, weight: 1.2 }, 'google-news': { enabled: true, weight: 1.1 }, googleNewsOpinion: { enabled: true, weight: 0.9 } } },
      },
      llmFromConfig: () => null,
    });
  }

  it('returns a Zod-shaped payload sourced from package.json', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, '..', 'package.json');
    const pkgRaw = await readFile(pkgPath, 'utf8');
    const pkgVersion = (JSON.parse(pkgRaw) as { version: string }).version;

    const { app } = makeMinimalApp();
    baseUrl = await listen(app);
    const r = await fetch(`${baseUrl}/version`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      server: string;
      core: string;
      node: string;
      api: number;
      startedAt: string;
    };
    expect(j.server).toBe(pkgVersion);
    expect(typeof j.core).toBe('string');
    expect(j.core.length).toBeGreaterThan(0);
    expect(j.node).toBe(process.versions.node);
    expect(Number.isInteger(j.api)).toBe(true);
    expect(j.api).toBeGreaterThanOrEqual(0);
    // ISO-8601 timestamp
    expect(() => new Date(j.startedAt).toISOString()).not.toThrow();
    expect(new Date(j.startedAt).toISOString()).toBe(j.startedAt);
  });

  it('reports a stable startedAt across calls to the same app', async () => {
    const { app } = makeMinimalApp();
    baseUrl = await listen(app);
    const a = (await (await fetch(`${baseUrl}/version`)).json()) as { startedAt: string };
    const b = (await (await fetch(`${baseUrl}/version`)).json()) as { startedAt: string };
    expect(a.startedAt).toBe(b.startedAt);
  });
});

describe('GET /health (#180)', () => {
  function makeMinimalApp() {
    return createApp({
      market: {
        quote: async () => ({ symbol: 'X', price: 0, change: 0, changePercent: 0, volume: 0, asOf: '' }),
        history: async () => [],
        news: async () => [],
        optionsChain: async () => [],
      },
      webSearch: fakeWebSearch(),
      watchlist: new WatchlistStore({ path: join(dir, 'watchlist.json') }),
      initialConfig: {
        version: 1,
        providers: {},
        activeProvider: null,
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
        polling: { sentimentSources: { reddit: { enabled: true, weight: 1 }, stocktwits: { enabled: true, weight: 0.7 }, hn: { enabled: true, weight: 0.4 }, cnn: { enabled: true, weight: 1.2 }, 'google-news': { enabled: true, weight: 1.1 }, googleNewsOpinion: { enabled: true, weight: 0.9 } } },
      },
      llmFromConfig: () => null,
    });
  }

  it('reports the version from packages/server/package.json, not a hardcoded literal', async () => {
    // Cross-check /health.version against the actual package.json on disk
    // so a future bump of either the code or package.json without the
    // other is caught by CI.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, '..', 'package.json');
    const pkgRaw = await readFile(pkgPath, 'utf8');
    const pkgVersion = (JSON.parse(pkgRaw) as { version: string }).version;
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+/);

    // Cached module-load value must match what package.json currently says.
    expect(SERVER_VERSION).toBe(pkgVersion);

    const { app } = makeMinimalApp();
    baseUrl = await listen(app);
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      ok: boolean;
      name: string;
      version: string;
      aiConfigured: boolean;
      activeProvider: string | null;
    };
    expect(j.version).toBe(pkgVersion);
    // The other keys must be untouched (issue #180 is a pure fix, not a
    // schema change).
    expect(j.ok).toBe(true);
    expect(j.name).toBe('regardedtrader-server');
    expect(j.aiConfigured).toBe(false);
    expect(j.activeProvider).toBeNull();
  });
});

describe('Origin loopback guard (#128)', () => {
  function makeMinimalApp() {
    return createApp({
      market: {
        quote: async () => ({ symbol: 'X', price: 0, change: 0, changePercent: 0, volume: 0, asOf: '' }),
        history: async () => [],
        news: async () => [],
        optionsChain: async () => [],
      },
      webSearch: fakeWebSearch(),
      watchlist: new WatchlistStore({ path: join(dir, 'watchlist.json') }),
      initialConfig: {
        version: 1,
        providers: {},
        activeProvider: null,
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
        polling: { sentimentSources: { reddit: { enabled: true, weight: 1 }, stocktwits: { enabled: true, weight: 0.7 }, hn: { enabled: true, weight: 0.4 }, cnn: { enabled: true, weight: 1.2 }, 'google-news': { enabled: true, weight: 1.1 }, googleNewsOpinion: { enabled: true, weight: 0.9 } } },
      },
      llmFromConfig: () => null,
    });
  }

  it('allows requests with no Origin header', async () => {
    const { app } = makeMinimalApp();
    baseUrl = await listen(app);
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
  });

  it('allows loopback Origin', async () => {
    const { app } = makeMinimalApp();
    baseUrl = await listen(app);
    const r = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    expect(r.status).toBe(200);
  });

  it('rejects non-loopback Origin with 403', async () => {
    const { app } = makeMinimalApp();
    baseUrl = await listen(app);
    const r = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'http://evil.com' },
    });
    expect(r.status).toBe(403);
    const j = (await r.json()) as { error: string };
    expect(j.error).toMatch(/Non-loopback Origin/);
  });

  it('rejects 0.0.0.0 Origin with 403', async () => {
    const { app } = makeMinimalApp();
    baseUrl = await listen(app);
    const r = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'http://0.0.0.0:3000' },
    });
    expect(r.status).toBe(403);
  });
});

describe('POST /briefing/:symbol (#138)', () => {
  async function makeBriefingApp(opts?: {
    briefings?: BriefingStorePort;
  }): Promise<void> {
    const watchlist = new WatchlistStore({ path: join(dir, 'watchlist.json') });
    const briefings = opts?.briefings ?? new BriefingStore({ root: join(dir, 'briefings') });
    // Pre-seed NVDA so requireKnownSymbol succeeds without going through the
    // validator (which would also hit our fake LLM).
    await watchlist.upsert({
      symbol: 'NVDA',
      name: 'NVIDIA Corporation',
      exchange: 'NASDAQ',
      sector: 'Technology',
      industry: 'Semiconductors',
      description: 'GPUs.',
      sources: ['https://example.com/nvda'],
      validatedAt: new Date().toISOString(),
    });
    const { app } = createApp({
      market: {
        quote: async () => ({ symbol: 'NVDA', price: 100, change: 0, changePercent: 0, volume: 0, asOf: new Date().toISOString() }),
        history: async () => [],
        news: async () => [],
        optionsChain: async () => [],
      },
      webSearch: fakeWebSearch(),
      watchlist,
      briefings,
      initialConfig: {
        version: 1,
        providers: { fake: { kind: 'openai-compatible', label: 'fake', baseUrl: 'http://x/v1', model: 'm' } },
        activeProvider: 'fake',
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
        polling: { sentimentSources: { reddit: { enabled: true, weight: 1 }, stocktwits: { enabled: true, weight: 0.7 }, hn: { enabled: true, weight: 0.4 }, cnn: { enabled: true, weight: 1.2 }, 'google-news': { enabled: true, weight: 1.1 }, googleNewsOpinion: { enabled: true, weight: 0.9 } } },
      },
      // Analyst tolerates missing fields, strategist returns []; both safe.
      llmFromConfig: () => fakeLLM({ bullCase: 'b', bearCase: 'b', catalysts: [], risks: [], plans: [] }),
    });
    baseUrl = await listen(app);
  }

  it('analyst-only path: empty body returns a Briefing without strategist', async () => {
    await makeBriefingApp();
    const r = await fetch(`${baseUrl}/briefing/NVDA`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { symbol: string; strategist?: unknown };
    expect(j.symbol).toBe('NVDA');
    expect(j.strategist).toBeUndefined();
  });

  it('full-strategist path: thesis+maxLossUsd populates strategist section', async () => {
    await makeBriefingApp();
    const r = await fetch(`${baseUrl}/briefing/NVDA`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thesis: 'bullish into earnings', maxLossUsd: 500 }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { strategist?: { thesis: string; candidates: unknown[] } };
    expect(j.strategist).toBeDefined();
    expect(j.strategist?.thesis).toBe('bullish into earnings');
    expect(Array.isArray(j.strategist?.candidates)).toBe(true);
  });

  it('rejects invalid body (unknown field) with 400', async () => {
    await makeBriefingApp();
    const r = await fetch(`${baseUrl}/briefing/NVDA`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thesis: 'x', maxLossUsd: 500, sneaky: true }),
    });
    expect(r.status).toBe(400);
  });

  it('rejects unknown symbol with 422', async () => {
    await makeBriefingApp();
    const r = await fetch(`${baseUrl}/briefing/TSLA`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(422);
  });

  it('persists briefing history and can fetch by id', async () => {
    await makeBriefingApp();
    const created = await fetch(`${baseUrl}/briefing/NVDA`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thesis: 'bullish into earnings', maxLossUsd: 500 }),
    });
    expect(created.status).toBe(200);

    const history = await fetch(`${baseUrl}/briefing/NVDA/history?limit=5`);
    expect(history.status).toBe(200);
    const historyJson = (await history.json()) as {
      symbol: string;
      items: Array<{ id: string }>;
    };
    expect(historyJson.symbol).toBe('NVDA');
    expect(historyJson.items.length).toBeGreaterThan(0);

    const item = historyJson.items[0];
    expect(item?.id).toContain('NVDA__');
    const byId = await fetch(`${baseUrl}/briefing/${encodeURIComponent(item!.id)}`);
    expect(byId.status).toBe(200);
    const briefing = (await byId.json()) as { symbol: string; strategist?: { thesis: string } };
    expect(briefing.symbol).toBe('NVDA');
    expect(briefing.strategist?.thesis).toBe('bullish into earnings');
  });

  it('returns briefing even if persistence fails (best-effort writes)', async () => {
    await makeBriefingApp({
      briefings: {
        async saveBriefing() {
          throw new Error('disk full');
        },
        async listBriefings() {
          return [];
        },
        async getBriefing() {
          return null;
        },
      },
    });
    const r = await fetch(`${baseUrl}/briefing/NVDA`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { symbol: string };
    expect(j.symbol).toBe('NVDA');
  });
});

describe('POST /config/risk', () => {
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.REGARDEDTRADER_HOME;
    process.env.REGARDEDTRADER_HOME = dir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.REGARDEDTRADER_HOME;
    else process.env.REGARDEDTRADER_HOME = prevHome;
  });

  async function makeApp(): Promise<{ baseUrl: string }> {
    const watchlist = new WatchlistStore({ path: join(dir, 'watchlist.json') });
    const { app } = createApp({
      market: {
        quote: async () => ({ symbol: 'X', price: 0, change: 0, changePercent: 0, volume: 0, asOf: '' }),
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
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
        polling: { sentimentSources: { reddit: { enabled: true, weight: 1 }, stocktwits: { enabled: true, weight: 0.7 }, hn: { enabled: true, weight: 0.4 }, cnn: { enabled: true, weight: 1.2 }, 'google-news': { enabled: true, weight: 1.1 }, googleNewsOpinion: { enabled: true, weight: 0.9 } } },
      },
      llmFromConfig: () => fakeLLM(goodReply),
    });
    return { baseUrl: await listen(app) };
  }

  it('updates risk caps and reflects them in GET /config', async () => {
    const { baseUrl } = await makeApp();
    const r = await fetch(`${baseUrl}/config/risk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxLossUsd: 250, maxLegs: 2, forbidNakedShorts: false }),
    });
    expect(r.status).toBe(200);
    type RiskJson = {
      maxLossUsd: number;
      maxLegs: number;
      forbidNakedShorts: boolean;
      maxDte: number;
      accountSizeUsd: number;
      maxPctOfAccount: number;
    };
    const body = (await r.json()) as { ok: boolean; config: { risk: RiskJson } };
    expect(body.ok).toBe(true);
    // Zod fills in defaults for #181 fields when the client omits them, so
    // existing web/CLI callers that only send the legacy three fields keep
    // working. New fields land with their schema defaults.
    expect(body.config.risk).toEqual({
      maxLossUsd: 250,
      maxLegs: 2,
      forbidNakedShorts: false,
      maxDte: 45,
      accountSizeUsd: 0,
      maxPctOfAccount: 0.02,
    });

    const cur = await fetch(`${baseUrl}/config`);
    const curJson = (await cur.json()) as { risk: RiskJson };
    expect(curJson.risk).toEqual({
      maxLossUsd: 250,
      maxLegs: 2,
      forbidNakedShorts: false,
      maxDte: 45,
      accountSizeUsd: 0,
      maxPctOfAccount: 0.02,
    });
  });

  it('accepts the full #181 shape and persists new fields', async () => {
    const { baseUrl } = await makeApp();
    const r = await fetch(`${baseUrl}/config/risk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        maxLossUsd: 300,
        maxLegs: 4,
        forbidNakedShorts: true,
        maxDte: 30,
        accountSizeUsd: 25_000,
        maxPctOfAccount: 0.01,
      }),
    });
    expect(r.status).toBe(200);
    const cur = await fetch(`${baseUrl}/config`);
    const curJson = (await cur.json()) as {
      risk: { maxDte: number; accountSizeUsd: number; maxPctOfAccount: number };
    };
    expect(curJson.risk.maxDte).toBe(30);
    expect(curJson.risk.accountSizeUsd).toBe(25_000);
    expect(curJson.risk.maxPctOfAccount).toBeCloseTo(0.01);
  });

  it('rejects invalid risk caps with 400', async () => {
    const { baseUrl } = await makeApp();
    const r = await fetch(`${baseUrl}/config/risk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxLossUsd: -1, maxLegs: 0, forbidNakedShorts: 'no' }),
    });
    expect(r.status).toBe(400);
  });
});

describe('Config routes coverage (#105)', () => {
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.REGARDEDTRADER_HOME;
    process.env.REGARDEDTRADER_HOME = dir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.REGARDEDTRADER_HOME;
    else process.env.REGARDEDTRADER_HOME = prevHome;
  });

  async function makeConfigApp(opts?: {
    providers?: Record<string, import('@regardedtrader/core').AiProvider>;
    activeProvider?: string | null;
    marketProviders?: Record<string, import('@regardedtrader/core').MarketDataProviderConfig>;
    activeMarketProvider?: string | null;
  }): Promise<{ baseUrl: string }> {
    const watchlist = new WatchlistStore({ path: join(dir, 'watchlist.json') });
    const { app } = createApp({
      market: {
        quote: async (symbol) => ({ symbol, price: 0, change: 0, changePercent: 0, volume: 0, asOf: new Date().toISOString() }),
        history: async () => [],
        news: async () => [],
        optionsChain: async () => [],
      },
      webSearch: fakeWebSearch(),
      watchlist,
      initialConfig: {
        version: 1,
        providers: opts?.providers ?? {},
        activeProvider: opts?.activeProvider ?? null,
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: {
          providers: opts?.marketProviders ?? {},
          activeProvider: opts?.activeMarketProvider ?? null,
        },
        polling: {
          sentimentSources: {
            reddit: { enabled: true, weight: 1 },
            stocktwits: { enabled: true, weight: 0.7 },
            hn: { enabled: true, weight: 0.4 },
            cnn: { enabled: true, weight: 1.2 },
            'google-news': { enabled: true, weight: 1.1 }, googleNewsOpinion: { enabled: true, weight: 0.9 },
          },
        },
      },
      llmFromConfig: () => fakeLLM(goodReply),
      buildLLMForProvider: (provider) => ({
        async complete() {
          if (provider.kind === 'openai-compatible') return provider.model;
          return provider.model ?? 'cli-model';
        },
      }),
    });
    return { baseUrl: await listen(app) };
  }

  it('GET /config masks provider keys (AI + market data) and never returns plaintext keys', async () => {
    const aiKey = 'sk-test-1234567890';
    const mdKey = 'fh-test-abcdefghij';
    const { baseUrl } = await makeConfigApp({
      providers: {
        openai: {
          kind: 'openai-compatible',
          label: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: aiKey,
          model: 'gpt-5-mini',
        },
      },
      activeProvider: 'openai',
      marketProviders: {
        finnhub: {
          kind: 'finnhub',
          label: 'Finnhub',
          apiKey: mdKey,
          baseUrl: 'https://finnhub.io/api/v1',
        },
      },
      activeMarketProvider: 'finnhub',
    });

    const current = (await (await fetch(`${baseUrl}/config`)).json()) as Record<string, unknown>;
    const withToken = {
      ...current,
      polling: {
        sentimentSources: {
          ...((current.polling as { sentimentSources: Record<string, unknown> }).sentimentSources ?? {}),
          reddit: {
            ...(((current.polling as { sentimentSources: Record<string, unknown> }).sentimentSources?.reddit ??
              {}) as Record<string, unknown>),
            apiToken: 'rdt-secret-12345',
          },
        },
      },
    };
    const put = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(withToken),
    });
    expect(put.status).toBe(200);

    const r = await fetch(`${baseUrl}/config`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      providers: Record<string, { apiKey?: string }>;
      marketData: { providers: Record<string, { apiKey?: string }> };
      polling: {
        sentimentSources: {
          reddit: { apiToken?: string };
        };
      };
    };

    expect(j.providers.openai?.apiKey).toBeDefined();
    expect(j.providers.openai?.apiKey).not.toBe(aiKey);
    expect(j.providers.openai?.apiKey).toContain('••••');
    expect(j.marketData.providers.finnhub?.apiKey).toBeDefined();
    expect(j.marketData.providers.finnhub?.apiKey).not.toBe(mdKey);
    expect(j.marketData.providers.finnhub?.apiKey).toContain('••••');
    expect(j.polling.sentimentSources.reddit.apiToken).toBeDefined();
    expect(j.polling.sentimentSources.reddit.apiToken).toContain('••••');

    const raw = JSON.stringify(j);
    expect(raw).not.toContain(aiKey);
    expect(raw).not.toContain(mdKey);
    expect(raw).not.toContain('rdt-secret-12345');
  });

  it('POST /config/providers supports happy path and rejects invalid payloads', async () => {
    const { baseUrl } = await makeConfigApp();

    const ok = await fetch(`${baseUrl}/config/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'openai',
        provider: {
          kind: 'openai-compatible',
          label: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-in-test-1234',
          model: 'gpt-5-mini',
        },
      }),
    });
    expect(ok.status).toBe(200);
    const okJson = (await ok.json()) as {
      ok: boolean;
      config: { providers: Record<string, { apiKey?: string }>; activeProvider: string | null };
    };
    expect(okJson.ok).toBe(true);
    expect(okJson.config.activeProvider).toBe('openai');
    expect(okJson.config.providers.openai?.apiKey).toContain('••••');

    const bad = await fetch(`${baseUrl}/config/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'broken', provider: { kind: 'openai-compatible' } }),
    });
    expect(bad.status).toBe(400);
  });

  it('DELETE /config/providers returns 200 for existing and 404 for missing ids', async () => {
    const { baseUrl } = await makeConfigApp({
      providers: {
        openai: {
          kind: 'openai-compatible',
          label: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-in-test-1234',
          model: 'gpt-5-mini',
        },
      },
      activeProvider: 'openai',
    });

    const delExisting = await fetch(`${baseUrl}/config/providers/openai`, { method: 'DELETE' });
    expect(delExisting.status).toBe(200);
    const j1 = (await delExisting.json()) as { config: { activeProvider: string | null; providers: Record<string, unknown> } };
    expect(j1.config.activeProvider).toBeNull();
    expect(Object.keys(j1.config.providers)).toEqual([]);

    const delMissing = await fetch(`${baseUrl}/config/providers/does-not-exist`, { method: 'DELETE' });
    expect(delMissing.status).toBe(404);
  });

  it('POST /config/activate hot-swaps the active provider without restart', async () => {
    const { baseUrl } = await makeConfigApp({
      providers: {
        p1: {
          kind: 'openai-compatible',
          label: 'Provider 1',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-provider-1-1234',
          model: 'model-one',
        },
        p2: {
          kind: 'openai-compatible',
          label: 'Provider 2',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-provider-2-5678',
          model: 'model-two',
        },
      },
      activeProvider: 'p1',
    });

    const before = await fetch(`${baseUrl}/config/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const beforeJson = (await before.json()) as { ok: boolean; providerId?: string; model?: string };
    expect(beforeJson.ok).toBe(true);
    expect(beforeJson.providerId).toBe('p1');
    expect(beforeJson.model).toBe('model-one');

    const activate = await fetch(`${baseUrl}/config/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'p2' }),
    });
    expect(activate.status).toBe(200);

    const after = await fetch(`${baseUrl}/config/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const afterJson = (await after.json()) as { ok: boolean; providerId?: string; model?: string };
    expect(afterJson.ok).toBe(true);
    expect(afterJson.providerId).toBe('p2');
    expect(afterJson.model).toBe('model-two');
  });

  it('supports mirrored /config/market-data provider add/activate/delete flows', async () => {
    const { baseUrl } = await makeConfigApp();

    const addYahoo = await fetch(`${baseUrl}/config/market-data/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'yahoo',
        provider: { kind: 'yahoo', label: 'Yahoo Finance' },
      }),
    });
    expect(addYahoo.status).toBe(200);

    const addFinnhub = await fetch(`${baseUrl}/config/market-data/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'finnhub',
        provider: {
          kind: 'finnhub',
          label: 'Finnhub',
          apiKey: 'fh-in-test-123456',
          baseUrl: 'https://finnhub.io/api/v1',
        },
      }),
    });
    expect(addFinnhub.status).toBe(200);

    const badAdd = await fetch(`${baseUrl}/config/market-data/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'broken', provider: { label: 'missing-kind' } }),
    });
    expect(badAdd.status).toBe(400);

    const activate = await fetch(`${baseUrl}/config/market-data/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'finnhub' }),
    });
    expect(activate.status).toBe(200);
    const activateJson = (await activate.json()) as { activeMarketProvider: string | null };
    expect(activateJson.activeMarketProvider).toBe('finnhub');

    const activateMissing = await fetch(`${baseUrl}/config/market-data/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'does-not-exist' }),
    });
    expect(activateMissing.status).toBe(404);

    const delExisting = await fetch(`${baseUrl}/config/market-data/providers/finnhub`, { method: 'DELETE' });
    expect(delExisting.status).toBe(200);

    const delMissing = await fetch(`${baseUrl}/config/market-data/providers/does-not-exist`, { method: 'DELETE' });
    expect(delMissing.status).toBe(404);
  });

  it('PUT /config rejects non-loopback server.host values', async () => {
    const { baseUrl } = await makeConfigApp();

    const badHost = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        providers: {},
        activeProvider: null,
        risk: {
          maxLossUsd: 500,
          maxLegs: 4,
          forbidNakedShorts: true,
          maxDte: 45,
          accountSizeUsd: 0,
          maxPctOfAccount: 0.02,
        },
        server: { host: '0.0.0.0', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
        polling: { sentimentSources: { reddit: { enabled: true, weight: 1 }, stocktwits: { enabled: true, weight: 0.7 }, hn: { enabled: true, weight: 0.4 }, cnn: { enabled: true, weight: 1.2 }, 'google-news': { enabled: true, weight: 1.1 }, googleNewsOpinion: { enabled: true, weight: 0.9 } } },
      }),
    });
    expect(badHost.status).toBe(400);
  });
});



