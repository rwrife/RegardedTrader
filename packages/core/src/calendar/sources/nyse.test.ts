import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  fetchNyseHolidays,
  parseNyseHolidaysHtml,
  NYSE_HOLIDAYS_URL,
} from './nyse.js';
import { PoliteFetchClient, type FetchLike } from '../../tickers/http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture(name: string): Promise<string> {
  return readFile(join(__dirname, '__fixtures__', name), 'utf8');
}

const FETCHED_AT = '2026-06-17T00:00:00.000Z';

describe('parseNyseHolidaysHtml', () => {
  it('parses the recorded NYSE fixture', async () => {
    const html = await loadFixture('nyse-2026.html');
    const events = parseNyseHolidaysHtml(html, { fetchedAt: FETCHED_AT });

    // Holidays: 10 rows × 3 years = 30, plus early closes: not all cells populated.
    const holidays = events.filter((e) => e.kind === 'market_holiday');
    const earlies = events.filter((e) => e.kind === 'market_early_close');
    expect(holidays.length).toBe(30);
    // Early closes: 1 (2028 only) + 3 + 2 = 6
    expect(earlies.length).toBe(6);

    // Sorted by date ascending.
    for (let i = 1; i < events.length; i++) {
      const a = events[i];
      const b = events[i - 1];
      expect(a && b && a.startUtc >= b.startUtc).toBe(true);
    }

    // First event is 2026 New Year's Day.
    expect(events[0]).toMatchObject({
      kind: 'market_holiday',
      symbol: null,
      startUtc: '2026-01-01T00:00:00.000Z',
      endUtc: '2026-01-01T00:00:00.000Z',
      allDay: true,
      title: "New Year's Day",
    });
    expect(events[0]?.sources).toEqual([
      { name: 'NYSE', url: NYSE_HOLIDAYS_URL },
    ]);
    expect(events[0]?.id).toMatch(/^[a-f0-9]{40}$/);
    expect(events[0]?.fetchedAt).toBe(FETCHED_AT);

    // An early-close row should carry closeTimeEt: '13:00'.
    const blackFriday2026 = earlies.find(
      (e) => e.startUtc === '2026-11-27T00:00:00.000Z',
    );
    expect(blackFriday2026).toBeDefined();
    expect(blackFriday2026?.allDay).toBe(false);
    expect(blackFriday2026?.details?.closeTimeEt).toBe('13:00');
    expect(blackFriday2026?.title).toMatch(/Day After Thanksgiving/i);
  });

  it('logs and drops malformed rows without throwing', async () => {
    const html = await loadFixture('nyse-2026.html');
    const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const events = parseNyseHolidaysHtml(html, {
      fetchedAt: FETCHED_AT,
      logger: { warn: (msg, meta) => warnings.push({ msg, meta }) },
    });
    expect(events.length).toBeGreaterThan(0);
    // The malformed table has 2 rows (NotADate, "Sometime in March" w/o year resolvable; but we have year=2026 default).
    // "NotADate" must fail. "Sometime in March" — month words alone won't resolve a day, fails too.
    expect(warnings.some((w) => /could not parse/i.test(w.msg))).toBe(true);
  });

  it('returns empty array on a page with no holiday-shaped tables', () => {
    const html = '<html><body><p>nothing here</p><table><tr><th>foo</th></tr></table></body></html>';
    const events = parseNyseHolidaysHtml(html, { fetchedAt: FETCHED_AT });
    expect(events).toEqual([]);
  });

  it('produces stable ids for the same input (idempotent upsert)', async () => {
    const html = await loadFixture('nyse-2026.html');
    const a = parseNyseHolidaysHtml(html, { fetchedAt: FETCHED_AT });
    const b = parseNyseHolidaysHtml(html, { fetchedAt: '2099-01-01T00:00:00.000Z' });
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]?.id).toBe(b[i]?.id);
    }
  });
});

describe('fetchNyseHolidays', () => {
  it('fetches via the polite client and parses', async () => {
    const html = await loadFixture('nyse-2026.html');
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const events = await fetchNyseHolidays({ client, now: () => Date.parse(FETCHED_AT) });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toContain('nyse.com/markets/hours-calendars');
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.fetchedAt === FETCHED_AT)).toBe(true);
  });

  it('throws on non-2xx responses so the orchestrator can mark stale', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('boom', { status: 503 });
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {}, maxRetries: 1 } as never);
    // PoliteFetchClient handles maxRetries via fetch options; just call fetchNyseHolidays
    // with a minimal-retry client by pretending the global retry path returns 503.
    await expect(
      fetchNyseHolidays({
        client: new PoliteFetchClient({
          fetchImpl: async () => new Response('boom', { status: 503 }),
          sleep: async () => {},
        }),
      }),
    ).rejects.toThrow(/HTTP 503/);
    void client;
  });
});
