import { describe, expect, it, vi } from 'vitest';
import { createApi, maskApiKey, HTTP_PRESETS, CLI_BACKENDS, MARKET_PROVIDER_PRESETS } from './api.js';
import type { AiProvider } from '@regardedtrader/core';

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('api client', () => {
  it('getConfig issues GET /api/config and returns parsed body', async () => {
    const f = fakeFetch((url) => {
      expect(url).toBe('/api/config');
      return jsonResponse({ version: 1, providers: {}, activeProvider: null });
    });
    const api = createApi({ fetchImpl: f });
    const cfg = await api.getConfig();
    expect(cfg.providers).toEqual({});
    expect(cfg.activeProvider).toBeNull();
  });

  it('upsertProvider POSTs id+provider as JSON', async () => {
    const provider: AiProvider = {
      kind: 'openai-compatible',
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-deadbeef',
    };
    const f = fakeFetch((url, init) => {
      expect(url).toBe('/api/config/providers');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ id: 'openai', provider });
      return jsonResponse({
        ok: true,
        aiConfigured: true,
        config: { version: 1, providers: { openai: provider }, activeProvider: 'openai' },
      });
    });
    const api = createApi({ fetchImpl: f });
    const r = await api.upsertProvider('openai', provider);
    expect(r.ok).toBe(true);
    expect(r.config.activeProvider).toBe('openai');
  });

  it('removeProvider DELETEs the encoded id', async () => {
    const f = fakeFetch((url, init) => {
      expect(url).toBe('/api/config/providers/my%20p');
      expect(init?.method).toBe('DELETE');
      return jsonResponse({
        ok: true,
        aiConfigured: false,
        config: { version: 1, providers: {}, activeProvider: null },
      });
    });
    const api = createApi({ fetchImpl: f });
    const r = await api.removeProvider('my p');
    expect(r.ok).toBe(true);
  });

  it('activateProvider POSTs the id', async () => {
    const f = fakeFetch((url, init) => {
      expect(url).toBe('/api/config/activate');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ id: 'local' });
      return jsonResponse({
        ok: true,
        aiConfigured: true,
        config: { version: 1, providers: {}, activeProvider: 'local' },
      });
    });
    const api = createApi({ fetchImpl: f });
    const r = await api.activateProvider('local');
    expect(r.config.activeProvider).toBe('local');
  });

  it('testActive POSTs the providerId and surfaces structured failures without throwing', async () => {
    const f = fakeFetch((url, init) => {
      expect(url).toBe('/api/config/test');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ providerId: 'openai' });
      return jsonResponse({
        ok: false,
        providerId: 'openai',
        error: { code: 'no_provider', message: 'No provider', hint: 'add one' },
      });
    });
    const api = createApi({ fetchImpl: f });
    const r = await api.testActive('openai');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('no_provider');
      expect(r.error.hint).toBe('add one');
    }
  });

  it('testActive returns the success payload with latencyMs + model', async () => {
    const f = fakeFetch((_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({});
      return jsonResponse({
        ok: true,
        latencyMs: 123,
        model: 'gpt-4o-mini',
        providerId: 'openai',
      });
    });
    const api = createApi({ fetchImpl: f });
    const r = await api.testActive();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.latencyMs).toBe(123);
      expect(r.model).toBe('gpt-4o-mini');
    }
  });

  it('throws with a server-provided error message on non-OK config responses', async () => {
    const f = fakeFetch(() =>
      jsonResponse({ error: 'provider "x" not found' }, { status: 404 }),
    );
    const api = createApi({ fetchImpl: f });
    await expect(api.activateProvider('x')).rejects.toThrow('provider "x" not found');
  });

  it('respects a custom base path', async () => {
    const f = fakeFetch((url) => {
      expect(url).toBe('http://127.0.0.1:4317/config');
      return jsonResponse({ version: 1, providers: {}, activeProvider: null });
    });
    const api = createApi({ fetchImpl: f, base: 'http://127.0.0.1:4317' });
    await api.getConfig();
  });
});

describe('maskApiKey', () => {
  it('returns empty string for missing keys', () => {
    expect(maskApiKey(undefined)).toBe('');
    expect(maskApiKey('')).toBe('');
  });

  it('returns a placeholder for short keys', () => {
    expect(maskApiKey('short')).toBe('••••');
    expect(maskApiKey('12345678')).toBe('••••');
  });

  it('shows the first and last four characters of a long key', () => {
    expect(maskApiKey('sk-1234abcd5678efgh')).toBe('sk-1••••efgh');
  });
});

describe('presets', () => {
  it('exposes the same HTTP presets as the CLI flow', () => {
    const ids = HTTP_PRESETS.map((p) => p.id);
    expect(ids).toEqual(['openai', 'groq', 'openrouter', 'ollama', 'custom']);
  });

  it('exposes the three supported CLI backends', () => {
    expect(CLI_BACKENDS.map((b) => b.id)).toEqual([
      'codex-cli',
      'claude-cli',
      'copilot-cli',
    ]);
  });

  it('exposes market-data presets with finnhub first', () => {
    expect(MARKET_PROVIDER_PRESETS.map((p) => p.kind)).toEqual(['finnhub', 'yahoo']);
  });
});

describe('market-data API methods', () => {
  it('POSTs to /config/market-data/providers when upserting', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const f: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), init });
      return new Response(
        JSON.stringify({ ok: true, activeMarketProvider: 'fin', config: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const api = createApi({ fetchImpl: f });
    const r = await api.upsertMarketProvider('fin', {
      kind: 'finnhub',
      label: 'Finnhub',
      apiKey: 'k',
      baseUrl: 'https://finnhub.io/api/v1',
    });
    expect(r.activeMarketProvider).toBe('fin');
    expect(seen[0]?.url).toContain('/config/market-data/providers');
    expect(seen[0]?.init?.method).toBe('POST');
  });

  it('returns a structured error when testMarketProvider fails', async () => {
    const f: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false, error: 'No market-data provider configured' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    const api = createApi({ fetchImpl: f });
    const r = await api.testMarketProvider();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No market-data provider/);
  });
});
