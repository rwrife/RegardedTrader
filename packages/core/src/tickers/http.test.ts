import { describe, it, expect } from 'vitest';
import { PoliteFetchClient, DEFAULT_USER_AGENT, type FetchLike } from './http.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function makeStubFetch(
  responder: (call: Call, attempt: number) => Response | Promise<Response>,
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: Call = { url, init };
    calls.push(call);
    return responder(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

function ok(body = '{}', init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init });
}

function recordingSleep(): { sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { sleep, sleeps };
}

describe('PoliteFetchClient.fetch', () => {
  it('sends our User-Agent and strips Cookie headers', async () => {
    const { fetchImpl, calls } = makeStubFetch(() => ok());
    const c = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });

    await c.fetch('https://example.com/x', {
      headers: { Cookie: 'evil=1', 'X-Foo': 'bar' },
    });

    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init!.headers as Headers;
    expect(headers.get('User-Agent')).toBe(DEFAULT_USER_AGENT);
    expect(headers.get('Cookie')).toBeNull();
    expect(headers.get('X-Foo')).toBe('bar');
  });

  it('rejects non-http(s) URLs', async () => {
    const c = new PoliteFetchClient({ fetchImpl: async () => ok() });
    await expect(c.fetch('ftp://example.com')).rejects.toThrow(/unsupported protocol/);
  });

  it('retries on 429 with backoff and eventually succeeds', async () => {
    let attempt = 0;
    const { fetchImpl, calls } = makeStubFetch(() => {
      attempt++;
      if (attempt < 3) return new Response('rate', { status: 429 });
      return ok('done');
    });
    const { sleep, sleeps } = recordingSleep();
    const c = new PoliteFetchClient({
      fetchImpl,
      sleep,
      random: () => 0,
      defaultRatePerSec: 1000,
    });

    const resp = await c.fetch('https://example.com/r', { backoffBaseMs: 10 });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('done');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual(expect.arrayContaining([10, 20]));
  });

  it('returns the final response after maxRetries on persistent 5xx', async () => {
    const { fetchImpl, calls } = makeStubFetch(() => new Response('boom', { status: 503 }));
    const c = new PoliteFetchClient({
      fetchImpl,
      sleep: async () => {},
      random: () => 0,
      defaultRatePerSec: 1000,
    });

    const resp = await c.fetch('https://example.com/x', { maxRetries: 3, backoffBaseMs: 1 });
    expect(resp.status).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it('does not retry on non-retryable 4xx', async () => {
    const { fetchImpl, calls } = makeStubFetch(() => new Response('nope', { status: 404 }));
    const c = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const resp = await c.fetch('https://example.com/x');
    expect(resp.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it('aborts on hard timeout', async () => {
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        sig?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const c = new PoliteFetchClient({
      fetchImpl,
      sleep: async () => {},
      random: () => 0,
      defaultRatePerSec: 1000,
    });
    await expect(
      c.fetch('https://example.com/slow', { timeoutMs: 5, maxRetries: 1, backoffBaseMs: 1 }),
    ).rejects.toThrow();
  });

  it('refuses cross-origin redirect to non-https', async () => {
    const { fetchImpl } = makeStubFetch(({ url }) => {
      if (url.startsWith('https://example.com')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://evil.example/' },
        });
      }
      return ok();
    });
    const c = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    await expect(c.fetch('https://example.com/start')).rejects.toThrow(/cross-origin/);
  });

  it('follows same-host redirects under https', async () => {
    const { fetchImpl, calls } = makeStubFetch(({ url }) => {
      if (url === 'https://example.com/a') {
        return new Response(null, {
          status: 301,
          headers: { location: '/b' },
        });
      }
      return ok('landed');
    });
    const c = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const resp = await c.fetch('https://example.com/a');
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('landed');
    expect(calls.map((c) => c.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
  });
});

describe('PoliteFetchClient rate limiting', () => {
  it('per-host token bucket sleeps when burst is exhausted', async () => {
    let nowMs = 0;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    };
    const { fetchImpl } = makeStubFetch(() => ok());
    const c = new PoliteFetchClient({
      fetchImpl,
      sleep,
      now: () => nowMs,
      defaultRatePerSec: 2,
      burst: 2,
    });

    await c.fetch('https://a.example/');
    await c.fetch('https://a.example/');
    await c.fetch('https://a.example/');

    const waits = sleeps.filter((ms) => ms > 0);
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0]).toBe(500);
  });

  it('honors per-host rate overrides', async () => {
    let nowMs = 0;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    };
    const { fetchImpl } = makeStubFetch(() => ok());
    const c = new PoliteFetchClient({
      fetchImpl,
      sleep,
      now: () => nowMs,
      defaultRatePerSec: 4,
      perHostRatePerSec: { 'slow.example': 1 },
    });
    await c.fetch('https://slow.example/');
    await c.fetch('https://slow.example/');
    const waits = sleeps.filter((ms) => ms > 0);
    expect(waits[0]).toBe(1000);
  });

  it('separate hosts do not share buckets', async () => {
    let nowMs = 0;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    };
    const { fetchImpl } = makeStubFetch(() => ok());
    const c = new PoliteFetchClient({
      fetchImpl,
      sleep,
      now: () => nowMs,
      defaultRatePerSec: 1,
      burst: 1,
    });
    await c.fetch('https://a.example/');
    await c.fetch('https://b.example/');
    const waits = sleeps.filter((ms) => ms > 0);
    expect(waits).toEqual([]);
  });
});
