/**
 * Federal Reserve holiday-schedule source.
 *
 * Cross-checks the NYSE list (issue #57). The Fed publishes its holiday
 * schedule as plain HTML at:
 *
 *   https://www.federalreserve.gov/aboutthefed/k8.htm
 *
 * — a multi-year table where columns are years and rows are holidays. We
 * parse the same shape as the NYSE table; the only differences are the URL
 * and the footnote markers ("*" indicates "if the holiday falls on a
 * Saturday, observed Friday; on a Sunday, observed Monday"). The Fed page
 * does NOT publish equity-market early closes — those belong to NYSE — so
 * this source emits `market_holiday` events only.
 *
 * Page structure last verified: 2026-06-17.
 */

import type { CalendarEvent, CalendarSource } from '../../schemas/calendar.js';
import { CalendarEvent as CalendarEventSchema } from '../../schemas/calendar.js';
import { PoliteFetchClient } from '../../tickers/http.js';
import { RobotsCache } from '../../tickers/robots.js';
import { makeEventId } from '../store.js';
import { extractTables, parseHumanDate, tableRows } from './html.js';

export const FED_HOLIDAYS_URL = 'https://www.federalreserve.gov/aboutthefed/k8.htm';

const FED_SOURCE: CalendarSource = {
  name: 'Fed',
  url: FED_HOLIDAYS_URL,
};

export interface FedHolidaySourceOptions {
  client: PoliteFetchClient;
  robots?: RobotsCache;
  url?: string;
  now?: () => number;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/**
 * Fetch and parse the Federal Reserve holiday schedule.
 *
 * Network errors throw; per-row parse failures are logged and dropped.
 */
export async function fetchFedHolidays(
  opts: FedHolidaySourceOptions,
): Promise<CalendarEvent[]> {
  const url = opts.url ?? FED_HOLIDAYS_URL;
  const logger = opts.logger ?? { warn: () => {} };
  const now = opts.now ?? Date.now;

  if (opts.robots) {
    const allowed = await opts.robots.isAllowed(url);
    if (!allowed) {
      logger.warn('fed: robots.txt disallows holiday page', { url });
      return [];
    }
  }

  const resp = await opts.client.fetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  if (!resp.ok) {
    throw new Error(`fed: HTTP ${resp.status} fetching ${url}`);
  }
  const html = await resp.text();
  return parseFedHolidaysHtml(html, { fetchedAt: new Date(now()).toISOString(), logger });
}

export interface FedParseOptions {
  fetchedAt: string;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/** Pure parser. Exported for tests. */
export function parseFedHolidaysHtml(html: string, opts: FedParseOptions): CalendarEvent[] {
  const logger = opts.logger ?? { warn: () => {} };
  const out: CalendarEvent[] = [];

  for (const tableInner of extractTables(html)) {
    const rows = tableRows(tableInner);
    if (rows.length < 2) continue;

    const header = rows[0];
    if (!header) continue;
    const yearCols: { idx: number; year: number }[] = [];
    for (let i = 0; i < header.length; i++) {
      const cell = header[i] ?? '';
      const m = /\b(20\d{2})\b/.exec(cell);
      if (m) yearCols.push({ idx: i, year: Number(m[1]) });
    }
    if (yearCols.length === 0) continue;

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const label = (row[0] ?? '').trim();
      if (!label) continue;

      for (const { idx, year } of yearCols) {
        const cell = (row[idx] ?? '').trim();
        if (!cell) continue;
        const cleaned = cell.replace(/[*†‡]+/g, '').trim();
        if (/^(closed|n\/a|—|-|tbd|not observed)$/i.test(cleaned)) continue;

        const startUtc = parseHumanDate(cleaned, year);
        if (!startUtc) {
          logger.warn('fed: could not parse date cell', { label, cell, year });
          continue;
        }

        const candidate = {
          id: '',
          kind: 'market_holiday' as const,
          symbol: null,
          startUtc,
          endUtc: startUtc,
          allDay: true,
          title: label,
          sources: [FED_SOURCE],
          fetchedAt: opts.fetchedAt,
        };
        candidate.id = makeEventId({
          kind: candidate.kind,
          symbol: null,
          startUtc,
          sources: candidate.sources,
        });

        const parsed = CalendarEventSchema.safeParse(candidate);
        if (!parsed.success) {
          logger.warn('fed: row failed schema validation', {
            label,
            cell,
            year,
            issues: parsed.error.issues,
          });
          continue;
        }
        out.push(parsed.data);
      }
    }
  }

  out.sort((a, b) => {
    if (a.startUtc !== b.startUtc) return a.startUtc < b.startUtc ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
  return out;
}
