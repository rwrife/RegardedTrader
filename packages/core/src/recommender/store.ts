import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { configHome } from '../config/index.js';
import { Recommendation } from '../schemas/recommendation.js';
import { LatestSnapshot, snapshotsRoot } from '../polling/store.js';

/**
 * Retention window for recommendation history, in days. Default 365 — we keep
 * a year so future evaluation tooling (#54) can score how often a BUY/SELL
 * verdict was right.
 */
export const RecommendationRetentionPolicy = z.object({
  recommendations: z.number().int().positive().default(365),
});
export type RecommendationRetentionPolicy = z.infer<typeof RecommendationRetentionPolicy>;

export const DEFAULT_RECOMMENDATION_RETENTION: RecommendationRetentionPolicy =
  RecommendationRetentionPolicy.parse({});

export interface RecommendationStoreOptions {
  /** Override snapshots root (tests). Defaults to `{configHome}/snapshots`. */
  root?: string;
  /** Retention window in days. */
  retention?: Partial<RecommendationRetentionPolicy>;
  /** Override clock (tests). */
  now?: () => Date;
}

function symbolDir(root: string, symbol: string): string {
  return join(root, symbol.toUpperCase());
}

function jsonlPath(root: string, symbol: string): string {
  return join(symbolDir(root, symbol), 'recommendations.jsonl');
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

/**
 * Append-only recommendation history, one JSONL stream per symbol, with the
 * latest entry mirrored into the shared `latest.json` under the existing
 * `snapshots/{SYMBOL}/` tree owned by `SnapshotStore` (#21).
 *
 * Mirrors the durability story of `SnapshotStore`:
 *   - `O_APPEND` for atomic single-line appends.
 *   - `tmp + fsync + rename` for the latest mirror.
 *   - Daily rotation into `recommendations-YYYY-MM-DD.jsonl.gz` archives.
 *   - Retention enforcement unlinks archives older than the policy window
 *     (365 days by default).
 *
 * Recommendations are persisted as full history — we never overwrite past
 * verdicts, so a future eval harness can replay them against realized prices.
 */
export class RecommendationStore {
  private readonly root: string;
  private readonly retention: RecommendationRetentionPolicy;
  private readonly now: () => Date;

  constructor(opts: RecommendationStoreOptions = {}) {
    this.root = opts.root ?? snapshotsRoot();
    this.retention = RecommendationRetentionPolicy.parse({
      ...DEFAULT_RECOMMENDATION_RETENTION,
      ...opts.retention,
    });
    this.now = opts.now ?? (() => new Date());
  }

  get rootDir(): string {
    return this.root;
  }

  /**
   * Append a recommendation for `symbol` and mirror it into `latest.json`.
   * Returns the parsed `Recommendation` that was written.
   */
  async append(symbol: string, rec: Recommendation): Promise<Recommendation> {
    const validated = Recommendation.parse(rec);
    const sym = symbol.toUpperCase();
    // The schema's `symbol` and the directory we write to must agree; using
    // the canonical uppercased form on disk keeps the store consistent with
    // SnapshotStore even if the caller passes a mixed-case symbol.
    const normalized: Recommendation = { ...validated, symbol: sym };

    await mkdir(symbolDir(this.root, sym), { recursive: true });
    await appendJsonl(jsonlPath(this.root, sym), normalized);
    await this.writeLatest(sym, normalized);
    return normalized;
  }

  /** Read the latest recommendation for a symbol, or `null` when missing. */
  async readLatest(symbol: string): Promise<Recommendation | null> {
    const sym = symbol.toUpperCase();
    const p = latestPath(this.root, sym);
    try {
      const raw = await readFile(p, 'utf8');
      const parsed = LatestSnapshot.parse(JSON.parse(raw));
      return parsed.recommendation ?? null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  /**
   * Async-iterate recommendations in `[since, until]` (inclusive). Streams the
   * live JSONL file plus any `*.jsonl.gz` daily archives whose UTC day
   * overlaps the range. Bounds default to "all of time".
   */
  async *readRange(
    symbol: string,
    since?: Date,
    until?: Date,
  ): AsyncGenerator<Recommendation, void, void> {
    const sym = symbol.toUpperCase();
    const dir = symbolDir(this.root, sym);
    const sinceMs = since?.getTime() ?? -Infinity;
    const untilMs = until?.getTime() ?? Infinity;

    let archives: Array<{ name: string; date: Date }> = [];
    try {
      const all = await readdir(dir);
      archives = all
        .filter((n) => n.startsWith('recommendations-') && n.endsWith('.jsonl.gz'))
        .map((n) => {
          const stamp = n.slice('recommendations-'.length, n.length - '.jsonl.gz'.length);
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
      for await (const r of readJsonlGz(join(dir, a.name))) {
        const t = Date.parse(r.generatedAt);
        if (!isNaN(t) && t >= sinceMs && t <= untilMs) yield r;
      }
    }

    for await (const r of readJsonlPlain(jsonlPath(this.root, sym))) {
      const t = Date.parse(r.generatedAt);
      if (!isNaN(t) && t >= sinceMs && t <= untilMs) yield r;
    }
  }

  /**
   * Rotate any entries dated before *today (UTC)* out of the live JSONL into
   * per-day `.jsonl.gz` archives, then enforce the retention window.
   *
   * Safe to call repeatedly: entries already archived for a given day are
   * appended-once (gzip members concatenate) and dropped from the live file.
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
      await this.rotate(dir, today);
      await this.enforceRetention(dir);
    }
  }

  // ------- internals -------

  private async writeLatest(symbol: string, rec: Recommendation): Promise<void> {
    const p = latestPath(this.root, symbol);
    let cur: LatestSnapshot;
    try {
      const raw = await readFile(p, 'utf8');
      cur = LatestSnapshot.parse(JSON.parse(raw));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      cur = { symbol, updatedAt: new Date(0).toISOString(), entries: {} };
    }
    const next: LatestSnapshot = {
      ...cur,
      symbol,
      updatedAt: this.now().toISOString(),
      entries: cur.entries ?? {},
      recommendation: rec,
    };
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

  private async rotate(dir: string, today: string): Promise<void> {
    const live = join(dir, 'recommendations.jsonl');
    const exists = await stat(live).catch(() => null);
    if (!exists) return;

    const byDay = new Map<string, Recommendation[]>();
    const remainder: Recommendation[] = [];
    for await (const r of readJsonlPlain(live)) {
      const t = Date.parse(r.generatedAt);
      if (isNaN(t)) {
        remainder.push(r);
        continue;
      }
      const day = ymd(new Date(t));
      if (day >= today) {
        remainder.push(r);
      } else {
        const arr = byDay.get(day) ?? [];
        arr.push(r);
        byDay.set(day, arr);
      }
    }
    if (byDay.size === 0) return;

    for (const [day, recs] of byDay) {
      const archive = join(dir, `recommendations-${day}.jsonl.gz`);
      await appendGzippedJsonl(archive, recs);
    }

    const tmp = `${live}.tmp`;
    const fh = await open(tmp, 'w', 0o600);
    try {
      for (const r of remainder) {
        await fh.writeFile(JSON.stringify(r) + '\n', 'utf8');
      }
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, live);
  }

  private async enforceRetention(dir: string): Promise<void> {
    const windowDays = this.retention.recommendations;
    const cutoffMs = this.now().getTime() - windowDays * 24 * 60 * 60 * 1000;
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.startsWith('recommendations-') || !n.endsWith('.jsonl.gz')) continue;
      const stamp = n.slice('recommendations-'.length, n.length - '.jsonl.gz'.length);
      const d = parseYmd(stamp);
      if (!d) continue;
      const dayEndMs = d.getTime() + 24 * 60 * 60 * 1000 - 1;
      if (dayEndMs < cutoffMs) {
        await unlink(join(dir, n)).catch(() => undefined);
      }
    }
  }
}

async function appendJsonl(path: string, rec: Recommendation): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const fh = await open(path, 'a', 0o600);
  try {
    await fh.writeFile(JSON.stringify(rec) + '\n', 'utf8');
  } finally {
    await fh.close();
  }
}

async function* readJsonlPlain(path: string): AsyncGenerator<Recommendation, void, void> {
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
        yield Recommendation.parse(JSON.parse(line));
      } catch {
        // Skip malformed lines rather than crash the reader.
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
}

async function* readJsonlGz(path: string): AsyncGenerator<Recommendation, void, void> {
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
      yield Recommendation.parse(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
}

async function appendGzippedJsonl(path: string, recs: Recommendation[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(path, { flags: 'a', mode: 0o600 });
    const gz = createGzip();
    gz.pipe(out);
    out.on('close', resolve);
    out.on('error', reject);
    gz.on('error', reject);
    for (const r of recs) gz.write(JSON.stringify(r) + '\n');
    gz.end();
  });
  const fh = await open(path, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}
