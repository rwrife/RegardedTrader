import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore, type SnapshotEntry } from './store.js';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('SnapshotStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'regard-snap-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('appends an entry, updates latest.json, and round-trips through readRange', async () => {
    const store = new SnapshotStore({ root });
    const entry: SnapshotEntry = { ts: '2026-05-10T12:00:00.000Z', data: { price: 100 } };
    await store.appendSnapshot('nvda', 'quote', entry);

    const latest = await store.readLatest('nvda');
    expect(latest.symbol).toBe('NVDA');
    expect(latest.entries.quote).toEqual(entry);

    const rows = await collect(store.readRange('NVDA', 'quote'));
    expect(rows).toEqual([entry]);

    // Symbol dir is uppercased.
    const dirs = await readdir(root);
    expect(dirs).toContain('NVDA');
  });

  it('normalizes symbol case for read+write', async () => {
    const store = new SnapshotStore({ root });
    await store.appendSnapshot('aapl', 'quote', { ts: '2026-05-10T12:00:00.000Z', data: 1 });
    const latest = await store.readLatest('AaPl');
    expect(latest.entries.quote).toBeDefined();
  });

  it('returns an empty latest for unknown symbols', async () => {
    const store = new SnapshotStore({ root });
    const latest = await store.readLatest('FOO');
    expect(latest.symbol).toBe('FOO');
    expect(latest.entries).toEqual({});
  });

  it('keeps separate latest slots per kind', async () => {
    const store = new SnapshotStore({ root });
    const q: SnapshotEntry = { ts: '2026-05-10T12:00:00.000Z', data: { p: 1 } };
    const n: SnapshotEntry = {
      ts: '2026-05-10T12:05:00.000Z',
      data: { url: 'https://example.com/a', title: 'A' },
    };
    await store.appendSnapshot('NVDA', 'quote', q);
    await store.appendSnapshot('NVDA', 'news', n);
    const latest = await store.readLatest('NVDA');
    expect(latest.entries.quote).toEqual(q);
    expect(latest.entries.news).toEqual(n);
  });

  it('filters readRange by since/until', async () => {
    const store = new SnapshotStore({ root });
    const entries: SnapshotEntry[] = [
      { ts: '2026-05-10T10:00:00.000Z', data: 1 },
      { ts: '2026-05-10T11:00:00.000Z', data: 2 },
      { ts: '2026-05-10T12:00:00.000Z', data: 3 },
    ];
    for (const e of entries) await store.appendSnapshot('NVDA', 'quote', e);

    const got = await collect(
      store.readRange(
        'NVDA',
        'quote',
        new Date('2026-05-10T10:30:00.000Z'),
        new Date('2026-05-10T11:30:00.000Z'),
      ),
    );
    expect(got.map((e) => e.data)).toEqual([2]);
  });

  describe('news dedup', () => {
    it('drops a duplicate url within the dedup window', async () => {
      const store = new SnapshotStore({ root });
      const a: SnapshotEntry = {
        ts: '2026-05-10T12:00:00.000Z',
        data: { url: 'https://example.com/x', title: 'A' },
      };
      const b: SnapshotEntry = {
        ts: '2026-05-10T13:00:00.000Z',
        data: { url: 'https://example.com/x', title: 'A again' },
      };
      const first = await store.appendSnapshot('NVDA', 'news', a);
      const second = await store.appendSnapshot('NVDA', 'news', b);
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      const rows = await collect(store.readRange('NVDA', 'news'));
      expect(rows).toHaveLength(1);
    });

    it('accepts the duplicate again after the window has passed', async () => {
      const store = new SnapshotStore({ root, newsDedupWindowMs: 1000 });
      const a: SnapshotEntry = {
        ts: '2026-05-10T12:00:00.000Z',
        data: { url: 'https://example.com/x' },
      };
      const b: SnapshotEntry = {
        ts: '2026-05-10T12:00:02.000Z',
        data: { url: 'https://example.com/x' },
      };
      await store.appendSnapshot('NVDA', 'news', a);
      const second = await store.appendSnapshot('NVDA', 'news', b);
      expect(second).not.toBeNull();
    });

    it('hydrates the dedup cache from disk across instances', async () => {
      const s1 = new SnapshotStore({ root, now: () => new Date('2026-05-10T12:00:00.000Z') });
      await s1.appendSnapshot('NVDA', 'news', {
        ts: '2026-05-10T12:00:00.000Z',
        data: { url: 'https://example.com/dup' },
      });
      const s2 = new SnapshotStore({ root, now: () => new Date('2026-05-10T12:30:00.000Z') });
      const got = await s2.appendSnapshot('NVDA', 'news', {
        ts: '2026-05-10T12:30:00.000Z',
        data: { url: 'https://example.com/dup' },
      });
      expect(got).toBeNull();
    });

    it('allows explicit `url` opts to override data.url for hashing', async () => {
      const store = new SnapshotStore({ root });
      await store.appendSnapshot(
        'NVDA',
        'news',
        { ts: '2026-05-10T12:00:00.000Z', data: { title: 'no-url' } },
        { url: 'https://example.com/explicit' },
      );
      const dup = await store.appendSnapshot(
        'NVDA',
        'news',
        { ts: '2026-05-10T12:05:00.000Z', data: { title: 'no-url' } },
        { url: 'https://example.com/explicit' },
      );
      expect(dup).toBeNull();
    });
  });

  describe('compactDaily', () => {
    it('rolls yesterday entries into a gzip archive and clears them from the live file', async () => {
      const today = new Date('2026-05-12T00:00:00.000Z');
      const store = new SnapshotStore({ root, now: () => today });
      const yesterday: SnapshotEntry = { ts: '2026-05-11T15:00:00.000Z', data: 1 };
      const todayEntry: SnapshotEntry = { ts: '2026-05-12T09:00:00.000Z', data: 2 };
      await store.appendSnapshot('NVDA', 'quote', yesterday);
      await store.appendSnapshot('NVDA', 'quote', todayEntry);

      await store.compactDaily();

      const archive = join(root, 'NVDA', 'quote-2026-05-11.jsonl.gz');
      const archived = await stat(archive);
      expect(archived.isFile()).toBe(true);

      const live = await readFile(join(root, 'NVDA', 'quote.jsonl'), 'utf8');
      const lines = live.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(lines).toEqual([todayEntry]);

      // readRange should still see both, oldest first.
      const got = await collect(store.readRange('NVDA', 'quote'));
      expect(got).toEqual([yesterday, todayEntry]);
    });

    it('drops archives older than the retention window per kind', async () => {
      const today = new Date('2026-05-12T00:00:00.000Z');
      const store = new SnapshotStore({
        root,
        now: () => today,
        retention: { quote: 1 },
      });
      // 5 days old — older than the 1-day quote retention.
      await store.appendSnapshot('NVDA', 'quote', {
        ts: '2026-05-07T10:00:00.000Z',
        data: 'stale',
      });
      // 0.5 days old — within retention after rotation.
      await store.appendSnapshot('NVDA', 'quote', {
        ts: '2026-05-11T18:00:00.000Z',
        data: 'fresh',
      });
      await store.compactDaily();

      const files = await readdir(join(root, 'NVDA'));
      expect(files).not.toContain('quote-2026-05-07.jsonl.gz');
      expect(files).toContain('quote-2026-05-11.jsonl.gz');
    });

    it('is a no-op when nothing predates today', async () => {
      const today = new Date('2026-05-12T00:00:00.000Z');
      const store = new SnapshotStore({ root, now: () => today });
      await store.appendSnapshot('NVDA', 'quote', {
        ts: '2026-05-12T08:00:00.000Z',
        data: 1,
      });
      await store.compactDaily();
      const files = await readdir(join(root, 'NVDA'));
      expect(files.filter((f) => f.endsWith('.jsonl.gz'))).toHaveLength(0);
    });
  });

  it('writes latest.json atomically (no .tmp lying around after success)', async () => {
    const store = new SnapshotStore({ root });
    await store.appendSnapshot('NVDA', 'quote', { ts: '2026-05-10T12:00:00.000Z', data: 1 });
    const files = await readdir(join(root, 'NVDA'));
    expect(files).not.toContain('latest.json.tmp');
    expect(files).toContain('latest.json');
  });

  // --- chaos cases (issue #29) ---

  it('tolerates a truncated / malformed final JSONL line (simulated killed-mid-write)', async () => {
    // Simulates: process killed mid-write on the live JSONL. `readRange` must
    // yield all well-formed entries and silently skip the corrupted tail
    // rather than throw. Zero-corruption on next boot is a separate guarantee
    // (see the atomic-latest.json test above); the reader’s job is to survive.
    const store = new SnapshotStore({ root });
    const e1: SnapshotEntry = { ts: '2026-05-10T12:00:00.000Z', data: { p: 1 } };
    const e2: SnapshotEntry = { ts: '2026-05-10T12:00:05.000Z', data: { p: 2 } };
    await store.appendSnapshot('NVDA', 'quote', e1);
    await store.appendSnapshot('NVDA', 'quote', e2);

    // Simulate a crash mid-line: partial JSON with a stray newline at the
    // very end (the process died just after emitting an incomplete record but
    // before flushing the closing brace — the OS still terminated the write
    // with the trailing \n from a previous partial buffer).
    const live = join(root, 'NVDA', 'quote.jsonl');
    await appendFile(live, '{"ts":"2026-05-10T12:00:10.000Z","data":{"p":3\n', 'utf8');

    const rows = await collect(store.readRange('NVDA', 'quote'));
    expect(rows).toEqual([e1, e2]);

    // A subsequent append after truncation still lands — the corrupted partial
    // line stays skipped, and the new well-formed entry reads back cleanly.
    const e3: SnapshotEntry = { ts: '2026-05-10T12:00:15.000Z', data: { p: 4 } };
    await store.appendSnapshot('NVDA', 'quote', e3);
    const rows2 = await collect(store.readRange('NVDA', 'quote'));
    expect(rows2).toEqual([e1, e2, e3]);
  });
});
