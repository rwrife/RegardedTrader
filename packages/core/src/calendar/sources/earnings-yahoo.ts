/**
 * Yahoo Finance per-symbol earnings source (issue #58).
 *
 * Queries Yahoo's public quoteSummary endpoint for upcoming + recent earnings
 * events for a single symbol:
 *
 *   https://query2.finance.yahoo.com/v10/finance/quoteSummary/{SYM}
 *     ?modules=calendarEvents,earningsHistory,earningsTrend
 *
 * Emits `CalendarEvent[]` (`kind: "earnings"`) tagged with the `Yahoo` source.
 * Past events come from `earningsHistory.history` (carries both
 * `epsEstimate` and `epsActual`); the upcoming event comes from
 * `calendarEvents.earnings` (`epsEstimate` from `earningsAverage`, `when`
 * inferred from the start/end window).
 *
 * Network errors throw so the orchestrator can mark the calendar stale
 * (issue #60); per-row parse failures are logged and dropped — the source
 * never throws on a single malformed entry.
 *
 * Endpoint last verified: 2026-06-18.
 */

import type { CalendarEvent, CalendarSource, EventKind } from '../../schemas/calendar.js';
import { CalendarEvent as CalendarEventSchema } from '../../schemas/calendar.js';
import type { PoliteFetchClient } from '../../tickers/http.js';
import { makeEventId } from '../store.js';

export const YAHOO_QUOTE_SUMMARY_BASE =
  'https://query2.finance.yahoo.com/v10/finance/quoteSummary';

const YAHOO_MODULES = 'calendarEvents,earningsHistory,earningsTrend';

export interface YahooEarningsSourceOptions {
  client: PoliteFetchClient;
  symbol: string;
  /** Override the base URL (used by tests). */
  baseUrl?: string;
  /** Inject the current time so tests can pin "now". Defaults to `Date.now`. */
  now?: () => number;
  /** Inject a logger; defaults to a no-op. */
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

export interface YahooEarningsParseOptions {
  symbol: string;
  fetchedAt: string;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

function sourceFor(symbol: string): CalendarSource {
  return {
    name: 'Yahoo',
    url: `${YAHOO_QUOTE_SUMMARY_BASE}/${encodeURIComponent(symbol.toUpperCase())}?modules=${YAHOO_MODULES}`,
  };
}

/** Fetch + parse upcoming and recent earnings for a single symbol. */
export async function fetchYahooEarnings(
  opts: YahooEarningsSourceOptions,
): Promise<CalendarEvent[]> {
  const sym = opts.symbol.toUpperCase();
  const base = opts.baseUrl ?? YAHOO_QUOTE_SUMMARY_BASE;
  const now = opts.now ?? Date.now;
  const logger = opts.logger ?? { warn: () => {} };
  const url = `${base}/${encodeURIComponent(sym)}?modules=${YAHOO_MODULES}`;

  const resp = await opts.client.fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`yahoo-earnings: HTTP ${resp.status} fetching ${url}`);
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch (err) {
    throw new Error(
      `yahoo-earnings: invalid JSON for ${sym}: ${(err as Error).message}`,
    );
  }

  return parseYahooEarnings(json, {
    symbol: sym,
    fetchedAt: new Date(now()).toISOString(),
    logger,
  });
}

interface YahooRawNumber {
  raw?: unknown;
}

function readRawNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v && typeof v === 'object' && 'raw' in v) {
    const r = (v as YahooRawNumber).raw;
    if (typeof r === 'number' && Number.isFinite(r)) return r;
  }
  return undefined;
}

function epochToIso(epochSeconds: number): string | null {
  if (!Number.isFinite(epochSeconds)) return null;
  const ms = Math.trunc(epochSeconds) * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Day-anchor at UTC midnight for the calendar date implied by an ISO instant.
 * The store keys events by `startUtc`, so for "earnings on Oct 23" we want a
 * stable midnight even if Yahoo reports 20:00 ET as the underlying time.
 */
function dayAnchorUtc(iso: string): string {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}T00:00:00.000Z`;
}

/**
 * Infer "before market open" / "during" / "after market close" from the raw
 * ISO instant. Yahoo's BMO releases land in 09:xx UTC (≈ pre-market ET) and
 * AMC releases land in 20:xx–22:xx UTC. Returns `undefined` when ambiguous.
 */
function inferWhen(iso: string): 'bmo' | 'amc' | 'during' | undefined {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const hour = d.getUTCHours();
  // ET = UTC-5 (EST) / UTC-4 (EDT). 09:30–16:00 ET → 13:30–21:00 UTC (loosely).
  if (hour < 13) return 'bmo';
  if (hour >= 20) return 'amc';
  return undefined;
}

interface CandidateRaw {
  startUtc: string;
  epsEstimate?: number;
  epsActual?: number;
  when?: 'bmo' | 'amc' | 'during';
}

function buildEvent(
  symbol: string,
  candidate: CandidateRaw,
  fetchedAt: string,
): CalendarEvent | null {
  const sources = [sourceFor(symbol)];
  const startUtc = candidate.startUtc;
  const details: CalendarEvent['details'] = {};
  if (typeof candidate.epsEstimate === 'number') details.epsEstimate = candidate.epsEstimate;
  if (typeof candidate.epsActual === 'number') details.epsActual = candidate.epsActual;
  if (candidate.when) details.when = candidate.when;

  const obj = {
    id: '',
    kind: 'earnings' as EventKind,
    symbol: symbol.toUpperCase(),
    startUtc,
    endUtc: startUtc,
    allDay: true,
    title: `${symbol.toUpperCase()} earnings`,
    details: Object.keys(details).length > 0 ? details : undefined,
    sources,
    fetchedAt,
  };
  obj.id = makeEventId({
    kind: 'earnings',
    symbol: symbol.toUpperCase(),
    startUtc,
    sources,
  });

  const parsed = CalendarEventSchema.safeParse(obj);
  if (!parsed.success) return null;
  return parsed.data;
}

/** Pure parser. Exported for tests. */
export function parseYahooEarnings(
  json: unknown,
  opts: YahooEarningsParseOptions,
): CalendarEvent[] {
  const sym = opts.symbol.toUpperCase();
  const logger = opts.logger ?? { warn: () => {} };
  const out: CalendarEvent[] = [];
  const seen = new Set<string>();

  if (!json || typeof json !== 'object') {
    logger.warn('yahoo-earnings: response is not an object', { symbol: sym });
    return out;
  }
  const root = json as Record<string, unknown>;
  const summary = root.quoteSummary as Record<string, unknown> | undefined;
  if (!summary) {
    logger.warn('yahoo-earnings: missing quoteSummary', { symbol: sym });
    return out;
  }
  if (summary.error) {
    logger.warn('yahoo-earnings: upstream error', {
      symbol: sym,
      error: summary.error,
    });
    return out;
  }
  const results = Array.isArray(summary.result) ? summary.result : [];
  const first = results[0] as Record<string, unknown> | undefined;
  if (!first) return out;

  // ---- Upcoming event from calendarEvents.earnings ------------------------
  const calendarEvents = first.calendarEvents as Record<string, unknown> | undefined;
  const earnings = calendarEvents?.earnings as Record<string, unknown> | undefined;
  const earningsDate = Array.isArray(earnings?.earningsDate) ? earnings?.earningsDate : [];
  if (earningsDate && earningsDate.length > 0) {
    const firstDate = earningsDate[0];
    const epoch = readRawNumber(firstDate);
    if (typeof epoch === 'number') {
      const iso = epochToIso(epoch);
      if (iso) {
        const candidate: CandidateRaw = {
          startUtc: dayAnchorUtc(iso),
          epsEstimate: readRawNumber(earnings?.earningsAverage),
          when: inferWhen(iso),
        };
        const ev = buildEvent(sym, candidate, opts.fetchedAt);
        if (ev) {
          out.push(ev);
          seen.add(ev.startUtc);
        } else {
          logger.warn('yahoo-earnings: upcoming event failed validation', {
            symbol: sym,
            startUtc: candidate.startUtc,
          });
        }
      }
    }
  }

  // ---- Past events from earningsHistory.history ---------------------------
  const earningsHistory = first.earningsHistory as Record<string, unknown> | undefined;
  const history = Array.isArray(earningsHistory?.history) ? earningsHistory?.history : [];
  for (const entry of history ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const qEpoch = readRawNumber(row.quarter);
    if (typeof qEpoch !== 'number') continue;
    const iso = epochToIso(qEpoch);
    if (!iso) continue;
    const startUtc = dayAnchorUtc(iso);
    if (seen.has(startUtc)) continue;
    const candidate: CandidateRaw = {
      startUtc,
      epsEstimate: readRawNumber(row.epsEstimate),
      epsActual: readRawNumber(row.epsActual),
    };
    const ev = buildEvent(sym, candidate, opts.fetchedAt);
    if (!ev) {
      logger.warn('yahoo-earnings: history row failed validation', {
        symbol: sym,
        startUtc,
      });
      continue;
    }
    out.push(ev);
    seen.add(startUtc);
  }

  out.sort((a, b) => (a.startUtc < b.startUtc ? -1 : a.startUtc > b.startUtc ? 1 : 0));
  return out;
}
