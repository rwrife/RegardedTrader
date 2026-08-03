import {
  CalendarOrchestrator,
  CalendarStore,
  MarketClock,
  PoliteFetchClient,
  fetchFedHolidays,
  fetchNasdaqEarnings,
  fetchNyseHolidays,
  fetchSecEarnings,
  fetchYahooEarnings,
  type CalendarEvent,
  type RefreshResult,
} from '@regardedtrader/core';

export type CalendarSourceId = 'nyse' | 'fed' | 'sec' | 'yahoo' | 'nasdaq';

export interface SourceHealth {
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

export interface CalendarStatus {
  stale: boolean;
  holidaysStale: boolean;
  earningsStale: boolean;
  marketState: string;
  sources: Record<CalendarSourceId, SourceHealth>;
}

export interface CalendarRefreshResponse {
  holidays?: RefreshResult;
  earnings?: RefreshResult;
  skipped?: Array<{ kind: 'holidays' | 'earnings'; retryAfterMs: number }>;
}

export interface CalendarServiceOptions {
  store?: CalendarStore;
  now?: () => Date;
  minManualRefreshMs?: number;
}

const DEFAULT_MANUAL_REFRESH_MIN_MS = 60_000;
const RANGE_FLOOR_UTC = '2000-01-01T00:00:00.000Z';
const RANGE_CEIL_UTC = '2100-01-01T00:00:00.000Z';

const ET_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function toEtDate(iso: string): string {
  return iso.slice(0, 10);
}

function addDays(dateEt: string, days: number): string {
  const d = new Date(`${dateEt}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function sourceState(): Record<CalendarSourceId, SourceHealth> {
  return {
    nyse: { lastSuccessAt: null, lastErrorAt: null, lastError: null },
    fed: { lastSuccessAt: null, lastErrorAt: null, lastError: null },
    sec: { lastSuccessAt: null, lastErrorAt: null, lastError: null },
    yahoo: { lastSuccessAt: null, lastErrorAt: null, lastError: null },
    nasdaq: { lastSuccessAt: null, lastErrorAt: null, lastError: null },
  };
}

export class CalendarService {
  private readonly store: CalendarStore;
  private readonly now: () => Date;
  private readonly minManualRefreshMs: number;
  private readonly sourceHealth = sourceState();
  private readonly lastManualRefreshAt: Record<'holidays' | 'earnings', number | null> = {
    holidays: null,
    earnings: null,
  };
  private readonly clock: MarketClock;
  private readonly orchestrator: CalendarOrchestrator;

  constructor(opts: CalendarServiceOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.minManualRefreshMs = opts.minManualRefreshMs ?? DEFAULT_MANUAL_REFRESH_MIN_MS;
    this.store = opts.store ?? new CalendarStore();
    this.clock = new MarketClock({ store: this.store, now: this.now });

    const polite = new PoliteFetchClient({
      perHostRatePerSec: {
        'www.sec.gov': 2,
        'data.sec.gov': 2,
      },
    });

    this.orchestrator = new CalendarOrchestrator({
      store: this.store,
      now: this.now,
      holidaySources: [
        {
          id: 'nyse',
          fetch: () => this.withHealth('nyse', () => fetchNyseHolidays({ client: polite })),
        },
        {
          id: 'fed',
          fetch: () => this.withHealth('fed', () => fetchFedHolidays({ client: polite })),
        },
      ],
      earningsSources: [
        {
          id: 'sec',
          fetchSymbol: (symbol) =>
            this.withHealth('sec', () => fetchSecEarnings({ client: polite, symbol })),
        },
        {
          id: 'yahoo',
          fetchSymbol: (symbol) =>
            this.withHealth('yahoo', () => fetchYahooEarnings({ client: polite, symbol })),
        },
        {
          id: 'nasdaq',
          fetchSymbol: (symbol) =>
            this.withHealth('nasdaq', () =>
              fetchNasdaqEarnings({ client: polite, symbols: [symbol], horizonDays: 60 }),
            ),
        },
      ],
    });
  }

  async maybeRefreshForRead(symbols: ReadonlyArray<string>): Promise<void> {
    const needsHoliday = await this.store.isStale({ kind: 'holidays' });
    if (needsHoliday) await this.orchestrator.refreshHolidays();

    const unique = uniqueSymbols(symbols);
    if (unique.length > 0) {
      const staleStates = await Promise.all(
        unique.map((symbol) => this.store.isStale({ kind: 'earnings', symbol })),
      );
      if (staleStates.some(Boolean)) {
        await this.orchestrator.refreshEarnings(unique);
      }
    }
    await this.clock.refreshFromStore();
  }

  async getWindow(opts: {
    fromEt: string;
    days: number;
    symbols: ReadonlyArray<string>;
  }): Promise<{
    fromEt: string;
    toEtExclusive: string;
    days: number;
    events: CalendarEvent[];
  }> {
    const fromEt = opts.fromEt;
    const toEtExclusive = addDays(fromEt, opts.days);
    const events = (
      await this.store.eventsBetween(RANGE_FLOOR_UTC, RANGE_CEIL_UTC, {
        kinds: ['market_holiday', 'market_early_close', 'earnings'],
      })
    ).filter((ev) => {
      const dateEt = toEtDate(ev.startUtc);
      if (dateEt < fromEt || dateEt >= toEtExclusive) return false;
      if (ev.kind !== 'earnings') return true;
      const symbol = ev.symbol?.toUpperCase();
      return symbol ? opts.symbols.map((s) => s.toUpperCase()).includes(symbol) : false;
    });
    return { fromEt, toEtExclusive, days: opts.days, events };
  }

  async getSymbolEarnings(opts: {
    symbol: string;
    includePast: boolean;
    includeUpcoming: boolean;
  }): Promise<CalendarEvent[]> {
    const now = nowIso(this.now);
    const events = await this.store.eventsBetween(RANGE_FLOOR_UTC, RANGE_CEIL_UTC, {
      symbol: opts.symbol.toUpperCase(),
      kinds: ['earnings'],
    });
    return events
      .filter((ev) => {
        if (opts.includePast && opts.includeUpcoming) return true;
        if (opts.includePast) return ev.startUtc < now;
        return ev.startUtc >= now;
      })
      .sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  }

  async refreshManually(opts: {
    holidays: boolean;
    earnings: boolean;
    symbols: ReadonlyArray<string>;
  }): Promise<CalendarRefreshResponse> {
    const holidays = opts.holidays || (!opts.holidays && !opts.earnings);
    const earnings = opts.earnings || (!opts.holidays && !opts.earnings);
    const nowMs = this.now().getTime();
    const skipped: Array<{ kind: 'holidays' | 'earnings'; retryAfterMs: number }> = [];
    const out: CalendarRefreshResponse = {};

    if (holidays) {
      const retry = this.retryAfter('holidays', nowMs);
      if (retry > 0) skipped.push({ kind: 'holidays', retryAfterMs: retry });
      else {
        out.holidays = await this.orchestrator.refreshHolidays();
        this.lastManualRefreshAt.holidays = nowMs;
      }
    }

    if (earnings) {
      const retry = this.retryAfter('earnings', nowMs);
      if (retry > 0) skipped.push({ kind: 'earnings', retryAfterMs: retry });
      else {
        out.earnings = await this.orchestrator.refreshEarnings(uniqueSymbols(opts.symbols));
        this.lastManualRefreshAt.earnings = nowMs;
      }
    }

    if (skipped.length > 0) out.skipped = skipped;
    await this.clock.refreshFromStore();
    return out;
  }

  status(): CalendarStatus {
    return {
      stale: this.orchestrator.stale,
      holidaysStale: this.orchestrator.holidaysAreStale,
      earningsStale: this.orchestrator.earningsAreStale,
      marketState: this.clock.state(this.now()),
      sources: this.sourceHealth,
    };
  }

  private retryAfter(kind: 'holidays' | 'earnings', nowMs: number): number {
    const last = this.lastManualRefreshAt[kind];
    if (last === null) return 0;
    const elapsed = nowMs - last;
    if (elapsed >= this.minManualRefreshMs) return 0;
    return this.minManualRefreshMs - elapsed;
  }

  private async withHealth(
    source: CalendarSourceId,
    fn: () => Promise<CalendarEvent[]>,
  ): Promise<CalendarEvent[]> {
    try {
      const events = await fn();
      const health = this.sourceHealth[source];
      health.lastSuccessAt = this.now().toISOString();
      health.lastError = null;
      health.lastErrorAt = null;
      return events;
    } catch (e) {
      const health = this.sourceHealth[source];
      health.lastErrorAt = this.now().toISOString();
      health.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }
}

function uniqueSymbols(symbols: ReadonlyArray<string>): string[] {
  return Array.from(new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)));
}

export function todayEt(now: Date = new Date()): string {
  return ET_DATE_FORMATTER.format(now);
}

export function toEtDateKey(iso: string): string {
  return toEtDate(iso);
}
