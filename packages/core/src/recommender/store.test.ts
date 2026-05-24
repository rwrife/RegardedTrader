import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecommendationStore } from './store.js';
import {
  RECOMMENDATION_DISCLAIMER,
  Recommendation,
  Verdict,
} from '../schemas/recommendation.js';

function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return Verdict.parse({
    action: 'HOLD',
    conviction: 0.5,
    rationale: 'baseline',
    signals: [],
    contraSignals: [],
    ...overrides,
  });
}

function makeRec(overrides: Partial<Recommendation> = {}): Recommendation {
  return Recommendation.parse({
    symbol: 'NVDA',
    generatedAt: '2026-05-10T12:00:00.000Z',
    asOf: { quote: '2026-05-10T11:59:00.000Z', options: null, sentiment: null, news: null },
    equity: makeVerdict({ action: 'BUY', conviction: 0.7, rationale: 'momentum' }),
    options: { coveredCall: null, coveredPut: null, nakedCall: null, nakedPut: null },
    riskFlags: [],
    sources: [],
    modelInfo: { provider: 'openai', model: 'gpt-4o-mini', ruleVersion: 'v1' },
    disclaimer: RECOMMENDATION_DISCLAIMER,
    ...overrides,
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('RecommendationStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'regard-rec-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('appends and round-trips through readRange', async () => {
    const store = new RecommendationStore({ root });
    const rec = makeRec();
    await store.append('nvda', rec);

    const all = await collect(store.readRange('NVDA'));
    expect(all).toEqual([rec]);

    // Symbol dir is uppercased on disk.
    const dirs = await readdir(root);
    expect(dirs).toContain('NVDA');
  });

  it('mirrors the latest recommendation into latest.json', async () => {
    const store = new RecommendationStore({ root });
    const first = makeRec({ equity: makeVerdict({ action: 'BUY', conviction: 0.6, rationale: 'a' }) });
    const second = makeRec({
      generatedAt: '2026-05-10T13:00:00.000Z',
      equity: makeVerdict({ action: 'SELL', conviction: 0.4, rationale: 'b' }),
    });
    await store.append('NVDA', first);
    await store.append('NVDA', second);

    const latest = await store.readLatest('NVDA');
    expect(latest?.equity.action).toBe('SELL');
    expect(latest?.disclaimer).toBe(RECOMMENDATION_DISCLAIMER);

    // The mirror file is chmod 600.
    const s = await stat(join(root, 'NVDA', 'latest.json'));
    expect(s.mode & 0o777).toBe(0o600);
  });

  it('readLatest returns null for unknown symbols', async () => {
    const store = new RecommendationStore({ root });
    const latest = await store.readLatest('FOO');
    expect(latest).toBeNull();
  });

  it('preserves an existing latest.json (e.g. SnapshotStore entries)', async () => {
    // Pre-seed latest.json the way SnapshotStore would have written it.
    const store = new RecommendationStore({ root });
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(root, 'NVDA'), { recursive: true });
    await writeFile(
      join(root, 'NVDA', 'latest.json'),
      JSON.stringify({
        symbol: 'NVDA',
        updatedAt: '2026-05-10T11:00:00.000Z',
        entries: { quote: { ts: '2026-05-10T11:00:00.000Z', data: { price: 100 } } },
      }),
    );

    await store.append('NVDA', makeRec());

    const raw = JSON.parse(await readFile(join(root, 'NVDA', 'latest.json'), 'utf8')) as {
      entries: Record<string, unknown>;
      recommendation?: { equity?: { action: string } };
    };
    expect(raw.entries.quote).toBeDefined();
    expect(raw.recommendation?.equity?.action).toBe('BUY');
  });

  it('honours the schema: disclaimer must be non-empty', () => {
    expect(() =>
      Recommendation.parse({
        symbol: 'NVDA',
        generatedAt: '2026-05-10T12:00:00.000Z',
        asOf: { quote: '2026-05-10T11:59:00.000Z', options: null, sentiment: null, news: null },
        equity: makeVerdict(),
        options: { coveredCall: null, coveredPut: null, nakedCall: null, nakedPut: null },
        riskFlags: [],
        sources: [],
        modelInfo: { provider: 'openai', model: 'gpt-4o-mini', ruleVersion: 'v1' },
        disclaimer: '',
      }),
    ).toThrow();
  });

  it('rejects invalid action / conviction values via Verdict schema', () => {
    expect(() => Verdict.parse({ ...makeVerdict(), action: 'YOLO' })).toThrow();
    expect(() => Verdict.parse({ ...makeVerdict(), conviction: 1.5 })).toThrow();
  });

  it('compactDaily rotates older entries into a gz archive and trims the live file', async () => {
    let clock = new Date('2026-05-11T12:00:00.000Z');
    const store = new RecommendationStore({ root, now: () => clock });

    await store.append(
      'NVDA',
      makeRec({ generatedAt: '2026-05-10T10:00:00.000Z' }),
    );
    await store.append(
      'NVDA',
      makeRec({ generatedAt: '2026-05-10T22:00:00.000Z', equity: makeVerdict({ action: 'HOLD', conviction: 0.3, rationale: 'meh' }) }),
    );
    // A "today" entry that must NOT get rotated.
    await store.append('NVDA', makeRec({ generatedAt: '2026-05-11T09:00:00.000Z' }));

    await store.compactDaily();

    const files = await readdir(join(root, 'NVDA'));
    expect(files).toContain('recommendations-2026-05-10.jsonl.gz');

    // Live file should now contain only the 05-11 entry.
    const remaining = await collect(store.readRange('NVDA', new Date('2026-05-11T00:00:00.000Z')));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.generatedAt).toBe('2026-05-11T09:00:00.000Z');

    // Full range still sees all 3 (live + archive).
    const all = await collect(store.readRange('NVDA'));
    expect(all).toHaveLength(3);

    // Idempotent: second compaction is a no-op on this state.
    await store.compactDaily();
    const all2 = await collect(store.readRange('NVDA'));
    expect(all2).toHaveLength(3);

    // And another rotate doesn't double-write the archive.
    clock = new Date('2026-05-12T12:00:00.000Z');
    await store.compactDaily();
    const all3 = await collect(store.readRange('NVDA'));
    expect(all3).toHaveLength(3);
  });

  it('enforces retention by unlinking archives older than the policy window', async () => {
    let clock = new Date('2026-05-10T12:00:00.000Z');
    const store = new RecommendationStore({
      root,
      now: () => clock,
      retention: { recommendations: 7 },
    });

    // Old entry from 30 days ago.
    await store.append('NVDA', makeRec({ generatedAt: '2026-04-10T10:00:00.000Z' }));
    // Recent entry from 2 days ago.
    await store.append('NVDA', makeRec({ generatedAt: '2026-05-08T10:00:00.000Z' }));

    await store.compactDaily();

    const after = await readdir(join(root, 'NVDA'));
    expect(after).toContain('recommendations-2026-05-08.jsonl.gz');
    expect(after).not.toContain('recommendations-2026-04-10.jsonl.gz');
  });

  it('readRange honours since/until bounds', async () => {
    const store = new RecommendationStore({ root });
    await store.append('NVDA', makeRec({ generatedAt: '2026-05-10T10:00:00.000Z' }));
    await store.append('NVDA', makeRec({ generatedAt: '2026-05-11T10:00:00.000Z' }));
    await store.append('NVDA', makeRec({ generatedAt: '2026-05-12T10:00:00.000Z' }));

    const mid = await collect(
      store.readRange(
        'NVDA',
        new Date('2026-05-11T00:00:00.000Z'),
        new Date('2026-05-11T23:59:59.000Z'),
      ),
    );
    expect(mid).toHaveLength(1);
    expect(mid[0]?.generatedAt).toBe('2026-05-11T10:00:00.000Z');
  });
});
