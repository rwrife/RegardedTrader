import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WatchlistStore, type LLM, type WebSearch } from '@regardedtrader/core';
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
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
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
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
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
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
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
  async function makeBriefingApp(): Promise<void> {
    const watchlist = new WatchlistStore({ path: join(dir, 'watchlist.json') });
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
      initialConfig: {
        version: 1,
        providers: { fake: { kind: 'openai-compatible', label: 'fake', baseUrl: 'http://x/v1', model: 'm' } },
        activeProvider: 'fake',
        risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true, maxDte: 45, accountSizeUsd: 0, maxPctOfAccount: 0.02 },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
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
