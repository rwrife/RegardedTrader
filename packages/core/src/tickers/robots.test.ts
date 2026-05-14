import { describe, it, expect } from 'vitest';
import { RobotsCache, parseRobots, type RobotsCacheOptions } from './robots.js';
import type { FetchLike } from './http.js';

function stub(map: Record<string, { status: number; body?: string }>): FetchLike {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const m = map[url];
    if (!m) return new Response('', { status: 404 });
    return new Response(m.body ?? '', { status: m.status });
  };
}

function mkCache(fetchImpl: FetchLike, extra: Partial<RobotsCacheOptions> = {}): RobotsCache {
  return new RobotsCache({ fetchImpl, ttlMs: 60_000, now: () => 0, ...extra });
}

describe('parseRobots', () => {
  it('parses basic groups', () => {
    const groups = parseRobots(`
User-agent: *
Disallow: /private/
Allow: /private/ok

User-agent: BadBot
Disallow: /
    `);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.agents).toEqual(['*']);
    expect(groups[0]!.rules).toEqual([
      { type: 'disallow', path: '/private/' },
      { type: 'allow', path: '/private/ok' },
    ]);
    expect(groups[1]!.agents).toEqual(['badbot']);
  });

  it('treats empty Disallow as allow-all (no rule)', () => {
    const groups = parseRobots(`User-agent: *\nDisallow:\n`);
    expect(groups[0]!.rules).toEqual([]);
  });
});

describe('RobotsCache.isAllowed', () => {
  it('returns true when robots.txt is missing (404)', async () => {
    const fetchImpl = stub({});
    const cache = mkCache(fetchImpl);
    expect(await cache.isAllowed('https://x.example/foo')).toBe(true);
  });

  it('disallows matching paths and allows others', async () => {
    const fetchImpl = stub({
      'https://x.example/robots.txt': {
        status: 200,
        body: 'User-agent: *\nDisallow: /private\n',
      },
    });
    const cache = mkCache(fetchImpl);
    expect(await cache.isAllowed('https://x.example/private/secret')).toBe(false);
    expect(await cache.isAllowed('https://x.example/public/page')).toBe(true);
  });

  it('honors longest-match Allow override', async () => {
    const fetchImpl = stub({
      'https://x.example/robots.txt': {
        status: 200,
        body: 'User-agent: *\nDisallow: /private\nAllow: /private/ok\n',
      },
    });
    const cache = mkCache(fetchImpl);
    expect(await cache.isAllowed('https://x.example/private/blocked')).toBe(false);
    expect(await cache.isAllowed('https://x.example/private/ok/page')).toBe(true);
  });

  it('matches more specific user-agent group over wildcard', async () => {
    const fetchImpl = stub({
      'https://x.example/robots.txt': {
        status: 200,
        body: `User-agent: *
Disallow: /

User-agent: RegardedTrader
Allow: /
`,
      },
    });
    const cache = mkCache(fetchImpl);
    expect(await cache.isAllowed('https://x.example/anything')).toBe(true);
  });

  it('skip() bypasses checks for first-party hosts', async () => {
    const fetchImpl = stub({
      'https://api.example/robots.txt': {
        status: 200,
        body: 'User-agent: *\nDisallow: /\n',
      },
    });
    const cache = mkCache(fetchImpl);
    cache.skip('api.example');
    expect(await cache.isAllowed('https://api.example/v1/data')).toBe(true);
  });

  it('caches robots.txt within ttl', async () => {
    let hits = 0;
    const fetchImpl: FetchLike = async () => {
      hits++;
      return new Response('User-agent: *\nDisallow: /a\n', { status: 200 });
    };
    const cache = mkCache(fetchImpl);
    await cache.isAllowed('https://x.example/a');
    await cache.isAllowed('https://x.example/b');
    expect(hits).toBe(1);
  });

  it('supports * wildcard and $ end-anchor', async () => {
    const fetchImpl = stub({
      'https://x.example/robots.txt': {
        status: 200,
        body: 'User-agent: *\nDisallow: /*.pdf$\n',
      },
    });
    const cache = mkCache(fetchImpl);
    expect(await cache.isAllowed('https://x.example/docs/file.pdf')).toBe(false);
    expect(await cache.isAllowed('https://x.example/docs/file.pdf?x=1')).toBe(true);
    expect(await cache.isAllowed('https://x.example/docs/file.html')).toBe(true);
  });
});
