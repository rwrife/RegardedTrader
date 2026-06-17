/**
 * Tiny HTML helpers used by the calendar holiday source parsers.
 *
 * Both NYSE and the Federal Reserve publish their holiday tables as plain
 * server-rendered HTML. We don't pull in jsdom / cheerio for a job this
 * small — instead we use a defensive table walker:
 *
 *   - split the document into `<table>...</table>` blocks
 *   - for each table, split into rows on `</tr>`
 *   - for each row, split into cells on `</t[dh]>` (so headers and data cells
 *     come back in document order)
 *   - strip remaining tags + collapse whitespace per cell
 *
 * The output is a `string[][]` per table. Source parsers can then look at the
 * shape of each table and decide whether it is a "holiday" table, an "early
 * close" table, or noise to skip. Crucially, individual rows that fail to
 * parse must be **logged and dropped, not thrown** — see the dateUtc helpers
 * below for the policy.
 */

/** Strip all HTML tags and decode the handful of entities that appear in NYSE/Fed pages. */
export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract every `<table>...</table>` block as raw HTML. */
export function extractTables(html: string): string[] {
  const out: string[] = [];
  const re = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1] ?? '');
  }
  return out;
}

/** Split a table body into rows of plain-text cells. Header cells and data cells both appear. */
export function tableRows(tableInner: string): string[][] {
  const rows: string[][] = [];
  // Split on </tr>; tolerate missing closers at the end.
  const rawRows = tableInner.split(/<\/tr\s*>/i);
  for (const raw of rawRows) {
    const rowMatch = /<tr\b[^>]*>([\s\S]*)$/i.exec(raw);
    const inside = rowMatch ? rowMatch[1] : raw;
    if (!inside) continue;
    const cells: string[] = [];
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(inside)) !== null) {
      cells.push(stripTags(cm[1] ?? ''));
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Parse a "human" calendar date like:
 *   "Monday, January 1, 2024"
 *   "January 1"
 *   "Jan 1, 2024"
 *   "1/1/2024"
 *
 * The optional `defaultYear` is used when the cell omits the year (NYSE rows
 * commonly do — the year lives in the column header instead). Returns `null`
 * when no usable date can be recovered. Callers MUST drop the row in that
 * case rather than throw.
 */
export function parseHumanDate(input: string, defaultYear?: number): string | null {
  const text = input.replace(/[\u00a0\s]+/g, ' ').trim();
  if (!text) return null;
  if (/^(closed|n\/a|—|-|tbd)$/i.test(text)) return null;

  // ISO-ish fast path: 2024-01-01
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    const y = Number(iso[1]);
    const mo = Number(iso[2]);
    const d = Number(iso[3]);
    return toIsoUtcDay(y, mo, d);
  }

  // Numeric: 1/1/2024 or 01-01-2024
  const numeric = /(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/.exec(text);
  if (numeric && !/[A-Za-z]/.test(text)) {
    const mo = Number(numeric[1]);
    const d = Number(numeric[2]);
    let y = numeric[3] ? Number(numeric[3]) : defaultYear;
    if (y && y < 100) y += 2000;
    if (!y) return null;
    return toIsoUtcDay(y, mo, d);
  }

  // Word month: "January 1, 2024" / "Jan 1" / "Monday, January 1, 2024"
  const word = /([A-Za-z]+)\s+(\d{1,2})(?:[a-z]{2})?(?:[,\s]+(\d{4}))?/.exec(text);
  if (word) {
    const monthKey = (word[1] ?? '').toLowerCase();
    const month = MONTHS[monthKey];
    if (!month) return null;
    const d = Number(word[2]);
    const y = word[3] ? Number(word[3]) : defaultYear;
    if (!y) return null;
    return toIsoUtcDay(y, month, d);
  }

  return null;
}

function toIsoUtcDay(year: number, month: number, day: number): string | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  // Reject overflow (e.g. Feb 30 -> Mar 2).
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return dt.toISOString().slice(0, 10) + 'T00:00:00.000Z';
}

/**
 * Parse an early-close time cell like "1:00 p.m." / "13:00" / "1 PM ET" into
 * a `HH:MM` 24h string in ET, or `null` if unrecognised.
 */
export function parseEtClockTime(input: string): string | null {
  const text = input.replace(/[\u00a0\s]+/g, ' ').trim();
  if (!text) return null;
  // 24h
  const h24 = /^(\d{1,2}):(\d{2})\b/.exec(text);
  if (h24 && !/[ap]\.?m\.?/i.test(text)) {
    const h = Number(h24[1]);
    const m = Number(h24[2]);
    if (h >= 0 && h < 24 && m >= 0 && m < 60) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }
  // 12h with am/pm
  const ampm = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i.exec(text);
  if (ampm) {
    let h = Number(ampm[1]);
    const m = ampm[2] ? Number(ampm[2]) : 0;
    const isPm = (ampm[3] ?? '').toLowerCase() === 'p';
    if (h === 12) h = isPm ? 12 : 0;
    else if (isPm) h += 12;
    if (h >= 0 && h < 24 && m >= 0 && m < 60) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }
  return null;
}
