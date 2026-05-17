import { mkdtempSync, statSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TickerProfile } from '../schemas/ticker.js';
import { TickerResolutionError, type TickerResolver } from './resolver.js';
import {
  DEFAULT_LRU_SIZE,
  EXISTENCE_TTL_MS,
  PROFILE_TTL_MS,
  TickerStore,
} from './store.js';

function mkTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'rt-tickers-'));
}

function profile(symbol: string, opts: { validatedAt?: string; name?: string } = {}): TickerProfile {
  return TickerProfile.parse({
    symbol,
    name: opts.name ?? `${symbol} Inc.`,
    exchange: 'NASDAQ',
    sector: 'Tech',
    industry: 'Software',
    description: `${symbol} does things.`,
    sourceUrls: [`https://example.com/${symbol}`],
    validatedAt: opts.validatedAt ?? '2026-01-01T00:00:00.000Z',
    confidence: 0.9,
    sources: ['stub'],
  });
}

function fakeResolver(map: Record<string, TickerProfile>, calls: string[] = []): Pick<TickerResolver, 'resolve'> {
  return {
    async resolve(input: string) {
      calls.push(input);
      const sym = input.trim().toUpperCase();
      const p = map[sym];
      if (!p) throw new TickerResolutionError(`no profile for ${input}`, input, []);
      return p;
    },
  };
}

describe('TickerStore — disk persistence', () => {
  it('writes profiles to {SYMBOL}.json with chmod 600', async () => {
    const dir = mkTmpDir();
    const store = new TickerStore({ dir });
    await store.put(profile('NVDA'));

    const path = join(dir, 'NVDA.json');
    const raw = await readFile(path, 'utf8');
    const parsed = TickerProfile.parse(JSON.parse(raw));
    expect(parsed.symbol).toBe('NVDA');

    // chmod 600 is best-effort but should succeed on POSIX runners (vitest CI).
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('round-trips through disk independently of the LRU', async () => {
    const dir = mkTmpDir();
    const writer = new TickerStore({ dir });
    await writer.put(profile('AAPL'));

    const reader = new TickerStore({ dir });
    const got = await reader.get('aapl');
    expect(got?.symbol).toBe('AAPL');
  });

  it('list() returns all on-disk profiles, sorted by symbol', async () => {
    const dir = mkTmpDir();
    const store = new TickerStore({ dir });
    await store.put(profile('MSFT'));
    await store.put(profile('AAPL'));
    await store.put(profile('NVDA'));

    const list = await store.list();
    expect(list.map((p) => p.symbol)).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });

  it('list() returns [] when the directory does not exist', async () => {
    const store = new TickerStore({ dir: join(mkTmpDir(), 'never-created') });
    expect(await store.list()).toEqual([]);
  });

  it('list() skips files that are not symbol-shaped', async () => {
    const dir = mkTmpDir();
    const store = new TickerStore({ dir });
    await store.put(profile('AAPL'));
    await writeFile(join(dir, 'README.md'), 'hi');
    await writeFile(join(dir, 'not-a-symbol-because-too-long.json'), '{}');

    const list = await store.list();
    expect(list.map((p) => p.symbol)).toEqual(['AAPL']);
  });

  it('remove() deletes from disk and LRU, returning false on miss', async () => {
    const dir = mkTmpDir();
    const store = new TickerStore({ dir });
    await store.put(profile('TSLA'));

    expect(await store.remove('TSLA')).toBe(true);
    expect(await store.get('TSLA')).toBeUndefined();
    expect(await store.remove('TSLA')).toBe(false);
  });

  it('quarantines corrupt JSON instead of nuking it', async () => {
    const dir = mkTmpDir();
    const writer = new TickerStore({ dir });
    await writer.put(profile('GOOG'));
    await writeFile(join(dir, 'GOOG.json'), '{not json');

    // Use a fresh store so the LRU isn't masking the on-disk corruption.
    const store = new TickerStore({ dir });
    expect(await store.get('GOOG')).toBeUndefined();
    const names = await readdir(dir);
    expect(names.some((n) => n.startsWith('GOOG.json.corrupt-'))).toBe(true);
  });
});

describe('TickerStore — LRU', () => {
  it('serves repeat reads from memory without touching disk', async () => {
    const dir = mkTmpDir();
    const store = new TickerStore({ dir });
    await store.put(profile('AAPL'));

    const first = await store.get('AAPL');
    // Delete the file out from under the store; the LRU should still return it.
    await readFile(join(dir, 'AAPL.json'), 'utf8'); // sanity check existed
    await (await import('node:fs/promises')).unlink(join(dir, 'AAPL.json'));

    const second = await store.get('AAPL');
    expect(first?.symbol).toBe('AAPL');
    expect(second?.symbol).toBe('AAPL');
  });

  it('evicts the oldest entry when capacity is exceeded', async () => {
    const dir = mkTmpDir();
    const store = new TickerStore({ dir, lruSize: 2 });
    await store.put(profile('AAA'));
    await store.put(profile('BBB'));
    await store.put(profile('CCC')); // should evict AAA from LRU

    // Force a disk read for AAA by deleting it on disk; if it were still
    // in the LRU we'd get a value back. Eviction means disk-miss → undefined.
    await (await import('node:fs/promises')).unlink(join(dir, 'AAA.json'));
    expect(await store.get('AAA')).toBeUndefined();
    expect((await store.get('BBB'))?.symbol).toBe('BBB');
  });

  it('exposes a sensible default LRU size', () => {
    expect(DEFAULT_LRU_SIZE).toBe(256);
  });
});

describe('TickerStore — TTLs', () => {
  it('uses 30 days for metadata and 24h for existence by default', () => {
    expect(PROFILE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(EXISTENCE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('flags existence-stale before metadata-stale', () => {
    const now = vi.fn(() => new Date('2026-01-03T00:00:00.000Z'));
    const store = new TickerStore({ dir: mkTmpDir(), now });
    const p = profile('NVDA', { validatedAt: '2026-01-01T00:00:00.000Z' }); // 2 days ago

    expect(store.isExistenceStale(p)).toBe(true);
    expect(store.isMetadataStale(p)).toBe(false);
  });

  it('flags both stale once past the metadata TTL', () => {
    const now = vi.fn(() => new Date('2026-03-01T00:00:00.000Z'));
    const store = new TickerStore({ dir: mkTmpDir(), now });
    const p = profile('NVDA', { validatedAt: '2026-01-01T00:00:00.000Z' });

    expect(store.isExistenceStale(p)).toBe(true);
    expect(store.isMetadataStale(p)).toBe(true);
  });
});

describe('TickerStore — getOrResolve', () => {
  it('returns LRU hits without invoking the resolver', async () => {
    const now = () => new Date('2026-01-01T01:00:00.000Z');
    const store = new TickerStore({ dir: mkTmpDir(), now });
    await store.put(profile('NVDA', { validatedAt: '2026-01-01T00:00:00.000Z' }));

    const calls: string[] = [];
    const resolver = fakeResolver({}, calls);
    const out = await store.getOrResolve('NVDA', resolver);
    expect(out.source).toBe('lru');
    expect(out.existenceStale).toBe(false);
    expect(calls).toEqual([]);
  });

  it('falls back to disk when the LRU is cold', async () => {
    const dir = mkTmpDir();
    const now = () => new Date('2026-01-01T01:00:00.000Z');
    const writer = new TickerStore({ dir, now });
    await writer.put(profile('AAPL', { validatedAt: '2026-01-01T00:00:00.000Z' }));

    const reader = new TickerStore({ dir, now });
    const calls: string[] = [];
    const out = await reader.getOrResolve('AAPL', fakeResolver({}, calls));
    expect(out.source).toBe('disk');
    expect(calls).toEqual([]);
  });

  it('re-resolves when the existence TTL has expired even if metadata is fresh', async () => {
    const dir = mkTmpDir();
    // Cached entry is 2 days old → existence-stale (24h) but not metadata-stale (30d).
    const now = () => new Date('2026-01-03T00:00:00.000Z');
    const seed = new TickerStore({ dir, now });
    await seed.put(profile('NVDA', { validatedAt: '2026-01-01T00:00:00.000Z' }));

    const fresh = profile('NVDA', { validatedAt: '2026-01-03T00:00:00.000Z', name: 'NVIDIA' });
    const calls: string[] = [];
    const resolver = fakeResolver({ NVDA: fresh }, calls);

    const store = new TickerStore({ dir, now });
    const out = await store.getOrResolve('NVDA', resolver);
    expect(out.source).toBe('resolver');
    expect(out.profile.name).toBe('NVIDIA');
    expect(calls).toEqual(['NVDA']);

    // Subsequent call within the existence TTL should hit the LRU again.
    const out2 = await store.getOrResolve('NVDA', fakeResolver({}, calls));
    expect(out2.source).toBe('lru');
    expect(calls).toEqual(['NVDA']); // unchanged
  });

  it('force=true bypasses both LRU and disk', async () => {
    const dir = mkTmpDir();
    const now = () => new Date('2026-01-01T01:00:00.000Z');
    const store = new TickerStore({ dir, now });
    await store.put(profile('NVDA', { validatedAt: '2026-01-01T00:00:00.000Z' }));

    const fresh = profile('NVDA', { validatedAt: '2026-01-01T01:00:00.000Z', name: 'NEW' });
    const calls: string[] = [];
    const out = await store.getOrResolve('NVDA', fakeResolver({ NVDA: fresh }, calls), { force: true });
    expect(out.source).toBe('resolver');
    expect(out.profile.name).toBe('NEW');
    expect(calls).toEqual(['NVDA']);
  });

  it('routes non-symbol queries straight to the resolver', async () => {
    const store = new TickerStore({ dir: mkTmpDir() });
    const calls: string[] = [];
    const aapl = profile('AAPL');
    const resolver: Pick<TickerResolver, 'resolve'> = {
      async resolve(input: string) {
        calls.push(input);
        return aapl;
      },
    };
    const out = await store.getOrResolve('apple inc', resolver);
    // resolver returns AAPL; we never tried the cache because the input had spaces.
    expect(out.source).toBe('resolver');
    expect(out.profile.symbol).toBe('AAPL');
    expect(calls).toEqual(['apple inc']);

    // The resolved profile is now persisted under its canonical symbol.
    expect((await store.get('AAPL'))?.symbol).toBe('AAPL');
  });

  it('rejects empty input', async () => {
    const store = new TickerStore({ dir: mkTmpDir() });
    await expect(
      store.getOrResolve('   ', fakeResolver({})),
    ).rejects.toBeInstanceOf(TickerResolutionError);
  });

  it('propagates resolver failures', async () => {
    const store = new TickerStore({ dir: mkTmpDir() });
    await expect(
      store.getOrResolve('ZZZZ', fakeResolver({})),
    ).rejects.toBeInstanceOf(TickerResolutionError);
  });
});
