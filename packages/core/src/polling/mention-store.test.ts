import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MentionStore } from './mention-store.js';
import type { MentionItem, ScoredMention, SentimentSnapshot } from '../schemas/sentiment.js';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

function mention(overrides: Partial<MentionItem> = {}): MentionItem {
  return {
    source: 'reddit',
    sourceId: 'abc123',
    symbol: 'NVDA',
    url: 'https://reddit.com/r/wsb/abc123',
    title: 'NVDA to the moon',
    text: 'thoughts on NVDA earnings tomorrow',
    publishedAt: '2026-05-10T12:00:00.000Z',
    fetchedAt: '2026-05-10T12:01:00.000Z',
    ...overrides,
  };
}

describe('MentionStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'regard-mention-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('appends a mention and round-trips through readMentions', async () => {
    const store = new MentionStore({ root });
    const m = mention();
    const written = await store.appendMention(m);
    expect(written).not.toBeNull();
    expect(written?.symbol).toBe('NVDA');

    const rows = await collect(store.readMentions('NVDA'));
    expect(rows).toEqual([m]);

    const dirs = await readdir(root);
    expect(dirs).toContain('NVDA');
  });

  it('strips unknown fields (no authors persisted)', async () => {
    const store = new MentionStore({ root });
    // @ts-expect-error — deliberately feeding an unknown `author` field
    await store.appendMention({ ...mention(), author: 'u/Spez', subreddit: 'wsb' });
    const live = await readFile(join(root, 'NVDA', 'mentions.jsonl'), 'utf8');
    const parsed = JSON.parse(live.trim());
    expect(parsed.author).toBeUndefined();
    expect(parsed.subreddit).toBeUndefined();
    expect(parsed.source).toBe('reddit');
  });

  it('dedupes by (source, sourceId) within the retention window', async () => {
    const now = () => new Date('2026-05-10T12:05:00.000Z');
    const store = new MentionStore({ root, now });
    const first = await store.appendMention(mention());
    const dupe = await store.appendMention(mention({ text: 'different excerpt' }));
    expect(first).not.toBeNull();
    expect(dupe).toBeNull();

    // Different sourceId is NOT a dupe.
    const other = await store.appendMention(mention({ sourceId: 'xyz999' }));
    expect(other).not.toBeNull();

    // Different source with same sourceId is NOT a dupe either.
    const cross = await store.appendMention(mention({ source: 'hn' }));
    expect(cross).not.toBeNull();

    const rows = await collect(store.readMentions('NVDA'));
    expect(rows).toHaveLength(3);
  });

  it('dedup cache hydrates from disk on a fresh instance', async () => {
    const now = () => new Date('2026-05-10T12:05:00.000Z');
    const a = new MentionStore({ root, now });
    await a.appendMention(mention());

    const b = new MentionStore({ root, now });
    const dupe = await b.appendMention(mention());
    expect(dupe).toBeNull();
  });

  it('appends sentiment snapshots and mirrors latest.json', async () => {
    const store = new MentionStore({ root, now: () => new Date('2026-05-10T12:30:00.000Z') });
    const snap: SentimentSnapshot = {
      symbol: 'NVDA',
      asOf: '2026-05-10T12:30:00.000Z',
      score: 0.42,
      confidence: 0.7,
      volume: 17,
      bySource: { reddit: { score: 0.5, confidence: 0.8, volume: 10 } },
    };
    await store.appendSentiment(snap);

    const latest = await store.readLatest('NVDA');
    expect(latest.symbol).toBe('NVDA');
    expect(latest.sentiment).toEqual(snap);

    const snaps = await collect(store.readSentiment('NVDA'));
    expect(snaps).toEqual([snap]);
  });

  it('writes latest.json with mode 0600', async () => {
    if (process.platform === 'win32') return;
    const store = new MentionStore({ root });
    await store.appendSentiment({
      symbol: 'NVDA',
      asOf: '2026-05-10T12:00:00.000Z',
      score: 0,
      confidence: 0,
      volume: 0,
      bySource: {},
    });
    const s = await stat(join(root, 'NVDA', 'latest.json'));
    expect(s.mode & 0o777).toBe(0o600);
  });

  it('appendScoredMention persists the sentiment block', async () => {
    const store = new MentionStore({ root });
    const scored: ScoredMention = {
      ...mention(),
      sentiment: { score: 0.6, confidence: 0.9, label: 'bullish' },
      scoredAt: '2026-05-10T12:02:00.000Z',
    };
    await store.appendScoredMention(scored);
    const rows = await collect(store.readMentions('NVDA'));
    expect(rows).toHaveLength(1);
    const row = rows[0] as ScoredMention;
    expect(row.sentiment.label).toBe('bullish');
  });

  it('filters readMentions by since/until', async () => {
    const store = new MentionStore({ root });
    await store.appendMention(mention({ sourceId: '1', publishedAt: '2026-05-10T10:00:00.000Z' }));
    await store.appendMention(mention({ sourceId: '2', publishedAt: '2026-05-10T11:00:00.000Z' }));
    await store.appendMention(mention({ sourceId: '3', publishedAt: '2026-05-10T12:00:00.000Z' }));
    const got = await collect(
      store.readMentions(
        'NVDA',
        new Date('2026-05-10T10:30:00.000Z'),
        new Date('2026-05-10T11:30:00.000Z'),
      ),
    );
    expect(got).toHaveLength(1);
    expect(got[0]!.sourceId).toBe('2');
  });

  it('compactDaily rolls yesterday into a gz archive and keeps today in live file', async () => {
    const today = new Date('2026-05-12T00:00:00.000Z');
    const store = new MentionStore({ root, now: () => today });
    await store.appendMention(mention({ sourceId: '1', publishedAt: '2026-05-10T10:00:00.000Z' }));
    await store.appendMention(mention({ sourceId: '2', publishedAt: '2026-05-11T10:00:00.000Z' }));
    await store.appendMention(mention({ sourceId: '3', publishedAt: '2026-05-12T10:00:00.000Z' }));

    await store.compactDaily();

    const files = await readdir(join(root, 'NVDA'));
    expect(files).toEqual(expect.arrayContaining(['mentions-2026-05-10.jsonl.gz', 'mentions-2026-05-11.jsonl.gz']));
    // Live file only contains today's entry now.
    const live = await readFile(join(root, 'NVDA', 'mentions.jsonl'), 'utf8');
    const lines = live.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).sourceId).toBe('3');

    // readMentions still streams across archives + live.
    const all = await collect(store.readMentions('NVDA'));
    expect(all.map((m) => m.sourceId).sort()).toEqual(['1', '2', '3']);
  });

  it('compactDaily enforces retention by unlinking old archives', async () => {
    const today = new Date('2026-06-20T00:00:00.000Z');
    const store = new MentionStore({
      root,
      now: () => today,
      retention: { mentions: 5 },
    });
    // Pre-seed an "old" gz archive directly so we can verify it's pruned.
    await mkdir(join(root, 'NVDA'), { recursive: true });
    await writeFile(join(root, 'NVDA', 'mentions-2026-05-01.jsonl.gz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    await writeFile(join(root, 'NVDA', 'mentions-2026-06-18.jsonl.gz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00]));

    await store.compactDaily();

    const files = await readdir(join(root, 'NVDA'));
    expect(files).not.toContain('mentions-2026-05-01.jsonl.gz');
    expect(files).toContain('mentions-2026-06-18.jsonl.gz');
  });

  it('readLatest returns an empty skeleton for unknown symbols', async () => {
    const store = new MentionStore({ root });
    const latest = await store.readLatest('FOO');
    expect(latest.symbol).toBe('FOO');
    expect(latest.entries).toEqual({});
    expect(latest.sentiment).toBeUndefined();
  });

  it('appendSentiment does not clobber existing entries in latest.json', async () => {
    // Simulate a pre-existing latest.json written by SnapshotStore.
    await mkdir(join(root, 'NVDA'), { recursive: true });
    const pre = {
      symbol: 'NVDA',
      updatedAt: '2026-05-10T11:00:00.000Z',
      entries: { quote: { ts: '2026-05-10T11:00:00.000Z', data: { price: 100 } } },
    };
    await writeFile(join(root, 'NVDA', 'latest.json'), JSON.stringify(pre));

    const store = new MentionStore({ root });
    await store.appendSentiment({
      symbol: 'NVDA',
      asOf: '2026-05-10T12:00:00.000Z',
      score: 0.1,
      confidence: 0.5,
      volume: 3,
      bySource: {},
    });

    const after = JSON.parse(await readFile(join(root, 'NVDA', 'latest.json'), 'utf8'));
    expect(after.entries.quote.data.price).toBe(100);
    expect(after.sentiment.score).toBe(0.1);
  });
});
