import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configHome } from '../config/index.js';
import { TickerProfile } from '../schemas/ticker.js';
import { TickerResolver, TickerResolutionError } from './resolver.js';

/** Default TTL for full company metadata (per issue #15: 30 days). */
export const PROFILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Default TTL for the "symbol exists" layer (per issue #15: 24h).
 *
 * This is intentionally separate from the profile TTL: even when the rich
 * company metadata is still fresh (30d), we re-validate that the symbol is
 * still listed/tradable on a 24h cadence. Listings change (delistings, merger
 * tickers, etc.) far more often than company descriptions do.
 */
export const EXISTENCE_TTL_MS = 24 * 60 * 60 * 1000;

/** LRU capacity in front of disk, per issue #15. */
export const DEFAULT_LRU_SIZE = 256;

/**
 * Filename for `SYMBOL`. Symbols are uppercased and may contain `.` or `-`
 * (BRK.B, RDS-A); strip anything else just in case to keep the on-disk
 * footprint safe.
 */
function fileFor(dir: string, symbol: string): string {
  const safe = symbol.toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
  if (safe.length === 0) throw new Error(`unsafe symbol: ${symbol}`);
  return join(dir, `${safe}.json`);
}

function symbolFromFilename(name: string): string | null {
  if (!name.endsWith('.json')) return null;
  const stem = name.slice(0, -'.json'.length);
  if (!/^[A-Z0-9.\-]{1,10}$/.test(stem)) return null;
  return stem;
}

interface LRUNode {
  symbol: string;
  profile: TickerProfile;
}

/** Tiny insertion-order LRU. Map preserves insertion order in JS. */
class LRU {
  private readonly map = new Map<string, LRUNode>();
  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error('LRU capacity must be > 0');
  }
  get size(): number {
    return this.map.size;
  }
  get(symbol: string): TickerProfile | undefined {
    const node = this.map.get(symbol);
    if (!node) return undefined;
    // bump to most-recent
    this.map.delete(symbol);
    this.map.set(symbol, node);
    return node.profile;
  }
  set(symbol: string, profile: TickerProfile): void {
    if (this.map.has(symbol)) {
      this.map.delete(symbol);
    } else if (this.map.size >= this.capacity) {
      // evict oldest
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(symbol, { symbol, profile });
  }
  delete(symbol: string): boolean {
    return this.map.delete(symbol);
  }
  clear(): void {
    this.map.clear();
  }
}

export interface TickerStoreOptions {
  /** Override directory (tests). Defaults to `<configHome>/tickers`. */
  dir?: string;
  /** Override the full-profile TTL. Defaults to 30 days. */
  profileTtlMs?: number;
  /** Override the symbol-existence TTL. Defaults to 24h. */
  existenceTtlMs?: number;
  /** LRU capacity. Defaults to 256. */
  lruSize?: number;
  /** Clock injection. */
  now?: () => Date;
}

export interface GetOrResolveOptions {
  /** Bypass cache (LRU + disk) and re-resolve from sources. */
  force?: boolean;
}

/** What `getOrResolve` returns alongside the profile, for diagnostics. */
export interface ResolveOutcome {
  profile: TickerProfile;
  /** Where the returned profile came from. */
  source: 'lru' | 'disk' | 'resolver';
  /** True if the profile metadata is older than `profileTtlMs`. */
  metadataStale: boolean;
  /** True if the cached profile predates the 24h existence TTL. */
  existenceStale: boolean;
}

/**
 * On-disk + in-memory cache for resolved `TickerProfile`s.
 *
 * Per issue #15:
 *  - Persists records to `~/.regardedtrader/tickers/{SYMBOL}.json` with
 *    `chmod 600`.
 *  - 256-entry LRU in front of disk.
 *  - 30d TTL on the company metadata; 24h TTL on the "does this symbol still
 *    exist" layer.
 *  - `getOrResolve(input, { force })` is the surface entry point.
 *  - List/remove operations for watchlist surfaces.
 *
 * This is a local single-user store (see AGENTS.md "Hard Rules" — no
 * multi-process locking is needed; rename-based atomic writes are enough).
 */
export class TickerStore {
  private readonly dir: string;
  private readonly profileTtlMs: number;
  private readonly existenceTtlMs: number;
  private readonly lru: LRU;
  private readonly now: () => Date;

  constructor(opts: TickerStoreOptions = {}) {
    this.dir = opts.dir ?? join(configHome(), 'tickers');
    this.profileTtlMs = opts.profileTtlMs ?? PROFILE_TTL_MS;
    this.existenceTtlMs = opts.existenceTtlMs ?? EXISTENCE_TTL_MS;
    this.lru = new LRU(opts.lruSize ?? DEFAULT_LRU_SIZE);
    this.now = opts.now ?? (() => new Date());
  }

  get directory(): string {
    return this.dir;
  }

  /** Read a profile from LRU, then disk. Returns `undefined` if absent. */
  async get(symbol: string): Promise<TickerProfile | undefined> {
    const sym = symbol.toUpperCase();
    const cached = this.lru.get(sym);
    if (cached) return cached;
    const fromDisk = await this.readDisk(sym);
    if (fromDisk) this.lru.set(sym, fromDisk);
    return fromDisk;
  }

  /** List every cached profile, sorted by symbol. */
  async list(): Promise<TickerProfile[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: TickerProfile[] = [];
    for (const name of names) {
      const sym = symbolFromFilename(name);
      if (!sym) continue;
      const p = await this.readDisk(sym);
      if (p) out.push(p);
    }
    out.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return out;
  }

  /** Remove a profile from LRU and disk. Returns whether something was deleted. */
  async remove(symbol: string): Promise<boolean> {
    const sym = symbol.toUpperCase();
    this.lru.delete(sym);
    try {
      await unlink(fileFor(this.dir, sym));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }

  /** Write a profile through the cache. */
  async put(profile: TickerProfile): Promise<TickerProfile> {
    const validated = TickerProfile.parse(profile);
    await this.writeDisk(validated);
    this.lru.set(validated.symbol, validated);
    return validated;
  }

  /** True if `validatedAt` is older than the metadata TTL. */
  isMetadataStale(profile: TickerProfile): boolean {
    return this.age(profile) > this.profileTtlMs;
  }

  /** True if `validatedAt` is older than the 24h existence TTL. */
  isExistenceStale(profile: TickerProfile): boolean {
    return this.age(profile) > this.existenceTtlMs;
  }

  /**
   * Look up `input` in cache; if missing, stale, or `force` is set, fall back
   * to `resolver.resolve(input)` and write the new profile through the cache.
   *
   * "Stale" here means the *existence* layer is past its 24h TTL — we
   * re-validate listing existence on that cadence even if the rest of the
   * metadata is still inside its 30d window. Callers that only care about
   * the metadata freshness can inspect `metadataStale` on the returned
   * outcome.
   */
  async getOrResolve(
    input: string,
    resolver: Pick<TickerResolver, 'resolve'>,
    opts: GetOrResolveOptions = {},
  ): Promise<ResolveOutcome> {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      throw new TickerResolutionError('empty input', input, []);
    }

    // Only attempt cache hits if the input *looks* like a symbol — name
    // queries ("apple inc") have to round-trip through the resolver. We
    // still rely on the resolver's canonical symbol output when caching.
    const looksLikeSymbol = /^[A-Z.\-]{1,10}$/i.test(trimmed);
    const lookupSymbol = looksLikeSymbol ? trimmed.toUpperCase() : null;

    if (!opts.force && lookupSymbol !== null) {
      const lruHit = this.lru.get(lookupSymbol);
      if (lruHit && !this.isExistenceStale(lruHit)) {
        return {
          profile: lruHit,
          source: 'lru',
          metadataStale: this.isMetadataStale(lruHit),
          existenceStale: false,
        };
      }
      const diskHit = await this.readDisk(lookupSymbol);
      if (diskHit) {
        this.lru.set(lookupSymbol, diskHit);
        if (!this.isExistenceStale(diskHit)) {
          return {
            profile: diskHit,
            source: 'disk',
            metadataStale: this.isMetadataStale(diskHit),
            existenceStale: false,
          };
        }
      }
    }

    const resolved = await resolver.resolve(trimmed);
    await this.put(resolved);
    return {
      profile: resolved,
      source: 'resolver',
      metadataStale: false,
      existenceStale: false,
    };
  }

  // --- internals -----------------------------------------------------------

  private age(profile: TickerProfile): number {
    const at = Date.parse(profile.validatedAt);
    if (Number.isNaN(at)) return Number.POSITIVE_INFINITY;
    return this.now().getTime() - at;
  }

  private async readDisk(symbol: string): Promise<TickerProfile | undefined> {
    const path = fileFor(this.dir, symbol);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      // Corrupt JSON — back it up and treat as a miss.
      await this.quarantine(path);
      return undefined;
    }
    const parsed = TickerProfile.safeParse(json);
    if (!parsed.success) {
      await this.quarantine(path);
      return undefined;
    }
    if (parsed.data.symbol !== symbol) {
      // Filename/content mismatch — also a corruption signal.
      await this.quarantine(path);
      return undefined;
    }
    return parsed.data;
  }

  private async writeDisk(profile: TickerProfile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = fileFor(this.dir, profile.symbol);
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(profile, null, 2), 'utf8');
    await rename(tmp, path);
    // chmod 600 per AGENTS.md "no secrets in repo" + issue #15 spec.
    // Best-effort: ignore on Windows / unsupported filesystems.
    try {
      await chmod(path, 0o600);
    } catch {
      /* ignore */
    }
  }

  private async quarantine(path: string): Promise<void> {
    const backup = `${path}.corrupt-${Date.now()}`;
    try {
      await rename(path, backup);
    } catch {
      /* ignore */
    }
  }
}
