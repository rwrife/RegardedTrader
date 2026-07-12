/**
 * SEC EDGAR 8-K historical earnings anchor (issue #59).
 *
 * Historical earnings are anchored on the actual filing date of an 8-K with
 * item `2.02` ("Results of Operations and Financial Condition"). This is the
 * highest-trust historical signal — companies file their own results
 * directly with the SEC, so unlike Yahoo/Nasdaq the date is authoritative
 * and immutable. We use it purely as an anchor for the past ~4 quarters;
 * future earnings continue to come from Yahoo + Nasdaq (see #57, #58).
 *
 * Data path:
 *
 *   1. Resolve ticker → CIK via the public company_tickers.json map:
 *        https://www.sec.gov/files/company_tickers.json
 *      (map is loaded once per source instance and cached in-memory).
 *   2. Fetch the company's recent filings submissions JSON:
 *        https://data.sec.gov/submissions/CIK{10-digit}.json
 *      The `filings.recent` block carries parallel arrays for
 *      `form`, `filingDate`, `items`, etc.
 *   3. Filter to `form === "8-K"` AND `items` contains `2.02`.
 *   4. Emit one `CalendarEvent { kind: "earnings" }` per filing, capped at
 *      `maxQuarters` (default 4) most-recent.
 *
 * The SEC requires a descriptive `User-Agent`; the polite fetch client
 * already sets one for the whole project. Rate-limiting (10 req/s across
 * data.sec.gov per SEC guidance) is enforced by `PoliteFetchClient` at 4
 * req/s per host by default.
 *
 * Historical filings never change, so callers are expected to cache the
 * response aggressively. This module does not persist anything; it is a
 * pure producer, matching the pattern used by `earnings-yahoo.ts` and
 * `earnings-nasdaq.ts`.
 *
 * Network errors throw so the orchestrator can mark the source stale
 * (issue #60). Per-row parse failures are logged and dropped.
 *
 * Endpoint last verified: 2026-07-12.
 */

import type {
  CalendarEvent,
  CalendarSource,
} from '../../schemas/calendar.js';
import { CalendarEvent as CalendarEventSchema } from '../../schemas/calendar.js';
import type { PoliteFetchClient } from '../../tickers/http.js';
import { makeEventId } from '../store.js';

export const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
export const SEC_SUBMISSIONS_BASE = 'https://data.sec.gov/submissions';

/** Default cap on how many historical earnings filings to emit per symbol. */
const DEFAULT_MAX_QUARTERS = 4;

/** SEC 8-K item code for "Results of Operations and Financial Condition". */
const ITEM_RESULTS_OF_OPERATIONS = '2.02';

export interface SecEarningsSourceOptions {
  client: PoliteFetchClient;
  symbol: string;
  /** Maximum historical filings to emit (most-recent first). Defaults to 4. */
  maxQuarters?: number;
  /** Override the ticker-map URL (used by tests). */
  tickersUrl?: string;
  /** Override the submissions endpoint base (used by tests). */
  submissionsBase?: string;
  /** Inject the current time so tests can pin `fetchedAt`. Defaults to `Date.now`. */
  now?: () => number;
  /** Inject a logger; defaults to a no-op. */
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  /**
   * Pre-resolved ticker → CIK (integer) map. When supplied, the source
   * skips the `company_tickers.json` fetch. Useful for reusing one map
   * across many symbols without hitting the SEC once per symbol.
   */
  tickerToCik?: ReadonlyMap<string, number>;
}

export interface SecEarningsParseOptions {
  symbol: string;
  cik: number;
  fetchedAt: string;
  maxQuarters: number;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/** Format a CIK integer as the 10-digit zero-padded string SEC expects. */
export function padCik(cik: number): string {
  if (!Number.isInteger(cik) || cik <= 0) {
    throw new Error(`sec-earnings: invalid CIK ${String(cik)}`);
  }
  return String(cik).padStart(10, '0');
}

/**
 * Parse the public `company_tickers.json` map into a case-insensitive
 * `ticker → cik` lookup. SEC's payload is an object whose values look like
 * `{ cik_str: number, ticker: string, title: string }`.
 *
 * Pure and exported for tests.
 */
export function parseTickerMap(
  json: unknown,
  logger: { warn: (msg: string, meta?: Record<string, unknown>) => void } = {
    warn: () => {},
  },
): Map<string, number> {
  const out = new Map<string, number>();
  if (!json || typeof json !== 'object') {
    logger.warn('sec-earnings: ticker map is not an object');
    return out;
  }
  const values = Object.values(json as Record<string, unknown>);
  for (const entry of values) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const ticker = typeof row.ticker === 'string' ? row.ticker.toUpperCase() : '';
    const cik = typeof row.cik_str === 'number' ? row.cik_str : Number(row.cik_str);
    if (!ticker || !Number.isFinite(cik) || cik <= 0) continue;
    // First occurrence wins; SEC listings are stable so collisions shouldn't
    // matter in practice.
    if (!out.has(ticker)) out.set(ticker, Math.trunc(cik));
  }
  return out;
}

function sourceFor(cik: string): CalendarSource {
  return {
    name: 'SEC',
    url: `${SEC_SUBMISSIONS_BASE}/CIK${cik}.json`,
  };
}

/** Split SEC's `items` field ("2.02,9.01" or "Item 2.02,Item 9.01") on commas. */
function normalizeItems(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^item\s+/i, ''))
    .filter((s) => s.length > 0);
}

/**
 * Parse a `submissions/CIK*.json` payload into historical earnings events.
 *
 * Pure and exported for tests; consumes the shape returned by SEC's public
 * submissions endpoint (parallel arrays under `filings.recent`).
 */
export function parseSecEarningsSubmissions(
  json: unknown,
  opts: SecEarningsParseOptions,
): CalendarEvent[] {
  const logger = opts.logger ?? { warn: () => {} };
  if (!json || typeof json !== 'object') {
    logger.warn('sec-earnings: submissions payload is not an object', {
      symbol: opts.symbol,
    });
    return [];
  }
  const root = json as Record<string, unknown>;
  const filings = root.filings as Record<string, unknown> | undefined;
  const recent = filings?.recent as Record<string, unknown> | undefined;
  if (!recent) return [];

  const forms = Array.isArray(recent.form) ? (recent.form as unknown[]) : [];
  const filingDates = Array.isArray(recent.filingDate)
    ? (recent.filingDate as unknown[])
    : [];
  const items = Array.isArray(recent.items) ? (recent.items as unknown[]) : [];
  const accession = Array.isArray(recent.accessionNumber)
    ? (recent.accessionNumber as unknown[])
    : [];

  const n = Math.min(forms.length, filingDates.length);
  if (n === 0) return [];

  const cikPadded = padCik(opts.cik);
  const source = sourceFor(cikPadded);
  const sym = opts.symbol.toUpperCase();
  const emitted: CalendarEvent[] = [];

  for (let i = 0; i < n; i++) {
    const form = forms[i];
    if (form !== '8-K') continue;

    const itemList = normalizeItems(items[i]);
    if (!itemList.includes(ITEM_RESULTS_OF_OPERATIONS)) continue;

    const filingDate = filingDates[i];
    if (typeof filingDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(filingDate)) {
      logger.warn('sec-earnings: filing missing/invalid filingDate, skipping', {
        symbol: sym,
        index: i,
        accession: typeof accession[i] === 'string' ? accession[i] : undefined,
      });
      continue;
    }

    const startUtc = `${filingDate}T00:00:00.000Z`;
    if (Number.isNaN(new Date(startUtc).getTime())) {
      logger.warn('sec-earnings: invalid filingDate, skipping', {
        symbol: sym,
        filingDate,
      });
      continue;
    }

    const candidate = {
      id: '',
      kind: 'earnings' as const,
      symbol: sym,
      startUtc,
      endUtc: startUtc,
      allDay: true,
      title: `${sym} earnings`,
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
      logger.warn('sec-earnings: row failed validation', {
        symbol: sym,
        filingDate,
        issues: parsed.error.issues,
      });
      continue;
    }
    emitted.push(parsed.data);
    if (emitted.length >= opts.maxQuarters) break;
  }

  // `filings.recent` is already newest-first; sort descending by startUtc to
  // be explicit and defensive against upstream ordering changes.
  emitted.sort((a, b) => (a.startUtc < b.startUtc ? 1 : a.startUtc > b.startUtc ? -1 : 0));
  return emitted;
}

/**
 * Fetch and parse historical earnings 8-K filings for a single symbol.
 * Returns most-recent first, capped at `maxQuarters` events.
 *
 * Throws on transport errors so the orchestrator can mark the source stale.
 */
export async function fetchSecEarnings(
  opts: SecEarningsSourceOptions,
): Promise<CalendarEvent[]> {
  const sym = opts.symbol.toUpperCase();
  const now = opts.now ?? Date.now;
  const logger = opts.logger ?? { warn: () => {} };
  const maxQuarters = opts.maxQuarters ?? DEFAULT_MAX_QUARTERS;
  const tickersUrl = opts.tickersUrl ?? SEC_TICKERS_URL;
  const submissionsBase = opts.submissionsBase ?? SEC_SUBMISSIONS_BASE;
  const fetchedAt = new Date(now()).toISOString();

  // 1. Resolve CIK.
  let cik: number | undefined = opts.tickerToCik?.get(sym);
  if (cik === undefined) {
    const resp = await opts.client.fetch(tickersUrl, {
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      throw new Error(`sec-earnings: HTTP ${resp.status} fetching ${tickersUrl}`);
    }
    let json: unknown;
    try {
      json = await resp.json();
    } catch (err) {
      throw new Error(
        `sec-earnings: invalid JSON from ticker map: ${(err as Error).message}`,
      );
    }
    const map = parseTickerMap(json, logger);
    cik = map.get(sym);
    if (cik === undefined) {
      logger.warn('sec-earnings: symbol not found in SEC ticker map', { symbol: sym });
      return [];
    }
  }

  // 2. Fetch submissions.
  const cikPadded = padCik(cik);
  const url = `${submissionsBase}/CIK${cikPadded}.json`;
  const resp = await opts.client.fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`sec-earnings: HTTP ${resp.status} fetching ${url}`);
  }
  let submissions: unknown;
  try {
    submissions = await resp.json();
  } catch (err) {
    throw new Error(
      `sec-earnings: invalid JSON for ${sym}: ${(err as Error).message}`,
    );
  }

  return parseSecEarningsSubmissions(submissions, {
    symbol: sym,
    cik,
    fetchedAt,
    maxQuarters,
    logger,
  });
}
