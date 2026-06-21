/**
 * Calendar orchestrator (issue #60).
 *
 * Coordinates the per-source pollers from #57 (NYSE), #58 (Yahoo / Nasdaq)
 * and #59 (SEC, still open) and writes a single reconciled view through the
 * `CalendarStore` (#56).
 *
 * Reconciliation is by configurable per-source weights. The default
 * weighting matches the spec from parent #55:
 *
 *  - market holidays / early closes: **NYSE > Fed**  (100 / 50)
 *  - earnings: **SEC > Yahoo > Nasdaq**              (100 / 50 / 25)
 *
 * Two refresh entry points are exposed:
 *
 *  - {@link CalendarOrchestrator.refreshHolidays} — runs every holiday
 *    source, reconciles, and writes to the store.
 *  - {@link CalendarOrchestrator.refreshEarnings} — runs every earnings
 *    source for each provided symbol, reconciles per `(symbol, date)`, and
 *    writes to the store.
 *
 * Failure semantics ("all-source failure", per the issue):
 *
 *  - Each refresh* call catches every source-level error individually.
 *    Errors never escape `refresh*`; callers always get a {@link RefreshResult}.
 *  - When *all* sources for a refresh kind fail, the orchestrator marks that
 *    kind as `stale`. `holidaysStale` and `earningsStale` are tracked
 *    separately, and {@link CalendarOrchestrator.stale} is the OR.
 *  - Any subsequent successful refresh of that kind clears its stale flag.
 *
 * Event emission:
 *
 *  - On every successful (≥1 source produced events) refresh, the
 *    orchestrator invokes the injected `emit` callback with a
 *    {@link CalendarUpdateEvent}. This mirrors the per-job emit pattern in
 *    `quote.ts` / `news.ts` / `options.ts`. When the central bus from #25
 *    lands, the server can wrap a single fanout around `emit`.
 *
 * No autonomous scheduling lives here — see `jobs.ts` for the scheduler
 * job factories that drive `refreshHolidays` / `refreshEarnings` on a
 * cadence.
 */

import type { CalendarEvent } from '../schemas/calendar.js';
import type { CalendarStore } from './store.js';

/**
 * Per-source weights used for reconciliation. Higher wins on conflict.
 * Unknown source ids fall back to {@link DEFAULT_UNKNOWN_WEIGHT}, which keeps
 * any future source visible but loses to every known source.
 */
export interface CalendarSourceWeights {
  /** NYSE holidays + early closes. Default: 100. */
  nyse?: number;
  /** Federal Reserve holidays. Default: 50. */
  fed?: number;
  /** SEC 8-K earnings (issue #59, still open). Default: 100. */
  sec?: number;
  /** Yahoo Finance earnings. Default: 50. */
  yahoo?: number;
  /** Nasdaq earnings calendar. Default: 25. */
  nasdaq?: number;
}

/** Catch-all when a source id isn't recognized. */
export const DEFAULT_UNKNOWN_WEIGHT = 1;

export const DEFAULT_HOLIDAY_WEIGHTS: Required<Pick<CalendarSourceWeights, 'nyse' | 'fed'>> = {
  nyse: 100,
  fed: 50,
};

export const DEFAULT_EARNINGS_WEIGHTS: Required<
  Pick<CalendarSourceWeights, 'sec' | 'yahoo' | 'nasdaq'>
> = {
  sec: 100,
  yahoo: 50,
  nasdaq: 25,
};

/** Holiday-source identifier set. New entries here MUST also be added to {@link CalendarSourceWeights}. */
export type HolidaySourceId = 'nyse' | 'fed';

/**
 * Pluggable holiday source. The orchestrator calls `fetch()` and treats the
 * returned events as the source's authoritative claim. Throwing is allowed —
 * the orchestrator catches and records the failure.
 */
export interface HolidaySource {
  readonly id: HolidaySourceId;
  fetch(): Promise<CalendarEvent[]>;
}

/** Earnings-source identifier set. */
export type EarningsSourceId = 'sec' | 'yahoo' | 'nasdaq';

/**
 * Pluggable per-symbol earnings source. The orchestrator calls
 * `fetchSymbol(symbol)` once per watchlist symbol and reconciles the
 * results across all configured sources. Throwing is allowed — the
 * orchestrator catches and records the failure (per symbol).
 *
 * NOTE: the SEC source (#59) is still open. The orchestrator never assumes
 * its presence: pass it only if available; otherwise the earnings
 * reconciliation gracefully falls back to Yahoo / Nasdaq.
 */
export interface EarningsSource {
  readonly id: EarningsSourceId;
  fetchSymbol(symbol: string): Promise<CalendarEvent[]>;
}

/**
 * Event payload emitted via `emit` for each successful refresh. Mirrors the
 * per-job emit pattern in `quote.ts` / `news.ts` / `options.ts` — a single
 * typed callback rather than a full event bus. The future central bus
 * (#25) wraps this.
 */
export interface CalendarUpdateEvent {
  readonly type: 'calendar.update';
  readonly kind: 'holidays' | 'earnings';
  /** Number of reconciled events written to the store. */
  readonly count: number;
  /** Symbols whose earnings were just refreshed (earnings refresh only). */
  readonly symbols?: ReadonlyArray<string>;
  /** Source ids that failed during this refresh. */
  readonly staleSources: ReadonlyArray<string>;
  /** ISO timestamp of when the refresh completed. */
  readonly at: string;
}

/** Per-refresh return value. */
export interface RefreshResult {
  /** `true` when at least one source produced events. */
  readonly ok: boolean;
  /** Number of reconciled events written to the store. */
  readonly events: number;
  /** Source ids that failed during this refresh. */
  readonly staleSources: ReadonlyArray<string>;
  /** Per-source error details, in source order. */
  readonly errors: ReadonlyArray<{ readonly source: string; readonly error: string }>;
}

export interface CalendarOrchestratorOptions {
  readonly store: CalendarStore;
  /** Holiday sources, called in declaration order on every `refreshHolidays`. */
  readonly holidaySources: ReadonlyArray<HolidaySource>;
  /** Earnings sources, called in declaration order on every `refreshEarnings`. */
  readonly earningsSources: ReadonlyArray<EarningsSource>;
  /** Event sink; receives a single {@link CalendarUpdateEvent} per successful refresh. */
  readonly emit?: (e: CalendarUpdateEvent) => void;
  /** Clock override (tests). */
  readonly now?: () => Date;
  /**
   * Error hook for diagnostics; never thrown. Called once per failing
   * source with a short context string (e.g. `"holidays:nyse"`, `"earnings:yahoo:NVDA"`).
   */
  readonly onError?: (ctx: string, err: unknown) => void;
  /** Per-source weight overrides. Defaults pick {@link DEFAULT_HOLIDAY_WEIGHTS} / {@link DEFAULT_EARNINGS_WEIGHTS}. */
  readonly sourceWeights?: CalendarSourceWeights;
}

/**
 * Orchestrator class. Constructed once at server start and shared between
 * the scheduler jobs (`jobs.ts`) and any direct callers (e.g. the future
 * watchlist-add hook from #16 calling `refreshEarnings(newSymbols)` for an
 * immediate refresh).
 */
export class CalendarOrchestrator {
  private readonly store: CalendarStore;
  private readonly holidaySources: ReadonlyArray<HolidaySource>;
  private readonly earningsSources: ReadonlyArray<EarningsSource>;
  private readonly emit?: (e: CalendarUpdateEvent) => void;
  private readonly now: () => Date;
  private readonly onError?: (ctx: string, err: unknown) => void;
  private readonly weights: Required<CalendarSourceWeights>;

  private holidaysStale = false;
  private earningsStale = false;

  constructor(opts: CalendarOrchestratorOptions) {
    this.store = opts.store;
    this.holidaySources = opts.holidaySources;
    this.earningsSources = opts.earningsSources;
    this.emit = opts.emit;
    this.now = opts.now ?? (() => new Date());
    this.onError = opts.onError;
    this.weights = {
      nyse: opts.sourceWeights?.nyse ?? DEFAULT_HOLIDAY_WEIGHTS.nyse,
      fed: opts.sourceWeights?.fed ?? DEFAULT_HOLIDAY_WEIGHTS.fed,
      sec: opts.sourceWeights?.sec ?? DEFAULT_EARNINGS_WEIGHTS.sec,
      yahoo: opts.sourceWeights?.yahoo ?? DEFAULT_EARNINGS_WEIGHTS.yahoo,
      nasdaq: opts.sourceWeights?.nasdaq ?? DEFAULT_EARNINGS_WEIGHTS.nasdaq,
    };
  }

  /**
   * `true` when the most recent refresh of *either* kind failed every source.
   *
   * The stale flag is tracked separately per kind (`holidaysStale`,
   * `earningsStale`) and OR'd here so the `/health` endpoint can render a
   * single `calendar.stale` bit without losing the per-kind detail. A
   * subsequent successful refresh of a given kind clears its flag.
   */
  get stale(): boolean {
    return this.holidaysStale || this.earningsStale;
  }

  /** Whether the most recent holidays refresh failed every source. */
  get holidaysAreStale(): boolean {
    return this.holidaysStale;
  }

  /** Whether the most recent earnings refresh failed every source. */
  get earningsAreStale(): boolean {
    return this.earningsStale;
  }

  /**
   * Run every configured holiday source, reconcile by weight, and write
   * through the store. Never throws — failures are recorded in the result
   * and surfaced via `onError`. When every source fails, sets
   * `holidaysAreStale=true`; any partial success clears it.
   */
  async refreshHolidays(): Promise<RefreshResult> {
    if (this.holidaySources.length === 0) {
      // No sources to run — by convention, this is "ok" (nothing to do)
      // and does NOT mark the kind stale. Operators who want a hard-fail
      // can detect this via `events: 0` and the empty `staleSources`.
      this.holidaysStale = false;
      return { ok: true, events: 0, staleSources: [], errors: [] };
    }

    const errors: Array<{ source: string; error: string }> = [];
    const staleSources: string[] = [];
    const successes: Array<{ id: HolidaySourceId; events: CalendarEvent[] }> = [];

    for (const src of this.holidaySources) {
      try {
        const events = await src.fetch();
        successes.push({ id: src.id, events });
      } catch (e) {
        const msg = errorMessage(e);
        errors.push({ source: src.id, error: msg });
        staleSources.push(src.id);
        this.onError?.(`holidays:${src.id}`, e);
      }
    }

    // All-source failure: mark stale and bail without writing.
    if (successes.length === 0) {
      this.holidaysStale = true;
      return { ok: false, events: 0, staleSources, errors };
    }

    // Partial or full success: reconcile + write.
    const reconciled = this.reconcileEvents(
      successes.flatMap((s) => s.events.map((ev) => ({ ev, weight: this.weightFor(s.id) }))),
    );

    let written = 0;
    if (reconciled.length > 0) {
      try {
        const r = await this.store.upsertEvents(reconciled);
        written = r.inserted + r.updated;
      } catch (e) {
        // Treat a store write failure as a hard stale — every source's
        // work just got dropped on the floor.
        this.holidaysStale = true;
        const msg = errorMessage(e);
        errors.push({ source: 'store', error: msg });
        this.onError?.('holidays:store', e);
        return { ok: false, events: 0, staleSources: [...staleSources, 'store'], errors };
      }
    }

    this.holidaysStale = false;
    const at = this.now().toISOString();
    this.emit?.({
      type: 'calendar.update',
      kind: 'holidays',
      count: written,
      staleSources,
      at,
    });
    return { ok: true, events: written, staleSources, errors };
  }

  /**
   * Run every configured earnings source for every requested symbol,
   * reconcile by weight per `(symbol, date)`, and write through the store.
   * Empty `symbols` array is a no-op success.
   *
   * NOTE: the future watchlist-add hook (#16) is expected to call this
   * directly with the newly-added symbols for an immediate refresh; the
   * scheduler job from {@link createCalendarEarningsJob} handles the
   * periodic case.
   */
  async refreshEarnings(symbols: ReadonlyArray<string>): Promise<RefreshResult> {
    if (this.earningsSources.length === 0) {
      this.earningsStale = false;
      return { ok: true, events: 0, staleSources: [], errors: [] };
    }
    if (symbols.length === 0) {
      // No work, but don't change stale (treat as benign).
      return {
        ok: true,
        events: 0,
        staleSources: [],
        errors: [],
      };
    }

    const errors: Array<{ source: string; error: string }> = [];
    const sourcesThatProducedAnything = new Set<EarningsSourceId>();
    const sourcesThatFailedEverywhere = new Set<EarningsSourceId>();
    // Track per-source success/failure across all symbols.
    const sourceAttempted = new Map<EarningsSourceId, { ok: number; fail: number }>();

    const weighted: Array<{ ev: CalendarEvent; weight: number }> = [];

    const normalizedSymbols = symbols.map((s) => s.toUpperCase());

    for (const sym of normalizedSymbols) {
      for (const src of this.earningsSources) {
        const counter = sourceAttempted.get(src.id) ?? { ok: 0, fail: 0 };
        try {
          const events = await src.fetchSymbol(sym);
          counter.ok += 1;
          sourceAttempted.set(src.id, counter);
          for (const ev of events) {
            weighted.push({ ev, weight: this.weightFor(src.id) });
          }
          if (events.length > 0) sourcesThatProducedAnything.add(src.id);
        } catch (e) {
          const msg = errorMessage(e);
          counter.fail += 1;
          sourceAttempted.set(src.id, counter);
          errors.push({ source: `${src.id}:${sym}`, error: msg });
          this.onError?.(`earnings:${src.id}:${sym}`, e);
        }
      }
    }

    // A source counts as "stale" only if it failed for every symbol AND
    // never produced any events (i.e. completely broken this run).
    for (const [id, c] of sourceAttempted.entries()) {
      if (c.ok === 0 && c.fail > 0) {
        sourcesThatFailedEverywhere.add(id);
      }
    }
    const staleSources = Array.from(sourcesThatFailedEverywhere).map((id) => String(id));

    // All-source failure: no source produced anything for any symbol.
    if (sourcesThatProducedAnything.size === 0) {
      // If sources existed but every one of them threw for every symbol,
      // we're stale. If they all just returned empty arrays (no upcoming
      // earnings) that's NOT stale — that's a valid quiet period.
      const everySourceFailed =
        sourcesThatFailedEverywhere.size === this.earningsSources.length &&
        this.earningsSources.length > 0;
      if (everySourceFailed) {
        this.earningsStale = true;
        return {
          ok: false,
          events: 0,
          staleSources,
          errors,
        };
      }
      // Quiet success: nothing to write, nothing stale.
      this.earningsStale = false;
      const at = this.now().toISOString();
      this.emit?.({
        type: 'calendar.update',
        kind: 'earnings',
        count: 0,
        symbols: normalizedSymbols,
        staleSources,
        at,
      });
      return { ok: true, events: 0, staleSources, errors };
    }

    const reconciled = this.reconcileEvents(weighted);

    let written = 0;
    if (reconciled.length > 0) {
      try {
        const r = await this.store.upsertEvents(reconciled);
        written = r.inserted + r.updated;
      } catch (e) {
        this.earningsStale = true;
        const msg = errorMessage(e);
        errors.push({ source: 'store', error: msg });
        this.onError?.('earnings:store', e);
        return {
          ok: false,
          events: 0,
          staleSources: [...staleSources, 'store'],
          errors,
        };
      }
    }

    this.earningsStale = false;
    const at = this.now().toISOString();
    this.emit?.({
      type: 'calendar.update',
      kind: 'earnings',
      count: written,
      symbols: normalizedSymbols,
      staleSources,
      at,
    });
    return { ok: true, events: written, staleSources, errors };
  }

  /**
   * Reconcile a batch of `(event, weight)` pairs by grouping on the
   * canonical reconciliation key — `(kind, symbol, startUtc-date)` — and
   * keeping the highest-weighted candidate per group. Ties keep the first
   * occurrence (declaration order from the caller).
   *
   * The store itself dedups by event `id`; reconciliation here is the
   * cross-source layer above that.
   */
  private reconcileEvents(
    weighted: ReadonlyArray<{ ev: CalendarEvent; weight: number }>,
  ): CalendarEvent[] {
    const winners = new Map<string, { ev: CalendarEvent; weight: number }>();
    for (const candidate of weighted) {
      const key = reconciliationKey(candidate.ev);
      const current = winners.get(key);
      if (current === undefined || candidate.weight > current.weight) {
        winners.set(key, candidate);
      }
    }
    return Array.from(winners.values()).map((w) => w.ev);
  }

  private weightFor(id: HolidaySourceId | EarningsSourceId): number {
    const w = this.weights[id];
    return typeof w === 'number' && Number.isFinite(w) ? w : DEFAULT_UNKNOWN_WEIGHT;
  }
}

/**
 * Canonical reconciliation key for cross-source dedup. We coalesce by the
 * `(kind, symbol, dateUtc)` so two sources reporting the same earnings call
 * for `NVDA` on `2026-05-22` collide and the higher-weighted source wins.
 *
 * Note: `dateUtc` is the date portion (`YYYY-MM-DD`) of `startUtc`; intraday
 * timing skew between sources (e.g. Yahoo says 21:00Z, Nasdaq says 20:30Z)
 * still collides and is resolved by weight.
 */
function reconciliationKey(ev: CalendarEvent): string {
  const sym = ev.symbol ?? '';
  const dateUtc = ev.startUtc.slice(0, 10);
  return `${ev.kind}|${sym}|${dateUtc}`;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
