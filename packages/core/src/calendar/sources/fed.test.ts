import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchFedHolidays, parseFedHolidaysHtml, FED_HOLIDAYS_URL } from './fed.js';
import { PoliteFetchClient, type FetchLike } from '../../tickers/http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture(name: string): Promise<string> {
  return readFile(join(__dirname, '__fixtures__', name), 'utf8');
}

const FETCHED_AT = '2026-06-17T00:00:00.000Z';

describe('parseFedHolidaysHtml', () => {
  it('parses the recorded Fed fixture', async () => {
    const html = await loadFixture('fed-2026.html');
    const events = parseFedHolidaysHtml(html, { fetchedAt: FETCHED_AT });
    // 11 rows × 2 years = 22 events
    expect(events.length).toBe(22);
    expect(events.every((e) => e.kind === 'market_holiday')).toBe(true);
    expect(events.every((e) => e.allDay === true)).toBe(true);
    expect(events.every((e) => e.sources[0]?.name === 'Fed')).toBe(true);
    expect(events[0]?.sources[0]?.url).toBe(FED_HOLIDAYS_URL);

    // Sorted ascending.
    for (let i = 1; i < events.length; i++) {
      const a = events[i];
      const b = events[i - 1];
      expect(a && b && a.startUtc >= b.startUtc).toBe(true);
    }

    // Spot-check Independence Day 2026 — fixture has "July 4*"; the asterisk
    // must be stripped and the date resolves to 2026-07-04.
    const independence = events.find(
      (e) => e.startUtc === '2026-07-04T00:00:00.000Z',
    );
    expect(independence).toBeDefined();
    expect(independence?.title).toMatch(/Independence Day/);
  });

  it('does not throw on broken rows', () => {
    const html = `
      <table>
        <tr><th>Holiday</th><th>2026</th></tr>
        <tr><td>BadDate</td><td>NotARealDate</td></tr>
        <tr><td>OK</td><td>January 1</td></tr>
      </table>`;
    const events = parseFedHolidaysHtml(html, { fetchedAt: FETCHED_AT });
    expect(events.length).toBe(1);
    expect(events[0]?.title).toBe('OK');
  });
});

describe('fetchFedHolidays', () => {
  it('fetches and parses', async () => {
    const html = await loadFixture('fed-2026.html');
    const fetchImpl: FetchLike = async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const events = await fetchFedHolidays({ client, now: () => Date.parse(FETCHED_AT) });
    expect(events.length).toBe(22);
  });

  it('throws on non-2xx', async () => {
    const fetchImpl: FetchLike = async () => new Response('nope', { status: 500 });
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    await expect(fetchFedHolidays({ client })).rejects.toThrow(/HTTP 5\d\d/);
  });
});
