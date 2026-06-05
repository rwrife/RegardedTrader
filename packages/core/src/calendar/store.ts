import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configHome } from '../config/index.js';
import {
  CalendarEvent,
  type CalendarEvent as CalendarEventT,
  type CalendarSource,
  type EventKind,
  MarketDayState,
  type MarketDayState as MarketDayStateT,
} from '../schemas/calendar.js';

/** Default LRU capacity for the in-memory event cache. */
const DEFAULT_LRU_CAPACITY = 4096;

/**
 * Default "stale" cutoff for a per-symbol earnings file or the holidays file:
 * 7 days. Past this, callers should refresh from the upstream source. The
 * orchestrator/scheduler decides when; the store just reports staleness.
 */
const DEFAULT_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export function calendarHome(): string {
  return join(configHome(), 'calendar');
}

export function holidaysPath(root: string = calendarHome()): string {
  return join(root, 'holidays.json');
}

export function earningsPath(symbol: string, root: string = calendarHome()): string {
  return join(root, 'earnings', `${symbol.toUpperCase()}.json`);
}

export function latestPath(root: string = calendarHome()): string {
  return join(root, 'latest.json');
}

/**
 * Deterministic event id. Mirrors the spec from issue #55:
 *   sha1(kind + symbol? + dateUtc + source)
 *
 * We hash the canonical `startUtc` (the "date" anchor) and the sorted source
 * names so the same upstream payload always hashes to the same id, which
 * gives us idempotent `upsertEvents`.
 */
export function makeEventId(input: {
  kind: EventKind;
  symbol: string | null;
  startUtc: string;
  sources: ReadonlyArray<CalendarSource>;
}): string {
  const sym = input.symbol ?? '';
  const sourceKey = input.sources
    .map((s) => s.name)
    .slice()
    .sort()
    .join(',');
  const h = createHash('sha1');
  h.update(`${input.kind}|${sym}|${input.startUtc}|${sourceKey}`);
  return h.digest('hex');
}

interface HolidaysFile {
  version: 1;
  events: CalendarEventT[];
  fetchedAt: string | null;
}

interface EarningsFile {
  version: 1;
  symbol: string;
  events: CalendarEventT[];
  fetchedAt: string | null;
}

interface LatestFile {
  version: 1;
  market: CalendarEventT | null;
  bySymbol: Record<string, CalendarEventT | null>;
  updatedAt: string | null;
}

function emptyHolidays(): HolidaysFile {
  return { version: 1, events: [], fetchedAt: null };
}

function emptyEarnings(symbol: string): EarningsFile {
  return { version: 1, symbol: symbol.toUpperCase(), events: [], fetchedAt: null };
}

function emptyLatest(): LatestFile {
  return { version: 1, market: null, bySymbol: {}, updatedAt: null };
}

/** Tiny LRU keyed by string; the value is the file shape we just read. */
class LruCache<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly capacity: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // Refresh recency
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const first = this.map.keys().next().value as string | undefined;
      if (first !== undefined) this.map.delete(first);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Holiday-driven approximation of the regular US-equity session in UTC. */
function isoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface CalendarStoreOptions {
  /** Override calendar root (tests). Defaults to `{configHome}/calendar`. */
  root?: string;
  /** LRU capacity for the in-memory event cache. */
  lruCapacity?: number;
  /** Staleness cutoff in ms (default 7 days). */
  staleMs?: number;
  /** Clock override (tests). */
  now?: () => Date;
}

export interface NextEventQuery {
  /** Only return events on/after this instant. Defaults to `now()`. */
  fromUtc?: string;
  /** Filter by kinds. */
  kinds?: ReadonlyArray<EventKind>;
}

export interface EventsBetweenQuery {
  symbol?: string | null;
  kinds?: ReadonlyArray<EventKind>;
}

/**
 * JSON-file-backed calendar store (issue #56).
 *
 * Layout under `~/.regardedtrader/calendar/`:
 *   - `holidays.json`            — market-wide events (rolling 18-month window).
 *   - `earnings/{SYMBOL}.json`   — per-symbol events (4 quarters back, 4 forward).
 *   - `latest.json`              — denormalized "next event" per symbol + market.
 *
 * Writes use `tmp + rename` for atomicity and `chmod 600` to keep the cache
 * local-private (matches AGENTS.md rule 7). Reads layer an LRU on top of disk
 * to keep hot lookups (next event, dashboard pill) allocation-light.
 *
 * The store is intentionally I/O-only: it does **not** fetch upstream data,
 * dedupe across sources, or decide conflict resolution. Those concerns live
 * with the per-source pollers (#57, #58, #59) and the orchestrator (#60).
 */
export class CalendarStore {
  private readonly root: string;
  private readonly lru: LruCache<unknown>;
  private readonly staleMs: number;
  private readonly now: () => Date;

  constructor(opts: CalendarStoreOptions = {}) {
    this.root = opts.root ?? calendarHome();
    this.lru = new LruCache(opts.lruCapacity ?? DEFAULT_LRU_CAPACITY);
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
    this.now = opts.now ?? (() => new Date());
  }

  get rootDir(): string {
    return this.root;
  }

  /**
   * Idempotently upsert a batch of events. Dedups by `id`, splits them across
   * the right files (market-wide vs per-symbol), and rewrites the
   * `latest.json` denormalization. Returns the count of inserted vs updated
   * events for observability.
   */
  async upsertEvents(events: ReadonlyArray<CalendarEventT>): Promise<{
    inserted: number;
    updated: number;
  }> {
    if (events.length === 0) return { inserted: 0, updated: 0 };

    // Validate every event up front so a single bad item doesn't half-write.
    const validated = events.map((e) => CalendarEvent.parse(e));

    // Bucket by destination file.
    const marketBucket: CalendarEventT[] = [];
    const perSymbol = new Map<string, CalendarEventT[]>();
    for (const ev of validated) {
      if (ev.symbol === null) {
        marketBucket.push(ev);
      } else {
        const sym = ev.symbol.toUpperCase();
        const list = perSymbol.get(sym) ?? [];
        list.push(ev);
        perSymbol.set(sym, list);
      }
    }

    let inserted = 0;
    let updated = 0;

    const fetchedAt = this.now().toISOString();

    if (marketBucket.length > 0) {
      const cur = await this.readHolidays();
      const merged = mergeById(cur.events, marketBucket);
      inserted += merged.inserted;
      updated += merged.updated;
      const next: HolidaysFile = {
        version: 1,
        events: merged.events.sort(byStart),
        fetchedAt,
      };
      await this.writeJson(holidaysPath(this.root), next);
      this.lru.set(holidaysPath(this.root), next);
    }

    for (const [sym, evs] of perSymbol.entries()) {
      const cur = await this.readEarnings(sym);
      const merged = mergeById(cur.events, evs);
      inserted += merged.inserted;
      updated += merged.updated;
      const next: EarningsFile = {
        version: 1,
        symbol: sym,
        events: merged.events.sort(byStart),
        fetchedAt,
      };
      await this.writeJson(earningsPath(sym, this.root), next);
      this.lru.set(earningsPath(sym, this.root), next);
    }

    await this.recomputeLatest();

    return { inserted, updated };
  }

  /**
   * Return the next upcoming event (i.e. `startUtc >= fromUtc`). When
   * `symbol` is provided, only per-symbol events are considered; when
   * `symbol` is explicitly `null`, only market-wide events; when omitted,
   * both. `kinds` further filters by event kind.
   */
  async nextEvent(
    symbol?: string | null,
    query: NextEventQuery = {},
  ): Promise<CalendarEventT | null> {
    const fromUtc = query.fromUtc ?? this.now().toISOString();
    const kinds = query.kinds ? new Set(query.kinds) : null;

    const candidates: CalendarEventT[] = [];

    if (symbol === undefined || symbol === null) {
      const market = await this.readHolidays();
      candidates.push(...market.events);
    }
    if (symbol === undefined || (typeof symbol === 'string' && symbol.length > 0)) {
      if (typeof symbol === 'string' && symbol.length > 0) {
        const file = await this.readEarnings(symbol);
        candidates.push(...file.events);
      } else {
        // No symbol filter — pull all symbol files. Bounded by watchlist size
        // in practice, so a directory listing is fine.
        for (const ev of await this.readAllEarnings()) candidates.push(ev);
      }
    }

    let best: CalendarEventT | null = null;
    for (const ev of candidates) {
      if (ev.startUtc < fromUtc) continue;
      if (kinds && !kinds.has(ev.kind)) continue;
      if (best === null || ev.startUtc < best.startUtc) best = ev;
    }
    return best;
  }

  /**
   * Return every event with `fromUtc <= startUtc < toUtc`. Range is
   * half-open so consecutive calls don't double-count a boundary event.
   */
  async eventsBetween(
    fromUtc: string,
    toUtc: string,
    query: EventsBetweenQuery = {},
  ): Promise<CalendarEventT[]> {
    const kinds = query.kinds ? new Set(query.kinds) : null;

    const source: CalendarEventT[] = [];
    if (query.symbol === undefined) {
      source.push(...(await this.readHolidays()).events);
      source.push(...(await this.readAllEarnings()));
    } else if (query.symbol === null) {
      source.push(...(await this.readHolidays()).events);
    } else {
      source.push(...(await this.readEarnings(query.symbol)).events);
    }

    return source
      .filter((ev) => ev.startUtc >= fromUtc && ev.startUtc < toUtc)
      .filter((ev) => (kinds ? kinds.has(ev.kind) : true))
      .sort(byStart);
  }

  /**
   * Derive a `MarketDayState` for a given UTC date by checking holidays /
   * early-close events. Defaults to `open` with the canonical 13:30-20:00 UTC
   * (9:30-16:00 ET ignoring DST drift) window. Pollers will eventually
   * provide ET-accurate timing via `details.closeTimeEt`; until then, this is
   * a deterministic best-effort that the dashboard can render today.
   */
  async marketStateFor(dateUtc: string | Date): Promise<MarketDayStateT> {
    const date = typeof dateUtc === 'string' ? new Date(dateUtc) : dateUtc;
    if (Number.isNaN(date.getTime())) {
      throw new TypeError(`Invalid date passed to marketStateFor: ${String(dateUtc)}`);
    }
    const dayKey = isoDate(date);
    const holidays = await this.readHolidays();
    const onDay = holidays.events.filter((ev) => ev.startUtc.startsWith(dayKey));

    const closure = onDay.find((ev) => ev.kind === 'market_holiday');
    if (closure) {
      return MarketDayState.parse({
        state: 'closed',
        reason: closure.title,
      });
    }
    const early = onDay.find((ev) => ev.kind === 'market_early_close');
    if (early) {
      return MarketDayState.parse({
        state: 'early',
        rthOpenUtc: `${dayKey}T13:30:00.000Z`,
        rthCloseUtc: early.endUtc,
      });
    }
    // Weekends fall back to closed even without an explicit holiday entry.
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) {
      return MarketDayState.parse({
        state: 'closed',
        reason: 'weekend',
      });
    }
    return MarketDayState.parse({
      state: 'open',
      rthOpenUtc: `${dayKey}T13:30:00.000Z`,
      rthCloseUtc: `${dayKey}T20:00:00.000Z`,
    });
  }

  /** Read the denormalized "latest" snapshot. */
  async readLatest(): Promise<LatestFile> {
    return await this.readJson(latestPath(this.root), emptyLatest);
  }

  /**
   * Is the holidays file (or a per-symbol earnings file) older than the
   * configured staleness cutoff? Returns `true` for files that have never
   * been written. The orchestrator uses this to decide whether to refresh.
   */
  async isStale(target: { kind: 'holidays' } | { kind: 'earnings'; symbol: string }): Promise<boolean> {
    const file =
      target.kind === 'holidays' ? await this.readHolidays() : await this.readEarnings(target.symbol);
    if (!file.fetchedAt) return true;
    const ts = Date.parse(file.fetchedAt);
    if (Number.isNaN(ts)) return true;
    return this.now().getTime() - ts > this.staleMs;
  }

  // --- internals -----------------------------------------------------------

  private async readHolidays(): Promise<HolidaysFile> {
    return await this.readJson(holidaysPath(this.root), emptyHolidays);
  }

  private async readEarnings(symbol: string): Promise<EarningsFile> {
    const sym = symbol.toUpperCase();
    return await this.readJson(earningsPath(sym, this.root), () => emptyEarnings(sym));
  }

  private async readAllEarnings(): Promise<CalendarEventT[]> {
    const dir = join(this.root, 'earnings');
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: CalendarEventT[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const sym = name.slice(0, -'.json'.length);
      const file = await this.readEarnings(sym);
      out.push(...file.events);
    }
    return out;
  }

  private async readJson<T extends { version: 1 }>(
    path: string,
    fallback: () => T,
  ): Promise<T> {
    const cached = this.lru.get(path) as T | undefined;
    if (cached) return cached;
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as T;
      // We don't deep-validate file shape here (we already validated events
      // on the way in via upsertEvents). If the JSON is structurally
      // unreadable, we fall through to fallback below.
      if (parsed && typeof parsed === 'object' && parsed.version === 1) {
        this.lru.set(path, parsed);
        return parsed;
      }
      const empty = fallback();
      this.lru.set(path, empty);
      return empty;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        const empty = fallback();
        this.lru.set(path, empty);
        return empty;
      }
      if (e instanceof SyntaxError) {
        const empty = fallback();
        this.lru.set(path, empty);
        return empty;
      }
      throw e;
    }
  }

  private async writeJson(path: string, data: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, path);
    try {
      await chmod(path, 0o600);
    } catch {
      // chmod can fail on Windows / certain mount types; not fatal.
    }
  }

  private async recomputeLatest(): Promise<void> {
    const nowIso = this.now().toISOString();
    const market = await this.nextEvent(null, { fromUtc: nowIso });

    const earningsDir = join(this.root, 'earnings');
    const bySymbol: Record<string, CalendarEventT | null> = {};
    try {
      const names = await readdir(earningsDir);
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const sym = name.slice(0, -'.json'.length).toUpperCase();
        bySymbol[sym] = await this.nextEvent(sym, { fromUtc: nowIso });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }

    const latest: LatestFile = {
      version: 1,
      market,
      bySymbol,
      updatedAt: nowIso,
    };
    await this.writeJson(latestPath(this.root), latest);
    this.lru.set(latestPath(this.root), latest);
  }
}

function byStart(a: CalendarEventT, b: CalendarEventT): number {
  if (a.startUtc < b.startUtc) return -1;
  if (a.startUtc > b.startUtc) return 1;
  return a.id.localeCompare(b.id);
}

interface MergeResult {
  events: CalendarEventT[];
  inserted: number;
  updated: number;
}

/** Merge new events into an existing list, deduping by `id`. New wins. */
function mergeById(
  existing: ReadonlyArray<CalendarEventT>,
  incoming: ReadonlyArray<CalendarEventT>,
): MergeResult {
  const byId = new Map<string, CalendarEventT>();
  for (const ev of existing) byId.set(ev.id, ev);

  let inserted = 0;
  let updated = 0;
  for (const ev of incoming) {
    if (byId.has(ev.id)) updated += 1;
    else inserted += 1;
    byId.set(ev.id, ev);
  }
  return { events: Array.from(byId.values()), inserted, updated };
}
