import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  fetchYahooEarnings,
  parseYahooEarnings,
  YAHOO_QUOTE_SUMMARY_BASE,
} from './earnings-yahoo.js';
import { PoliteFetchClient, type FetchLike } from '../../tickers/http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture(name: string): Promise<string> {
  return readFile(join(__dirname, '__fixtures__', name), 'utf8');
}

const FETCHED_AT = '2026-06-18T00:00:00.000Z';

describe('parseYahooEarnings', () => {
  it('parses upcoming + history from the recorded NVDA fixture', async () => {
    const json = JSON.parse(await loadFixture('yahoo-earnings-NVDA.json'));
    const events = parseYahooEarnings(json, { symbol: 'NVDA', fetchedAt: FETCHED_AT });

    // 1 upcoming + 4 history rows.
    expect(events.length).toBe(5);
    expect(events.every((e) => e.kind === 'earnings')).toBe(true);
    expect(events.every((e) => e.symbol === 'NVDA')).toBe(true);
    expect(events.every((e) => e.allDay)).toBe(true);
    expect(events.every((e) => e.sources[0]?.name === 'Yahoo')).toBe(true);
    expect(events.every((e) => e.sources[0]?.url.startsWith(YAHOO_QUOTE_SUMMARY_BASE))).toBe(true);
    expect(events.every((e) => e.title === 'NVDA earnings')).toBe(true);

    // Sorted ascending by startUtc.
    for (let i = 1; i < events.length; i++) {
      const a = events[i];
      const b = events[i - 1];
      expect(a && b && a.startUtc >= b.startUtc).toBe(true);
    }

    // History row spot-check: 2026-04-27 (epoch 1777248000) reports epsActual 1.10, est 1.05.
    const apr = events.find((e) => e.startUtc === '2026-04-27T00:00:00.000Z');
    expect(apr).toBeDefined();
    expect(apr?.details?.epsActual).toBeCloseTo(1.1);
    expect(apr?.details?.epsEstimate).toBeCloseTo(1.05);
    expect(apr?.details?.when).toBeUndefined();

    // Upcoming spot-check: 2026-10-28 carries epsEstimate from earningsAverage, no actual.
    const upcoming = events.find((e) => e.startUtc === '2026-10-28T00:00:00.000Z');
    expect(upcoming).toBeDefined();
    expect(upcoming?.details?.epsEstimate).toBeCloseTo(1.31);
    expect(upcoming?.details?.epsActual).toBeUndefined();

    // Stable id: same parse twice yields same ids.
    const again = parseYahooEarnings(json, { symbol: 'NVDA', fetchedAt: FETCHED_AT });
    expect(events.map((e) => e.id)).toEqual(again.map((e) => e.id));
  });

  it('returns [] when upstream reports an error', () => {
    const json = {
      quoteSummary: { result: [], error: { code: 'Not Found', description: 'no data' } },
    };
    const warns: string[] = [];
    const events = parseYahooEarnings(json, {
      symbol: 'XYZ',
      fetchedAt: FETCHED_AT,
      logger: { warn: (m) => warns.push(m) },
    });
    expect(events).toEqual([]);
    expect(warns.some((w) => w.includes('upstream error'))).toBe(true);
  });

  it('skips history rows that have no quarter timestamp', () => {
    const json = {
      quoteSummary: {
        result: [
          {
            earningsHistory: {
              history: [
                { quarter: null, epsActual: { raw: 1.0 }, epsEstimate: { raw: 0.9 } },
                {
                  quarter: { raw: 1769472000 },
                  epsActual: { raw: 1.29 },
                  epsEstimate: { raw: 1.2 },
                },
              ],
            },
          },
        ],
        error: null,
      },
    };
    const events = parseYahooEarnings(json, { symbol: 'ABC', fetchedAt: FETCHED_AT });
    expect(events.length).toBe(1);
    expect(events[0]?.startUtc).toBe('2026-01-27T00:00:00.000Z');
  });

  it('does not double-emit when an upcoming entry collides with a history quarter', () => {
    const epoch = 1769472000; // 2026-01-27
    const json = {
      quoteSummary: {
        result: [
          {
            calendarEvents: {
              earnings: {
                earningsDate: [{ raw: epoch }],
                earningsAverage: { raw: 1.0 },
              },
            },
            earningsHistory: {
              history: [{ quarter: { raw: epoch }, epsActual: { raw: 1.0 }, epsEstimate: { raw: 0.9 } }],
            },
          },
        ],
        error: null,
      },
    };
    const events = parseYahooEarnings(json, { symbol: 'DUP', fetchedAt: FETCHED_AT });
    expect(events.length).toBe(1);
  });
});

describe('fetchYahooEarnings', () => {
  it('fetches and parses', async () => {
    const body = await loadFixture('yahoo-earnings-NVDA.json');
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      expect(url).toContain('/v10/finance/quoteSummary/NVDA');
      expect(url).toContain('modules=calendarEvents');
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const events = await fetchYahooEarnings({
      client,
      symbol: 'NVDA',
      now: () => Date.parse(FETCHED_AT),
    });
    expect(events.length).toBe(5);
  });

  it('throws on non-2xx', async () => {
    const fetchImpl: FetchLike = async () => new Response('nope', { status: 503 });
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    await expect(fetchYahooEarnings({ client, symbol: 'NVDA' })).rejects.toThrow(/HTTP 5\d\d/);
  });
});
