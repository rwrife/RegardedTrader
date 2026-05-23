/**
 * Quote poller (#22, parent #19).
 *
 * For each watchlist symbol the poller:
 *
 *  1. Fetches a fresh {@link Quote} via the first {@link QuoteSource} that
 *     succeeds — by default Yahoo, with CNBC as the documented fallback
 *     (see `quote-yahoo.ts` / `quote-cnbc.ts`). The same `QuoteSource`
 *     abstraction is used by the ticker resolver's source registry so the
 *     two pollers can share rate limits without coupling at the type level.
 *  2. Optionally pulls a rolling history window from {@link QuoteHistoryFetcher}
 *     and recomputes {@link Indicators} (RSI/SMA/EMA/MACD/ATR) via
 *     `core/indicators`.
 *  3. Persists a `quote` snapshot through the {@link SnapshotStore}.
 *  4. Emits a `quote.update` event through the optional `onEvent` callback so
 *     the in-process event bus / SSE bridge (#25) can fan it out.
 *
 * The poller is intentionally framework-free: callers inject the sources, the
 * history fetcher, a clock, and the store. No network, no disk, no logger
 * lives inside this module — the Yahoo / CNBC adapters live in sibling
 * `quote-yahoo.ts` / `quote-cnbc.ts` files.
 *
 * The {@link QuotePoller} class layers single-flight-per-symbol semantics
 * and consecutive-failure tracking on top of the pure {@link pollQuote}
 * function so callers (the scheduler, the `/health` endpoint) can:
 *
 *  - dedupe in-flight polls for the same symbol,
 *  - skip symbols that have failed 3 times in a row,
 *  - surface per-symbol health (`healthy` / `unhealthy`) with the last error.
 */

import { z } from 'zod';
import { Quote, Indicators, Ticker, type OHLCV } from '../../schemas/index.js';
import { computeIndicators } from '../../indicators/index.js';
import type { SnapshotStore } from '../store.js';

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Persisted snapshot payload for the `quote` kind. The store wraps this in a
 * `SnapshotEntry { ts, data: QuoteSnapshot }`. `indicators` is `null` when no
 * `historyFetcher` was supplied or when the history pull failed — the quote
 * itself is the primary product, indicators are a best-effort augment.
 */
export const QuoteSnapshot = z.object({
  quote: Quote,
  indicators: Indicators.nullable(),
  /** Identifier of the {@link QuoteSource} that satisfied the fetch. */
  source: z.string().min(1),
});
export type QuoteSnapshot = z.infer<typeof QuoteSnapshot>;

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Pluggable quote source. Implementations are tried in declaration order by
 * {@link pollQuote} (Yahoo first, then CNBC). Sources should throw on
 * transport / parse failures so the poller can fall through to the next one.
 */
export interface QuoteSource {
  /** Stable identifier (e.g. `'yahoo'`, `'cnbc'`). Recorded in snapshots. */
  readonly name: string;
  /** Fetch a fresh quote for `symbol`. Throws on failure. */
  quote(symbol: string): Promise<Quote>;
}

/**
 * Optional history fetcher used to recompute live indicators against a
 * rolling window. The poller calls `history(symbol, days)` and feeds the
 * bars into `computeIndicators`. Returning `[]` is fine and yields
 * `indicators: null` on the snapshot.
 */
export interface QuoteHistoryFetcher {
  history(symbol: string, days: number): Promise<OHLCV[]>;
}

export interface QuoteUpdateEvent {
  readonly type: 'quote.update';
  readonly symbol: string;
  readonly quote: Quote;
  readonly indicators: Indicators | null;
  readonly source: string;
}

/** Default rolling window (calendar days) used for indicator recomputation. */
export const DEFAULT_INDICATOR_WINDOW_DAYS = 120;

/** Default consecutive-failure threshold before a symbol is marked unhealthy. */
export const DEFAULT_UNHEALTHY_THRESHOLD = 3;

export interface PollQuoteOptions {
  readonly symbol: string;
  readonly store: SnapshotStore;
  /**
   * Ordered list of quote sources, tried in order until one succeeds. Empty
   * lists are rejected — pass at least Yahoo.
   */
  readonly sources: readonly QuoteSource[];
  /** Optional history fetcher for indicator recomputation. */
  readonly historyFetcher?: QuoteHistoryFetcher;
  /** Calendar days of history to pull. Default {@link DEFAULT_INDICATOR_WINDOW_DAYS}. */
  readonly historyDays?: number;
  /** Injectable clock for snapshot `ts`. */
  readonly now?: () => Date;
  /** Optional event sink for `quote.update`. */
  readonly onEvent?: (e: QuoteUpdateEvent) => void;
  /**
   * Per-source error hook for diagnostics; never thrown. Called once per
   * source that failed (in source order).
   */
  readonly onError?: (sourceName: string, err: unknown) => void;
}

export interface PollQuoteResult {
  /** `true` when a snapshot was persisted. */
  readonly ok: boolean;
  /** Identifier of the source that satisfied the fetch, when `ok`. */
  readonly source: string | null;
  /** Whether indicators were attached to the snapshot. */
  readonly indicatorsComputed: boolean;
  /** Per-source outcome, in source order. */
  readonly attempts: ReadonlyArray<{
    readonly source: string;
    readonly ok: boolean;
    readonly error?: string;
  }>;
}

/* -------------------------------------------------------------------------- */
/* Pure poll fn                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Poll a single symbol: try each {@link QuoteSource} in order, persist a
 * snapshot for the first success, and emit `quote.update`. Failures from
 * earlier sources are routed through `onError` and do NOT abort the chain.
 *
 * When *all* sources fail this function throws an `AggregateError` carrying
 * the per-source errors so the caller (and {@link QuotePoller}) can count
 * consecutive failures for the unhealthy-skip logic.
 */
export async function pollQuote(
  opts: PollQuoteOptions,
): Promise<PollQuoteResult> {
  const sym = Ticker.parse(opts.symbol.toUpperCase());
  if (opts.sources.length === 0) {
    throw new Error('pollQuote: at least one QuoteSource is required');
  }
  const now = opts.now ?? (() => new Date());
  const historyDays = Math.max(
    1,
    Math.floor(opts.historyDays ?? DEFAULT_INDICATOR_WINDOW_DAYS),
  );

  const attempts: Array<{ source: string; ok: boolean; error?: string }> = [];

  let picked: { quote: Quote; source: string } | null = null;
  for (const src of opts.sources) {
    try {
      const raw = await src.quote(sym);
      // Validate at the boundary so a malformed source can't poison snapshots.
      const quote = Quote.parse({ ...raw, symbol: sym });
      picked = { quote, source: src.name };
      attempts.push({ source: src.name, ok: true });
      break;
    } catch (e) {
      const msg = (e as Error).message ?? 'fetch failed';
      attempts.push({ source: src.name, ok: false, error: msg });
      opts.onError?.(src.name, e);
    }
  }

  if (!picked) {
    const errs = attempts
      .filter((a) => !a.ok)
      .map((a) => `${a.source}: ${a.error ?? 'unknown'}`)
      .join('; ');
    throw new Error(`pollQuote(${sym}): all sources failed — ${errs}`);
  }

  let indicators: Indicators | null = null;
  let indicatorsComputed = false;
  if (opts.historyFetcher) {
    try {
      const bars = await opts.historyFetcher.history(sym, historyDays);
      if (bars.length > 0) {
        indicators = computeIndicators(bars);
        indicatorsComputed = true;
      }
    } catch (e) {
      // History failure must not block the quote snapshot. Surface via
      // onError under a synthetic source name so callers can log it.
      opts.onError?.('history', e);
    }
  }

  const snapshot = QuoteSnapshot.parse({
    quote: picked.quote,
    indicators,
    source: picked.source,
  });

  await opts.store.appendSnapshot(sym, 'quote', {
    ts: now().toISOString(),
    data: snapshot,
  });

  opts.onEvent?.({
    type: 'quote.update',
    symbol: sym,
    quote: picked.quote,
    indicators,
    source: picked.source,
  });

  return {
    ok: true,
    source: picked.source,
    indicatorsComputed,
    attempts,
  };
}

/* -------------------------------------------------------------------------- */
/* Stateful poller: single-flight + health tracking                           */
/* -------------------------------------------------------------------------- */

export type QuoteHealthStatus = 'healthy' | 'unhealthy';

export interface QuoteSymbolHealth {
  readonly symbol: string;
  readonly status: QuoteHealthStatus;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  /** ISO timestamp of the last *successful* poll, or `null` if never. */
  readonly lastSuccessAt: string | null;
  /** ISO timestamp of the last *failed* poll, or `null` if never. */
  readonly lastFailureAt: string | null;
}

export interface QuotePollerOptions {
  readonly store: SnapshotStore;
  readonly sources: readonly QuoteSource[];
  readonly historyFetcher?: QuoteHistoryFetcher;
  readonly historyDays?: number;
  readonly now?: () => Date;
  readonly onEvent?: (e: QuoteUpdateEvent) => void;
  readonly onError?: (sourceName: string, err: unknown) => void;
  /**
   * Consecutive failures before a symbol is marked `unhealthy`. Default 3.
   * Once unhealthy, subsequent `pollSymbol(sym)` calls skip the network and
   * return `{ skipped: true }` until `resetHealth(sym)` is called or the
   * symbol succeeds again on the next manual poll.
   */
  readonly unhealthyThreshold?: number;
}

export interface QuotePollOutcome {
  /** `true` when the symbol was skipped because it is currently unhealthy. */
  readonly skipped: boolean;
  /** Underlying `pollQuote` result, when not skipped and the poll succeeded. */
  readonly result: PollQuoteResult | null;
  /** Error from the underlying poll, when one was thrown. */
  readonly error: Error | null;
  /** Health snapshot for this symbol after the call. */
  readonly health: QuoteSymbolHealth;
}

interface HealthRecord {
  consecutiveFailures: number;
  lastError: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

/**
 * Stateful wrapper around {@link pollQuote} that:
 *
 *  - dedupes concurrent polls for the same symbol (single-flight),
 *  - tracks per-symbol consecutive failures,
 *  - marks symbols `unhealthy` after `unhealthyThreshold` failures (default 3),
 *  - exposes the health map for the `/health` endpoint via {@link health}.
 *
 * The poller is process-local and intentionally not persisted. A restart
 * resets every symbol to `healthy` — the scheduler will discover problems
 * again on the next poll.
 */
export class QuotePoller {
  private readonly opts: QuotePollerOptions;
  private readonly threshold: number;
  private readonly inflight = new Map<string, Promise<QuotePollOutcome>>();
  private readonly healthMap = new Map<string, HealthRecord>();
  private readonly now: () => Date;

  constructor(opts: QuotePollerOptions) {
    if (opts.sources.length === 0) {
      throw new Error('QuotePoller: at least one QuoteSource is required');
    }
    this.opts = opts;
    this.threshold = Math.max(
      1,
      Math.floor(opts.unhealthyThreshold ?? DEFAULT_UNHEALTHY_THRESHOLD),
    );
    this.now = opts.now ?? (() => new Date());
  }

  /** Number of failures before a symbol is marked unhealthy. */
  get unhealthyThreshold(): number {
    return this.threshold;
  }

  /**
   * Poll a single symbol. Concurrent calls for the same symbol share the
   * same in-flight promise (single-flight). Symbols currently marked
   * `unhealthy` are skipped without touching the network.
   */
  pollSymbol(symbol: string): Promise<QuotePollOutcome> {
    const sym = Ticker.parse(symbol.toUpperCase());
    const existing = this.inflight.get(sym);
    if (existing) return existing;

    const run = this.runOnce(sym).finally(() => {
      this.inflight.delete(sym);
    });
    this.inflight.set(sym, run);
    return run;
  }

  private async runOnce(sym: string): Promise<QuotePollOutcome> {
    const current = this.snapshot(sym);
    if (current.status === 'unhealthy') {
      return { skipped: true, result: null, error: null, health: current };
    }

    try {
      const result = await pollQuote({
        symbol: sym,
        store: this.opts.store,
        sources: this.opts.sources,
        historyFetcher: this.opts.historyFetcher,
        historyDays: this.opts.historyDays,
        now: this.now,
        onEvent: this.opts.onEvent,
        onError: this.opts.onError,
      });
      this.recordSuccess(sym);
      return {
        skipped: false,
        result,
        error: null,
        health: this.snapshot(sym),
      };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.recordFailure(sym, err.message);
      return {
        skipped: false,
        result: null,
        error: err,
        health: this.snapshot(sym),
      };
    }
  }

  /** Force `symbol` back to `healthy` (e.g. after manual remediation). */
  resetHealth(symbol: string): void {
    const sym = Ticker.parse(symbol.toUpperCase());
    this.healthMap.delete(sym);
  }

  /** Health snapshot for `symbol`. Returns a `healthy` zero-record if unseen. */
  healthOf(symbol: string): QuoteSymbolHealth {
    return this.snapshot(Ticker.parse(symbol.toUpperCase()));
  }

  /**
   * Full per-symbol health map, sorted alphabetically. Intended for the
   * `/health` endpoint and ops tooling — callers should not mutate it.
   */
  health(): readonly QuoteSymbolHealth[] {
    const out: QuoteSymbolHealth[] = [];
    for (const sym of this.healthMap.keys()) {
      out.push(this.snapshot(sym));
    }
    out.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return out;
  }

  private snapshot(sym: string): QuoteSymbolHealth {
    const rec = this.healthMap.get(sym);
    if (!rec) {
      return {
        symbol: sym,
        status: 'healthy',
        consecutiveFailures: 0,
        lastError: null,
        lastSuccessAt: null,
        lastFailureAt: null,
      };
    }
    return {
      symbol: sym,
      status:
        rec.consecutiveFailures >= this.threshold ? 'unhealthy' : 'healthy',
      consecutiveFailures: rec.consecutiveFailures,
      lastError: rec.lastError,
      lastSuccessAt: rec.lastSuccessAt,
      lastFailureAt: rec.lastFailureAt,
    };
  }

  private recordSuccess(sym: string): void {
    const rec = this.healthMap.get(sym) ?? this.fresh();
    rec.consecutiveFailures = 0;
    rec.lastError = null;
    rec.lastSuccessAt = this.now().toISOString();
    this.healthMap.set(sym, rec);
  }

  private recordFailure(sym: string, message: string): void {
    const rec = this.healthMap.get(sym) ?? this.fresh();
    rec.consecutiveFailures += 1;
    rec.lastError = message;
    rec.lastFailureAt = this.now().toISOString();
    this.healthMap.set(sym, rec);
  }

  private fresh(): HealthRecord {
    return {
      consecutiveFailures: 0,
      lastError: null,
      lastSuccessAt: null,
      lastFailureAt: null,
    };
  }
}
