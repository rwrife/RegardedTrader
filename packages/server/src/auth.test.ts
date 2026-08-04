import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WatchlistStore, type WebSearch, type LLM } from '@regardedtrader/core';
import { createApp } from './app.js';
import { parseRuntimeAuth } from './runtimeAuth.js';

function fakeWebSearch(): WebSearch {
  return {
    async search() {
      return [];
    },
  };
}

function fakeLLM(): LLM {
  return {
    async complete() {
      return '{}';
    },
  };
}

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
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

describe('parseRuntimeAuth', () => {
  it('throws when token is missing and allow-no-auth is not set', () => {
    expect(() => parseRuntimeAuth({ argv: [], env: {} })).toThrow(
      /Run via `regard dashboard`/,
    );
  });

  it('supports unauthenticated dev mode with --allow-no-auth', () => {
    expect(parseRuntimeAuth({ argv: ['--allow-no-auth'], env: {} })).toEqual({
      mode: 'allow-no-auth',
    });
  });

  it('reads token from env and defaults origin', () => {
    expect(
      parseRuntimeAuth({
        argv: [],
        env: { REGARDEDTRADER_AUTH_TOKEN: 'tok-1' },
      }),
    ).toEqual({
      mode: 'required',
      token: 'tok-1',
      dashboardOrigin: 'http://127.0.0.1:5173',
    });
  });
});

describe('runtime auth middleware', () => {
  async function startAuthedApp() {
    const { app } = createApp({
      market: {
        quote: async () => ({
          symbol: 'NVDA',
          price: 0,
          change: 0,
          changePercent: 0,
          volume: 0,
          asOf: '',
        }),
        history: async () => [],
        news: async () => [],
        optionsChain: async () => [],
      },
      webSearch: fakeWebSearch(),
      watchlist: new WatchlistStore(),
      initialConfig: {
        version: 1,
        providers: { fake: { kind: 'openai-compatible', label: 'fake', baseUrl: 'http://x/v1', model: 'm' } },
        activeProvider: 'fake',
        risk: {
          maxLossUsd: 500,
          maxLegs: 4,
          forbidNakedShorts: true,
          maxDte: 45,
          accountSizeUsd: 0,
          maxPctOfAccount: 0.02,
        },
        server: { host: '127.0.0.1', port: 4317 },
        marketData: { providers: {}, activeProvider: null },
        polling: { sentimentSources: { reddit: { enabled: true, weight: 1 }, stocktwits: { enabled: true, weight: 0.7 }, hn: { enabled: true, weight: 0.4 }, cnn: { enabled: true, weight: 1.2 }, 'google-news': { enabled: true, weight: 1.1 }, googleNewsOpinion: { enabled: true, weight: 0.9 } } },
      },
      llmFromConfig: () => fakeLLM(),
      auth: {
        mode: 'required',
        token: 'dashboard-token',
        dashboardOrigin: 'http://127.0.0.1:5173',
      },
    });
    return listen(app);
  }

  it('allows GET /health without auth, requires token for other routes', async () => {
    const baseUrl = await startAuthedApp();

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);

    const blocked = await fetch(`${baseUrl}/version`);
    expect(blocked.status).toBe(401);

    const headerOk = await fetch(`${baseUrl}/version`, {
      headers: { Authorization: 'Bearer dashboard-token' },
    });
    expect(headerOk.status).toBe(200);

    const queryOk = await fetch(`${baseUrl}/version?t=dashboard-token`);
    expect(queryOk.status).toBe(200);

    const corsOk = await fetch(`${baseUrl}/version?t=dashboard-token`, {
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    expect(corsOk.headers.get('access-control-allow-origin')).toBe(
      'http://127.0.0.1:5173',
    );
  });

  it('rate-limits repeated failed auth attempts', async () => {
    const baseUrl = await startAuthedApp();
    let lastStatus = 0;
    for (let i = 0; i < 21; i++) {
      const r = await fetch(`${baseUrl}/version`);
      lastStatus = r.status;
    }
    expect(lastStatus).toBe(429);
  });
});
