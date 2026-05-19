import {
  createReadStream,
  createWriteStream,
  promises as fs,
} from 'node:fs';
import { open, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { configHome } from '../config/index.js';
import { SentimentSnapshot } from '../schemas/sentiment.js';

/**
 * Snapshot kinds tracked per symbol. Each maps to a separate JSONL stream on disk.
 *
 *  - `quote`   — periodic price quote snapshots (intraday density)
 *  - `options` — options-chain snapshots
 *  - `news`    — news headlines (deduped by url SHA-1 within a 14d window)
 */
export const SnapshotKind = z.enum(['quote', 'options', 'news']);
export type SnapshotKind = z.infer<typeof SnapshotKind>;

/**
 * Every snapshot entry on disk carries an ISO `ts`. `data` is an opaque payload
 * — callers decide the shape, the store just persists and ranges over it.
 */
export const SnapshotEntry = z.object({
  ts: z.string(),
  data: z.unknown(),
});
export type SnapshotEntry = z.infer<typeof SnapshotEntry>;

/**
 * `latest.json` is a small map of the most recent entry per kind for a symbol.
 * It is rewritten atomically (tmp + rename) on every append so a crash leaves
 * either the old or new file fully intact, never a half-written one.
 */
export const LatestSnapshot = z.object({
  symbol: z.string(),
  updatedAt: z.string(),
  entries: z.record(SnapshotEntry).default({}),
  /**
   * Optional aggregate sentiment block, written by `MentionStore`. Added in
   * #31; pre-existing `latest.json` files without this field round-trip fine.
   */
  sentiment: SentimentSnapshot.optional(),
});
export type LatestSnapshot = z.infer<typeof LatestSnapshot>;

/**
 * Retention windows per kind, in **days**. Older daily files are unlinked by
 * `compactDaily`. Defaults follow the issue spec (#21):
 *   quotes 30d, options 7d, news 90d.
 */
export const RetentionPolicy = z.object({
  quote: z.number().int().positive().default(30),
  options: z.number().int().positive().default(7),
  news: z.number().int().positive().default(90),
});
export type RetentionPolicy = z.infer<typeof RetentionPolicy>;

export const DEFAULT_RETENTION: RetentionPolicy = RetentionPolicy.parse({});

/** Default window for news url-hash dedup: 14 days. */
export const NEWS_DEDUP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface SnapshotStoreOptions {
  /** Override snapshots root (tests). Defaults to `{configHome}/snapshots`. */
  root?: string;
  /** Retention windows (days) per kind. */
  retention?: Partial<RetentionPolicy>;
  /** Override clock (tests). */
  now?: () => Date;
  /** Override news dedup window (ms). */
  newsDedupWindowMs?: number;
}

interface AppendOptions {
  /**
   * For news entries, the canonical URL used to compute the dedup hash.
   * If omitted the store will try `entry.data.url` when `data` is an object.
   */
  url?: string;
}

/** Where snapshots live by default. */
export function snapshotsRoot(): string {
  return join(configHome(), 'snapshots');
}

function symbolDir(root: string, symbol: string): string {
  return join(root, symbol.toUpperCase());
}

function jsonlPath(root: string, symbol: string, kind: SnapshotKind): string {
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

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/**
 * Local-only, single-process snapshot store. Writes per-symbol JSONL streams
 * plus an atomically-rewritten `latest.json`. Crash-safe via `O_APPEND` for the
 * stream writes and `fsync + rename` for the latest file. Daily rotation
 * compresses yesterday's file to `{kind}-YYYY-MM-DD.jsonl.gz` and enforces
 * retention.
 */
export class SnapshotStore {
  private readonly root: string;
  private readonly retention: RetentionPolicy;
  private readonly now: () => Date;
  private readonly newsDedupWindowMs: number;
  /** Per-symbol in-memory cache of recent news url hashes -> last seen ts(ms). */
  private readonly newsHashes = new Map<string, Map<string, number>>();
  /** Track which symbols have hydrated their news hash cache from disk. */
  private readonly newsHydrated = new Set<string>();

  constructor(opts: SnapshotStoreOptions = {}) {
    this.root = opts.root ?? snapshotsRoot();
    this.retention = RetentionPolicy.parse({ ...DEFAULT_RETENTION, ...opts.retention });
    this.now = opts.now ?? (() => new Date());
    this.newsDedupWindowMs = opts.newsDedupWindowMs ?? NEWS_DEDUP_WINDOW_MS;
  }

  get rootDir(): string {
    return this.root;
  }

  /**
   * Append a snapshot for `symbol` of `kind` and update `latest.json`.
   *
   * Returns the entry that was written, or `null` when a news entry is dropped
   * by the dedup filter.
   */
  async appendSnapshot(
    symbol: string,
    kind: SnapshotKind,
    entry: SnapshotEntry,
    opts: AppendOptions = {},
  ): Promise<SnapshotEntry | null> {
    const validated = SnapshotEntry.parse(entry);
    const sym = symbol.toUpperCase();
    SnapshotKind.parse(kind);

    if (kind === 'news') {
      const url = opts.url ?? extractUrl(validated.data);
      if (url) {
        const dropped = await this.dedupNews(sym, url, validated.ts);
        if (dropped) return null;
      }
    }

    await mkdir(symbolDir(this.root, sym), { recursive: true });
    await appendJsonl(jsonlPath(this.root, sym, kind), validated);
    await this.writeLatest(sym, kind, validated);
    return validated;
  }

  /** Read the per-symbol `latest.json` map, or an empty record if missing. */
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
   * Async-iterate entries for a kind in `[since, until]` (inclusive). Streams
   * the live JSONL file and any `*.jsonl.gz` daily archives that fall in range.
   * Both bounds default to "all of time".
   */
  async *readRange(
    symbol: string,
    kind: SnapshotKind,
    since?: Date,
    until?: Date,
  ): AsyncGenerator<SnapshotEntry, void, void> {
    SnapshotKind.parse(kind);
    const sym = symbol.toUpperCase();
    const dir = symbolDir(this.root, sym);
    const sinceMs = since?.getTime() ?? -Infinity;
    const untilMs = until?.getTime() ?? Infinity;

    let archives: string[] = [];
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
          // Each archive holds entries for a single UTC day; keep it if that
          // day overlaps the requested window.
          const dayStart = x.date.getTime();
          const dayEnd = dayStart + 24 * 60 * 60 * 1000 - 1;
          return dayEnd >= sinceMs && dayStart <= untilMs;
        })
        .sort((a, b) => a.date.getTime() - b.date.getTime())
        .map((x) => join(dir, x.name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }

    for (const archive of archives) {
      for await (const e of readJsonlGz(archive)) {
        const t = Date.parse(e.ts);
        if (!isNaN(t) && t >= sinceMs && t <= untilMs) yield e;
      }
    }

    const live = jsonlPath(this.root, sym, kind);
    for await (const e of readJsonlPlain(live)) {
      const t = Date.parse(e.ts);
      if (!isNaN(t) && t >= sinceMs && t <= untilMs) yield e;
    }
  }

  /**
   * Roll any JSONL entries dated before *today (UTC)* into per-day `.jsonl.gz`
   * archives, then enforce the retention policy by unlinking archives older
   * than the per-kind window.
   *
   * Safe to call repeatedly; entries already archived for a given day are
   * appended-once and then dropped from the live file.
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
      for (const kind of SnapshotKind.options) {
        await this.rotateKind(dir, kind, today);
        await this.enforceRetention(dir, kind);
      }
    }
  }

  // ------- internals -------

  private async writeLatest(symbol: string, kind: SnapshotKind, entry: SnapshotEntry): Promise<void> {
    const cur = await this.readLatest(symbol);
    const next: LatestSnapshot = {
      symbol,
      updatedAt: this.now().toISOString(),
      entries: { ...cur.entries, [kind]: entry },
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

  private async dedupNews(symbol: string, url: string, tsIso: string): Promise<boolean> {
    const cache = await this.loadNewsHashes(symbol);
    const hash = sha1(url);
    const tsMs = Date.parse(tsIso);
    const nowMs = isNaN(tsMs) ? this.now().getTime() : tsMs;
    const cutoff = nowMs - this.newsDedupWindowMs;
    // Sweep stale entries opportunistically.
    for (const [h, t] of cache) if (t < cutoff) cache.delete(h);
    const prev = cache.get(hash);
    if (prev !== undefined && prev >= cutoff) return true;
    cache.set(hash, nowMs);
    return false;
  }

  private async loadNewsHashes(symbol: string): Promise<Map<string, number>> {
    let cache = this.newsHashes.get(symbol);
    if (!cache) {
      cache = new Map();
      this.newsHashes.set(symbol, cache);
    }
    if (this.newsHydrated.has(symbol)) return cache;
    this.newsHydrated.add(symbol);

    const cutoff = this.now().getTime() - this.newsDedupWindowMs;
    // Only the live file matters: archived news entries are older than today
    // and either already inside or outside the 14d window via their own ts.
    const live = jsonlPath(this.root, symbol, 'news');
    for await (const e of readJsonlPlain(live)) {
      const url = extractUrl(e.data);
      if (!url) continue;
      const t = Date.parse(e.ts);
      if (isNaN(t) || t < cutoff) continue;
      cache.set(sha1(url), t);
    }
    return cache;
  }

  private async rotateKind(dir: string, kind: SnapshotKind, today: string): Promise<void> {
    const live = join(dir, `${kind}.jsonl`);
    const exists = await stat(live).catch(() => null);
    if (!exists) return;

    // Bucket live entries by UTC day.
    const byDay = new Map<string, SnapshotEntry[]>();
    const remainder: SnapshotEntry[] = [];
    for await (const e of readJsonlPlain(live)) {
      const t = Date.parse(e.ts);
      if (isNaN(t)) {
        remainder.push(e);
        continue;
      }
      const day = ymd(new Date(t));
      if (day >= today) {
        remainder.push(e);
      } else {
        const arr = byDay.get(day) ?? [];
        arr.push(e);
        byDay.set(day, arr);
      }
    }
    if (byDay.size === 0) return;

    for (const [day, entries] of byDay) {
      const archive = join(dir, `${kind}-${day}.jsonl.gz`);
      await appendGzippedJsonl(archive, entries);
    }

    // Rewrite the live file with what's left (atomic via tmp + rename).
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

  private async enforceRetention(dir: string, kind: SnapshotKind): Promise<void> {
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
      // Drop archives whose *end of day* is before the cutoff.
      const dayEndMs = d.getTime() + 24 * 60 * 60 * 1000 - 1;
      if (dayEndMs < cutoffMs) {
        await unlink(join(dir, n)).catch(() => undefined);
      }
    }
  }
}

function extractUrl(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'url' in data) {
    const u = (data as { url: unknown }).url;
    if (typeof u === 'string' && u.length > 0) return u;
  }
  return undefined;
}

async function appendJsonl(path: string, entry: SnapshotEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // O_APPEND for atomic single-line appends on POSIX. We don't fsync per append
  // (that would crater throughput); rotation/compaction does its own fsync.
  const fh = await open(path, 'a', 0o600);
  try {
    await fh.writeFile(JSON.stringify(entry) + '\n', 'utf8');
  } finally {
    await fh.close();
  }
}

async function* readJsonlPlain(path: string): AsyncGenerator<SnapshotEntry, void, void> {
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
        yield SnapshotEntry.parse(JSON.parse(line));
      } catch {
        // Skip malformed lines rather than crash the reader.
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
}

async function* readJsonlGz(path: string): AsyncGenerator<SnapshotEntry, void, void> {
  const { createGunzip } = await import('node:zlib');
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
      yield SnapshotEntry.parse(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
}

async function appendGzippedJsonl(path: string, entries: SnapshotEntry[]): Promise<void> {
  // Append-safe gzip: gzip members are independently concatenable, so we can
  // stream a fresh member onto the existing archive without rewriting it.
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
  // Fsync the archive after rotation so a crash mid-rotate can't lose
  // already-written-but-still-buffered bytes.
  const fh = await open(path, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Re-export node fs to keep the module surface tidy for tests if needed.
export const __test__ = { fs };
