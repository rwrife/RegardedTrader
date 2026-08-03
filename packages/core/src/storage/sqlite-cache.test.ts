import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteCache } from './sqlite-cache.js';

describe('SQLiteCache', () => {
  const caches: SQLiteCache[] = [];

  afterEach(async () => {
    while (caches.length > 0) {
      await caches.pop()?.close();
    }
  });

  function make(nowMs = 1_700_000_000_000): {
    cache: SQLiteCache;
    advance: (ms: number) => void;
  } {
    let t = nowMs;
    const cache = new SQLiteCache({
      dbPath: ':memory:',
      namespaceTtls: { quotes: 30_000, history: 300_000, chain: 60_000, news: 300_000 },
      now: () => t,
    });
    caches.push(cache);
    return {
      cache,
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  it('returns miss then hit for set/get', async () => {
    const { cache } = make();
    await expect(cache.get<{ price: number }>('quotes', 'NVDA')).resolves.toBeUndefined();
    await cache.set('quotes', 'NVDA', { price: 100 });
    await expect(cache.get<{ price: number }>('quotes', 'NVDA')).resolves.toEqual({ price: 100 });
  });

  it('evicts on lazy read when expired', async () => {
    const { cache, advance } = make();
    await cache.set('chain', 'NVDA:next', [1, 2, 3]);
    advance(61_000);
    await expect(cache.get<number[]>('chain', 'NVDA:next')).resolves.toBeUndefined();
  });

  it('sweeps expired rows and keeps fresh rows', async () => {
    const { cache, advance } = make();
    await cache.set('quotes', 'AAPL', { p: 1 });
    await cache.set('history', 'AAPL:30', [1]);
    advance(31_000);
    const deleted = await cache.sweep();
    expect(deleted).toBe(1);
    await expect(cache.get('quotes', 'AAPL')).resolves.toBeUndefined();
    await expect(cache.get('history', 'AAPL:30')).resolves.toEqual([1]);
  });
});
