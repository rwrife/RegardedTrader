/**
 * Nasdaq.com calendar earnings source (issue #58).
 *
 * Crawls Nasdaq's public earnings calendar JSON endpoint for one or more
 * upcoming dates:
 *
 *   https://api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD
 *
 * The orchestrator calls `fetchNasdaqEarnings` with a watchlist of symbols
 * plus a horizon (default: next 60 days). The source filters Nasdaq's full
 * per-day report down to those symbols, and the caller is expected to
 * reconcile against the Yahoo source by `(symbol, startUtc)`; this module is
 * a pure producer and emits one event per (date, matched symbol).
 *
 * Network errors throw so the orchestrator can mark the calendar stale
 * (issue #60). Per-row parse failures are logged and dropped.
 *
 * Endpoint last verified: 2026-06-18.
 */

import type {
  CalendarEvent,
  CalendarEventDetails,
  CalendarSource,
} from '../../schemas/calendar.js';
import { CalendarEvent as CalendarEventSchema } from '../../schemas/calendar.js';
import type { PoliteFetchClient } from '../../tickers/http.js';
import { makeEventId } from '../store.js';

export const NASDAQ_EARNINGS_URL = 'https://api.nasdaq.com/api/calendar/earnings';

/** Default crawl horizon in days. Spec: "next 60 days". */
const DEFAULT_HORIZON_DAYS = 60;

export interface NasdaqEarningsSourceOptions {
  client: PoliteFetchClient;
  /** Watchlist symbols to keep. Case-insensitive. */
  symbols: ReadonlyArray<string>;
  /** Crawl horizon (days from `from`). Defaults to 60. */
  horizonDays?: number;
  /** Start date (inclusive). Defaults to today (UTC). */
  from?: Date;
  /** Override the URL base (tests). */
  baseUrl?: string;
  /** Inject the current time. Defaults to `Date.now`. */
  now?: () => number;
  /** Inject a logger; defaults to a no-op. */
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

function sourceFor(dateIso: string): CalendarSource {
  return { name: 'Nasdaq', url: `${NASDAQ_EARNINGS_URL}?date=${dateIso}` };
}

/** Format a Date as `YYYY-MM-DD` in UTC. */
function ymdUtc(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Enumerate UTC calendar dates from `from` for `horizonDays` (inclusive).
 * Pure for testability.
 */
export function enumerateDates(from: Date, horizonDays: number): string[] {
  if (!Number.isFinite(from.getTime()) || horizonDays <= 0) return [];
  const out: string[] = [];
  for (let i = 0; i < horizonDays; i++) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + i));
    out.push(ymdUtc(d));
  }
  return out;
}

/**
 * Fetch and parse the Nasdaq earnings calendar for a horizon. Returns the
 * concatenated, sorted CalendarEvent list filtered to the watchlist symbols.
 */
export async function fetchNasdaqEarnings(
  opts: NasdaqEarningsSourceOptions,
): Promise<CalendarEvent[]> {
  const symbols = new Set(opts.symbols.map((s) => s.toUpperCase()));
  if (symbols.size === 0) return [];

  const base = opts.baseUrl ?? NASDAQ_EARNINGS_URL;
  const now = opts.now ?? Date.now;
  const logger = opts.logger ?? { warn: () => {} };
  const from = opts.from ?? new Date(now());
  const horizon = opts.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const dates = enumerateDates(from, horizon);
  const fetchedAt = new Date(now()).toISOString();

  const all: CalendarEvent[] = [];
  for (const date of dates) {
    const url = `${base}?date=${date}`;
    const resp = await opts.client.fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      throw new Error(`nasdaq-earnings: HTTP ${resp.status} fetching ${url}`);
    }
    let json: unknown;
    try {
      json = await resp.json();
    } catch (err) {
      logger.warn('nasdaq-earnings: invalid JSON for date, skipping', {
        date,
        error: (err as Error).message,
      });
      continue;
    }
    const dayEvents = parseNasdaqEarningsDay(json, {
      date,
      symbols,
      fetchedAt,
      logger,
    });
    all.push(...dayEvents);
  }

  all.sort((a, b) => {
    if (a.startUtc !== b.startUtc) return a.startUtc < b.startUtc ? -1 : 1;
    const sa = a.symbol ?? '';
    const sb = b.symbol ?? '';
    return sa.localeCompare(sb);
  });
  return all;
}

export interface NasdaqDayParseOptions {
  /** The `YYYY-MM-DD` date that was queried. */
  date: string;
  /** Watchlist filter (upper-case). */
  symbols: ReadonlySet<string>;
  fetchedAt: string;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/** Map Nasdaq's `time` field to our `when` hint. */
function mapTimeHint(s: string | undefined): 'bmo' | 'amc' | 'during' | undefined {
  if (!s) return undefined;
  const v = s.toLowerCase();
  if (v.includes('pre-market') || v.includes('pre market') || v.includes('before')) return 'bmo';
  if (v.includes('after-hours') || v.includes('after hours') || v.includes('after')) return 'amc';
  if (v.includes('time-not-supplied') || v.includes('not supplied')) return undefined;
  if (v.includes('intraday') || v.includes('during')) return 'during';
  return undefined;
}

/** Parse a single day's `?date=YYYY-MM-DD` response. */
export function parseNasdaqEarningsDay(
  json: unknown,
  opts: NasdaqDayParseOptions,
): CalendarEvent[] {
  const logger = opts.logger ?? { warn: () => {} };
  const out: CalendarEvent[] = [];
  if (!json || typeof json !== 'object') {
    logger.warn('nasdaq-earnings: response is not an object', { date: opts.date });
    return out;
  }
  const root = json as Record<string, unknown>;
  const data = root.data as Record<string, unknown> | undefined;
  if (!data) return out;
  const rows = (data.rows as unknown) ?? [];
  if (!Array.isArray(rows)) return out;

  const startUtc = `${opts.date}T00:00:00.000Z`;
  // Sanity-check the date so we never silently emit Invalid Date events.
  if (Number.isNaN(new Date(startUtc).getTime())) {
    logger.warn('nasdaq-earnings: invalid date', { date: opts.date });
    return out;
  }
  const source = sourceFor(opts.date);

  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const sym = typeof row.symbol === 'string' ? row.symbol.toUpperCase() : '';
    if (!sym || !opts.symbols.has(sym)) continue;

    const details: CalendarEventDetails = {};
    const when = mapTimeHint(typeof row.time === 'string' ? row.time : undefined);
    if (when) details.when = when;

    // Nasdaq exposes `epsForecast` as a string like "$1.23" or "($0.12)";
    // strip currency + parens → negative.
    const epsForecast = typeof row.epsForecast === 'string' ? row.epsForecast.trim() : '';
    if (epsForecast) {
      const neg = /^\(.*\)$/.test(epsForecast);
      const num = Number(epsForecast.replace(/[()$,\s]/g, ''));
      if (Number.isFinite(num)) details.epsEstimate = neg ? -Math.abs(num) : num;
    }

    const candidate = {
      id: '',
      kind: 'earnings' as const,
      symbol: sym,
      startUtc,
      endUtc: startUtc,
      allDay: true,
      title: `${sym} earnings`,
      details: Object.keys(details).length > 0 ? details : undefined,
      sources: [source],
      fetchedAt: opts.fetchedAt,
    };
    candidate.id = makeEventId({
      kind: 'earnings',
      symbol: sym,
      startUtc,
      sources: [source],
    });

    const parsed = CalendarEventSchema.safeParse(candidate);
    if (!parsed.success) {
      logger.warn('nasdaq-earnings: row failed validation', {
        date: opts.date,
        symbol: sym,
        issues: parsed.error.issues,
      });
      continue;
    }
    out.push(parsed.data);
  }

  return out;
}
