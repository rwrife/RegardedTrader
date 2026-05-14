import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WatchlistStore } from './watchlist.js';
import type { TickerProfile } from '../schemas/index.js';

function profile(symbol: string, validatedAt = new Date().toISOString()): TickerProfile {
  return {
    symbol,
    name: `${symbol} Inc.`,
    exchange: 'NASDAQ',
    sector: 'Technology',
    industry: 'Software',
    description: 'A company.',
    sources: ['https://example.com/1'],
    validatedAt,
  };
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rt-watchlist-'));
  file = join(dir, 'watchlist.json');
});

describe('WatchlistStore', () => {
  it('returns an empty list when the file does not exist', async () => {
    const store = new WatchlistStore({ path: file });
    expect(await store.list()).toEqual([]);
  });

  it('upserts, lists, and removes entries', async () => {
    const store = new WatchlistStore({ path: file });
    await store.upsert(profile('NVDA'));
    await store.upsert(profile('AAPL'));
    const list = await store.list();
    expect(list.map((e) => e.profile.symbol)).toEqual(['AAPL', 'NVDA']);

    expect(await store.remove('NVDA')).toBe(true);
    expect(await store.remove('NVDA')).toBe(false);
    expect((await store.list()).map((e) => e.profile.symbol)).toEqual(['AAPL']);
  });

  it('preserves addedAt across re-validations', async () => {
    const store = new WatchlistStore({
      path: file,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    await store.upsert(profile('NVDA', '2025-12-01T00:00:00Z'));
    const store2 = new WatchlistStore({
      path: file,
      now: () => new Date('2026-02-01T00:00:00Z'),
    });
    const re = await store2.upsert(profile('NVDA', '2026-02-01T00:00:00Z'));
    expect(re.addedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(re.profile.validatedAt).toBe('2026-02-01T00:00:00Z');
  });

  it('isStale flips after TTL', async () => {
    const store = new WatchlistStore({
      path: file,
      ttlMs: 1000,
      now: () => new Date('2026-01-01T00:00:10Z'),
    });
    const fresh = await store.upsert(profile('NVDA', '2026-01-01T00:00:09.500Z'));
    const old = { ...fresh, profile: { ...fresh.profile, validatedAt: '2025-12-01T00:00:00Z' } };
    expect(store.isStale(fresh)).toBe(false);
    expect(store.isStale(old)).toBe(true);
  });

  it('writes JSON that round-trips', async () => {
    const store = new WatchlistStore({ path: file });
    await store.upsert(profile('NVDA'));
    const raw = await readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    expect(parsed).toMatchObject({ version: 1 });
  });
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
