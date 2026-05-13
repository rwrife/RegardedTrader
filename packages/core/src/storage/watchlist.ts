import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { configHome } from '../config/index.js';
import {
  type TickerProfile,
  type WatchlistEntry,
  WatchlistEntry as WatchlistEntrySchema,
} from '../schemas/index.js';

/** Default cache TTL: 7 days, per AGENTS.md M1 spec. */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FileShape = z.object({
  version: z.literal(1).default(1),
  entries: z.array(WatchlistEntrySchema).default([]),
});
type FileShape = z.infer<typeof FileShape>;

export function watchlistPath(): string {
  return join(configHome(), 'watchlist.json');
}

export interface WatchlistStoreOptions {
  /** Override file path (tests). */
  path?: string;
  /** TTL in ms used by `isStale`. Default 7 days. */
  ttlMs?: number;
  /** Override clock (tests). */
  now?: () => Date;
}

/**
 * JSON-file-backed watchlist with atomic writes and cache-staleness helpers.
 * Single-process, single-user — that's the whole product, so no locking.
 */
export class WatchlistStore {
  private readonly file: string;
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(opts: WatchlistStoreOptions = {}) {
    this.file = opts.path ?? watchlistPath();
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => new Date());
  }

  get filePath(): string {
    return this.file;
  }

  async list(): Promise<WatchlistEntry[]> {
    const data = await this.read();
    return data.entries.slice().sort((a, b) => a.profile.symbol.localeCompare(b.profile.symbol));
  }

  async get(symbol: string): Promise<WatchlistEntry | undefined> {
    const sym = symbol.toUpperCase();
    const data = await this.read();
    return data.entries.find((e) => e.profile.symbol === sym);
  }

  async upsert(profile: TickerProfile): Promise<WatchlistEntry> {
    const data = await this.read();
    const sym = profile.symbol.toUpperCase();
    const existing = data.entries.find((e) => e.profile.symbol === sym);
    const entry: WatchlistEntry = {
      profile,
      addedAt: existing?.addedAt ?? this.now().toISOString(),
    };
    const next = data.entries.filter((e) => e.profile.symbol !== sym).concat(entry);
    await this.write({ version: 1, entries: next });
    return entry;
  }

  async remove(symbol: string): Promise<boolean> {
    const sym = symbol.toUpperCase();
    const data = await this.read();
    const next = data.entries.filter((e) => e.profile.symbol !== sym);
    if (next.length === data.entries.length) return false;
    await this.write({ version: 1, entries: next });
    return true;
  }

  isStale(entry: WatchlistEntry): boolean {
    const validatedAt = Date.parse(entry.profile.validatedAt);
    if (Number.isNaN(validatedAt)) return true;
    return this.now().getTime() - validatedAt > this.ttlMs;
  }

  private async read(): Promise<FileShape> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = FileShape.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        // Corrupt file: don't nuke it silently — back it up and start fresh.
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try {
          await rename(this.file, backup);
        } catch {
          /* ignore */
        }
        return { version: 1, entries: [] };
      }
      return parsed.data;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] };
      throw e;
    }
  }

  private async write(data: FileShape): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, this.file);
  }
}
