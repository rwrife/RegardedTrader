/**
 * NYSE market-holiday + early-close source.
 *
 * Fetches `https://www.nyse.com/markets/hours-calendars` (HTML) and parses the
 * holiday + early-close tables for the current and next year, plus any
 * additional years the page exposes. The page presents a single table where
 * each row is a holiday and each year is a column; the early-close rows
 * embed a time like "1:00 p.m.".
 *
 * Layout-drift policy: the parser logs and drops rows it cannot validate. It
 * never throws on malformed input. Network errors propagate so the
 * orchestrator can record `calendar.stale=true` (issue #60).
 *
 * Page structure last verified: 2026-06-17.
 */

import type { CalendarEvent, CalendarSource } from '../../schemas/calendar.js';
import { CalendarEvent as CalendarEventSchema } from '../../schemas/calendar.js';
import { PoliteFetchClient, type FetchLike } from '../../tickers/http.js';
import { RobotsCache } from '../../tickers/robots.js';
import { makeEventId } from '../store.js';
import {
  extractTables,
  parseEtClockTime,
  parseHumanDate,
  tableRows,
} from './html.js';

export const NYSE_HOLIDAYS_URL = 'https://www.nyse.com/markets/hours-calendars';

const NYSE_SOURCE: CalendarSource = {
  name: 'NYSE',
  url: NYSE_HOLIDAYS_URL,
};

export interface NyseHolidaySourceOptions {
  /** Polite HTTP client to use for the fetch. Required so the caller controls rate limits. */
  client: PoliteFetchClient;
  /** Optional robots.txt checker. If omitted, the source assumes allowed (NYSE permits this path). */
  robots?: RobotsCache;
  /** Override the URL (used by tests). */
  url?: string;
  /** Inject the current time so tests can pin "now". Defaults to `Date.now`. */
  now?: () => number;
  /** Inject a logger; defaults to a no-op so library use stays quiet. */
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

interface ParsedHolidayRow {
  /** The "holiday name" cell — the human label. */
  label: string;
  /** Per-year string cells, in column order matching `years`. */
  cells: string[];
}

/**
 * Convenience constructor. In production code prefer `fetchNyseHolidays`
 * directly; this helper is for tests that want a stub fetch.
 */
export function nyseSourceWithStub(fetchImpl: FetchLike): NyseHolidaySourceOptions {
  const client = new PoliteFetchClient({ fetchImpl });
  return { client };
}

/**
 * Fetch and parse the NYSE holiday + early-close page.
 *
 * Returns canonical `CalendarEvent[]` (validated by the Zod schema). Each row
 * that fails validation is dropped and logged — the caller still receives the
 * good rows. Network failures throw so the orchestrator can mark the calendar
 * stale.
 */
export async function fetchNyseHolidays(
  opts: NyseHolidaySourceOptions,
): Promise<CalendarEvent[]> {
  const url = opts.url ?? NYSE_HOLIDAYS_URL;
  const logger = opts.logger ?? { warn: () => {} };
  const now = opts.now ?? Date.now;

  if (opts.robots) {
    const allowed = await opts.robots.isAllowed(url);
    if (!allowed) {
      logger.warn('nyse: robots.txt disallows holiday page', { url });
      return [];
    }
  }

  const resp = await opts.client.fetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  if (!resp.ok) {
    throw new Error(`nyse: HTTP ${resp.status} fetching ${url}`);
  }
  const html = await resp.text();
  return parseNyseHolidaysHtml(html, { fetchedAt: new Date(now()).toISOString(), logger });
}

export interface ParseOptions {
  fetchedAt: string;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/** Pure parser. Exported for tests. */
export function parseNyseHolidaysHtml(html: string, opts: ParseOptions): CalendarEvent[] {
  const logger = opts.logger ?? { warn: () => {} };
  const out: CalendarEvent[] = [];

  for (const tableInner of extractTables(html)) {
    const rows = tableRows(tableInner);
    if (rows.length < 2) continue;

    // First row should be the header. Year columns look like "2024", "2025", "2026".
    const header = rows[0];
    if (!header) continue;
    const yearCols: { idx: number; year: number }[] = [];
    for (let i = 0; i < header.length; i++) {
      const cell = header[i] ?? '';
      const m = /\b(20\d{2})\b/.exec(cell);
      if (m) yearCols.push({ idx: i, year: Number(m[1]) });
    }
    if (yearCols.length === 0) continue; // not a holiday table

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const label = (row[0] ?? '').trim();
      if (!label) continue;
      const isEarlyCloseRow = /early\s+close/i.test(label) || /day\s+after.*close/i.test(label);

      for (const { idx, year } of yearCols) {
        const cell = (row[idx] ?? '').trim();
        if (!cell) continue;
        const event = parseRowCell({
          label,
          cell,
          year,
          isEarlyCloseRow,
          fetchedAt: opts.fetchedAt,
          logger,
        });
        if (event) out.push(event);
      }
    }
  }

  // Stable sort: by date ascending, then kind, then title.
  out.sort((a, b) => {
    if (a.startUtc !== b.startUtc) return a.startUtc < b.startUtc ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
  return out;
}

interface RowCellInput {
  label: string;
  cell: string;
  year: number;
  isEarlyCloseRow: boolean;
  fetchedAt: string;
  logger: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

function parseRowCell(input: RowCellInput): CalendarEvent | null {
  const { label, cell, year, isEarlyCloseRow, fetchedAt, logger } = input;
  const lower = cell.toLowerCase();

  // NYSE marks observed-as-different-day holidays with footnotes (*, **, †).
  // Strip them before date parsing.
  const cleanedDate = cell.replace(/[*†‡]+/g, '').trim();

  if (/^(closed|n\/a|—|-|tbd|not observed)$/i.test(cleanedDate)) return null;

  const startUtc = parseHumanDate(cleanedDate, year);
  if (!startUtc) {
    logger.warn('nyse: could not parse date cell', { label, cell, year });
    return null;
  }

  // Detect early-close: either the row is labelled as such or the cell embeds a time.
  const inlineTime = parseEtClockTime(cell);
  const isEarly = isEarlyCloseRow || inlineTime !== null;

  const kind = isEarly ? 'market_early_close' : 'market_holiday';
  const title = label;

  const candidate = {
    id: '',
    kind,
    symbol: null,
    startUtc,
    endUtc: startUtc,
    allDay: !isEarly,
    title,
    sources: [NYSE_SOURCE],
    fetchedAt,
    ...(isEarly && inlineTime ? { details: { closeTimeEt: inlineTime } } : {}),
  } as CalendarEvent;

  candidate.id = makeEventId({
    kind,
    symbol: null,
    startUtc,
    sources: candidate.sources,
  });

  const parsed = CalendarEventSchema.safeParse(candidate);
  if (!parsed.success) {
    logger.warn('nyse: row failed schema validation', {
      label,
      cell,
      year,
      issues: parsed.error.issues,
    });
    return null;
  }
  return parsed.data;
}
