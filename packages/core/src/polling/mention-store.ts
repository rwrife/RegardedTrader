import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createGzip, createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { configHome } from '../config/index.js';
import {
  MentionItem,
  ScoredMention,
  SentimentSnapshot,
  SentimentSource,
} from '../schemas/sentiment.js';
import { LatestSnapshot } from './store.js';

/**
 * Retention windows (in **days**) for the two streams the `MentionStore`
 * writes. Defaults follow the issue spec (#31): mentions 30d, sentiment 90d.
 * Both are overridable via the polling config (#26).
 */
export const MentionRetentionPolicy = z.object({
  mentions: z.number().int().positive().default(30),
  sentiment: z.number().int().positive().default(90),
});
export type MentionRetentionPolicy = z.infer<typeof MentionRetentionPolicy>;

export const DEFAULT_MENTION_RETENTION: MentionRetentionPolicy =
  MentionRetentionPolicy.parse({});

/**
 * Kinds tracked by the `MentionStore`. Distinct from the `SnapshotKind`
 * enum so the two stores can evolve independently (mentions are alt-data,
 * not market data).
 */
export const MentionKind = z.enum(['mentions', 'sentiment']);
export type MentionKind = z.infer<typeof MentionKind>;

export interface MentionStoreOptions {
  /** Override snapshots root (tests). Defaults to `{configHome}/snapshots`. */
  root?: string;
  /** Retention windows (days) per stream. */
  retention?: Partial<MentionRetentionPolicy>;
  /** Override clock (tests). */
  now?: () => Date;
}

export function snapshotsRoot(): string {
  return join(configHome(), 'snapshots');
}

function symbolDir(root: string, symbol: string): string {
  return join(root, symbol.toUpperCase());
}

function streamPath(root: string, symbol: string, kind: MentionKind): string {
  return join(symbolDir(root, symbol), `${kind}.jsonl`);
}

function latestPath(root: string, symbol: string): string {
  return join(symbolDir(root, symbol), 'latest.json');
}

function ymd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return isNaN(d.getTime()) ? null : d;
}

function dedupKey(source: SentimentSource, sourceId: string): string {
  return `${source}\u0000${sourceId}`;
}

/**
 * Local-only mention + sentiment store. Mirrors the conventions of
 * `SnapshotStore` (per-symbol JSONL streams, atomic `latest.json`,
 * `*.jsonl.gz` daily archives, retention) but persists alt-data shapes:
 *
 *   - `mentions.jsonl`   — raw `MentionItem` entries, deduped by
 *                          `(source, sourceId)` across a rolling window.
 *   - `sentiment.jsonl`  — `SentimentSnapshot` entries (one per aggregator run).
 *
 * Authors / usernames are never persisted: the `MentionItem` schema has no
 * field for them, and the store's `appendMention` runs the input through
 * `MentionItem.parse` which strips unknown keys.
 */
export class MentionStore {
  private readonly root: string;
  private readonly retention: MentionRetentionPolicy;
  private readonly now: () => Date;
  /** Per-symbol in-memory dedup cache: dedupKey -> last seen ts(ms). */
  private readonly dedupCache = new Map<string, Map<string, number>>();
  /** Track which symbols have hydrated their dedup cache from disk. */
  private readonly hydrated = new Set<string>();

  constructor(opts: MentionStoreOptions = {}) {
    this.root = opts.root ?? snapshotsRoot();
    this.retention = MentionRetentionPolicy.parse({
      ...DEFAULT_MENTION_RETENTION,
      ...opts.retention,
    });
    this.now = opts.now ?? (() => new Date());
  }

  get rootDir(): string {
    return this.root;
  }

  /**
   * Append a raw mention for `symbol`. Returns the persisted entry, or `null`
   * if the entry was dropped by the dedup filter. The dedup window is the
   * `mentions` retention window.
   */
  async appendMention(mention: MentionItem): Promise<MentionItem | null> {
    const validated = MentionItem.parse(mention);
    const sym = validated.symbol;
    const cache = await this.loadDedupCache(sym);
    const key = dedupKey(validated.source, validated.sourceId);
    const tsMs = Date.parse(validated.publishedAt);
    const nowMs = isNaN(tsMs) ? this.now().getTime() : tsMs;
    const cutoff = nowMs - this.retention.mentions * 24 * 60 * 60 * 1000;
    // Sweep stale entries opportunistically.
    for (const [k, t] of cache) if (t < cutoff) cache.delete(k);
    const prev = cache.get(key);
    if (prev !== undefined && prev >= cutoff) return null;
    cache.set(key, nowMs);

    await mkdir(symbolDir(this.root, sym), { recursive: true });
    await appendJsonl(streamPath(this.root, sym, 'mentions'), validated);
    return validated;
  }

  /** Append a scored mention. Does *not* dedup (scoring may be re-run). */
  async appendScoredMention(scored: ScoredMention): Promise<ScoredMention> {
    const validated = ScoredMention.parse(scored);
    const sym = validated.symbol;
    await mkdir(symbolDir(this.root, sym), { recursive: true });
    await appendJsonl(streamPath(this.root, sym, 'mentions'), validated);
    return validated;
  }

  /**
   * Append a `SentimentSnapshot` aggregate and mirror it into `latest.json`
   * under the `sentiment` field.
   */
  async appendSentiment(snapshot: SentimentSnapshot): Promise<SentimentSnapshot> {
    const validated = SentimentSnapshot.parse(snapshot);
    const sym = validated.symbol;
    await mkdir(symbolDir(this.root, sym), { recursive: true });
    await appendJsonl(streamPath(this.root, sym, 'sentiment'), validated);
    await this.writeLatestSentiment(sym, validated);
    return validated;
  }

  /** Read the per-symbol `latest.json`, or a fresh skeleton if missing. */
  async readLatest(symbol: string): Promise<LatestSnapshot> {
    const sym = symbol.toUpperCase();
    const p = latestPath(this.root, sym);
    try {
      const raw = await readFile(p, 'utf8');
      return LatestSnapshot.parse(JSON.parse(raw));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { symbol: sym, updatedAt: new Date(0).toISOString(), entries: {} };
      }
      throw e;
    }
  }

  /**
   * Stream mentions for `symbol` in `[since, until]` (inclusive). Yields both
   * raw `MentionItem`s and `ScoredMention`s (the latter is a superset shape).
   */
  async *readMentions(
    symbol: string,
    since?: Date,
    until?: Date,
  ): AsyncGenerator<MentionItem | ScoredMention, void, void> {
    yield* this.readStream(symbol, 'mentions', since, until, (raw) => {
      // Prefer ScoredMention when the row actually has a sentiment block.
      if (raw && typeof raw === 'object' && 'sentiment' in raw) {
        const r = ScoredMention.safeParse(raw);
        if (r.success) return r.data;
      }
      const m = MentionItem.safeParse(raw);
      return m.success ? m.data : undefined;
    });
  }

  /** Stream `SentimentSnapshot` entries for `symbol` in `[since, until]`. */
  async *readSentiment(
    symbol: string,
    since?: Date,
    until?: Date,
  ): AsyncGenerator<SentimentSnapshot, void, void> {
    yield* this.readStream(symbol, 'sentiment', since, until, (raw) => {
      const r = SentimentSnapshot.safeParse(raw);
      return r.success ? r.data : undefined;
    });
  }

  /**
   * Roll any entries dated before *today (UTC)* into per-day `.jsonl.gz`
   * archives and enforce retention. Safe to call repeatedly.
   */
  async compactDaily(): Promise<void> {
    const today = ymd(this.now());
    let symbols: string[] = [];
    try {
      symbols = await readdir(this.root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    for (const sym of symbols) {
      const dir = join(this.root, sym);
      const s = await stat(dir).catch(() => null);
      if (!s?.isDirectory()) continue;
      for (const kind of MentionKind.options) {
        await this.rotateKind(dir, kind, today);
        await this.enforceRetention(dir, kind);
      }
    }
  }

  // ------- internals -------

  private async *readStream<T>(
    symbol: string,
    kind: MentionKind,
    since: Date | undefined,
    until: Date | undefined,
    parse: (raw: unknown) => T | undefined,
  ): AsyncGenerator<T, void, void> {
    const sym = symbol.toUpperCase();
    const dir = symbolDir(this.root, sym);
    const sinceMs = since?.getTime() ?? -Infinity;
    const untilMs = until?.getTime() ?? Infinity;

    let archives: Array<{ name: string; date: Date }> = [];
    try {
      const all = await readdir(dir);
      archives = all
        .filter((n) => n.startsWith(`${kind}-`) && n.endsWith('.jsonl.gz'))
        .map((n) => {
          const stamp = n.slice(kind.length + 1, n.length - '.jsonl.gz'.length);
          return { name: n, date: parseYmd(stamp) };
        })
        .filter((x): x is { name: string; date: Date } => x.date !== null)
        .filter((x) => {
          const dayStart = x.date.getTime();
          const dayEnd = dayStart + 24 * 60 * 60 * 1000 - 1;
          return dayEnd >= sinceMs && dayStart <= untilMs;
        })
        .sort((a, b) => a.date.getTime() - b.date.getTime());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }

    for (const a of archives) {
      for await (const raw of readJsonlGz(join(dir, a.name))) {
        const ts = extractTs(raw);
        if (ts !== undefined && (ts < sinceMs || ts > untilMs)) continue;
        const v = parse(raw);
        if (v !== undefined) yield v;
      }
    }

    const live = streamPath(this.root, sym, kind);
    for await (const raw of readJsonlPlain(live)) {
      const ts = extractTs(raw);
      if (ts !== undefined && (ts < sinceMs || ts > untilMs)) continue;
      const v = parse(raw);
      if (v !== undefined) yield v;
    }
  }

  private async writeLatestSentiment(
    symbol: string,
    sentiment: SentimentSnapshot,
  ): Promise<void> {
    const cur = await this.readLatest(symbol);
    const next: LatestSnapshot = {
      symbol,
      updatedAt: this.now().toISOString(),
      entries: cur.entries,
      sentiment,
    };
    const p = latestPath(this.root, symbol);
    const tmp = `${p}.tmp`;
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify(next, null, 2), 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, p);
  }

  private async loadDedupCache(symbol: string): Promise<Map<string, number>> {
    let cache = this.dedupCache.get(symbol);
    if (!cache) {
      cache = new Map();
      this.dedupCache.set(symbol, cache);
    }
    if (this.hydrated.has(symbol)) return cache;
    this.hydrated.add(symbol);

    const cutoff =
      this.now().getTime() - this.retention.mentions * 24 * 60 * 60 * 1000;
    const live = streamPath(this.root, symbol, 'mentions');
    for await (const raw of readJsonlPlain(live)) {
      const parsed = MentionItem.safeParse(raw);
      if (!parsed.success) continue;
      const t = Date.parse(parsed.data.publishedAt);
      if (isNaN(t) || t < cutoff) continue;
      cache.set(dedupKey(parsed.data.source, parsed.data.sourceId), t);
    }
    return cache;
  }

  private async rotateKind(
    dir: string,
    kind: MentionKind,
    today: string,
  ): Promise<void> {
    const live = join(dir, `${kind}.jsonl`);
    const exists = await stat(live).catch(() => null);
    if (!exists) return;

    const byDay = new Map<string, unknown[]>();
    const remainder: unknown[] = [];
    for await (const raw of readJsonlPlain(live)) {
      const ts = extractTs(raw);
      if (ts === undefined) {
        remainder.push(raw);
        continue;
      }
      const day = ymd(new Date(ts));
      if (day >= today) {
        remainder.push(raw);
      } else {
        const arr = byDay.get(day) ?? [];
        arr.push(raw);
        byDay.set(day, arr);
      }
    }
    if (byDay.size === 0) return;

    for (const [day, entries] of byDay) {
      const archive = join(dir, `${kind}-${day}.jsonl.gz`);
      await appendGzippedJsonl(archive, entries);
    }

    const tmp = `${live}.tmp`;
    const fh = await open(tmp, 'w', 0o600);
    try {
      for (const e of remainder) {
        await fh.writeFile(JSON.stringify(e) + '\n', 'utf8');
      }
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, live);
  }

  private async enforceRetention(dir: string, kind: MentionKind): Promise<void> {
    const windowDays = this.retention[kind];
    const cutoffMs = this.now().getTime() - windowDays * 24 * 60 * 60 * 1000;
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.startsWith(`${kind}-`) || !n.endsWith('.jsonl.gz')) continue;
      const stamp = n.slice(kind.length + 1, n.length - '.jsonl.gz'.length);
      const d = parseYmd(stamp);
      if (!d) continue;
      const dayEndMs = d.getTime() + 24 * 60 * 60 * 1000 - 1;
      if (dayEndMs < cutoffMs) {
        await unlink(join(dir, n)).catch(() => undefined);
      }
    }
  }
}

function extractTs(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const candidate =
    typeof obj.publishedAt === 'string'
      ? obj.publishedAt
      : typeof obj.asOf === 'string'
        ? obj.asOf
        : typeof obj.fetchedAt === 'string'
          ? obj.fetchedAt
          : undefined;
  if (candidate === undefined) return undefined;
  const t = Date.parse(candidate);
  return isNaN(t) ? undefined : t;
}

async function appendJsonl(path: string, entry: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const fh = await open(path, 'a', 0o600);
  try {
    await fh.writeFile(JSON.stringify(entry) + '\n', 'utf8');
  } finally {
    await fh.close();
  }
}

async function* readJsonlPlain(path: string): AsyncGenerator<unknown, void, void> {
  let stream;
  try {
    stream = createReadStream(path, { encoding: 'utf8' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  try {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // skip malformed lines
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
}

async function* readJsonlGz(path: string): AsyncGenerator<unknown, void, void> {
  let stream;
  try {
    stream = createReadStream(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  const gunzip = stream.pipe(createGunzip());
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      /* skip */
    }
  }
}

async function appendGzippedJsonl(path: string, entries: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(path, { flags: 'a', mode: 0o600 });
    const gz = createGzip();
    gz.pipe(out);
    out.on('close', resolve);
    out.on('error', reject);
    gz.on('error', reject);
    for (const e of entries) gz.write(JSON.stringify(e) + '\n');
    gz.end();
  });
  const fh = await open(path, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}
