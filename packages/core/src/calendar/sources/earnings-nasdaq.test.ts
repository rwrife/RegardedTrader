import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  enumerateDates,
  fetchNasdaqEarnings,
  parseNasdaqEarningsDay,
  NASDAQ_EARNINGS_URL,
} from './earnings-nasdaq.js';
import { PoliteFetchClient, type FetchLike } from '../../tickers/http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture(name: string): Promise<string> {
  return readFile(join(__dirname, '__fixtures__', name), 'utf8');
}

const FETCHED_AT = '2026-06-18T00:00:00.000Z';

describe('enumerateDates', () => {
  it('lists inclusive UTC dates for the horizon', () => {
    const dates = enumerateDates(new Date('2026-01-30T00:00:00.000Z'), 4);
    expect(dates).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
  });

  it('returns [] for zero or negative horizon', () => {
    expect(enumerateDates(new Date('2026-01-30T00:00:00.000Z'), 0)).toEqual([]);
    expect(enumerateDates(new Date('2026-01-30T00:00:00.000Z'), -1)).toEqual([]);
  });
});

describe('parseNasdaqEarningsDay', () => {
  it('filters to the watchlist and maps fields', async () => {
    const json = JSON.parse(await loadFixture('nasdaq-earnings-2026-10-28.json'));
    const events = parseNasdaqEarningsDay(json, {
      date: '2026-10-28',
      symbols: new Set(['NVDA', 'MSFT', 'LOSS']),
      fetchedAt: FETCHED_AT,
    });

    // ZZZNOT is filtered out; NVDA + MSFT + LOSS remain.
    expect(events.length).toBe(3);
    const syms = events.map((e) => e.symbol).sort();
    expect(syms).toEqual(['LOSS', 'MSFT', 'NVDA']);

    const nvda = events.find((e) => e.symbol === 'NVDA');
    expect(nvda).toBeDefined();
    expect(nvda?.kind).toBe('earnings');
    expect(nvda?.startUtc).toBe('2026-10-28T00:00:00.000Z');
    expect(nvda?.endUtc).toBe('2026-10-28T00:00:00.000Z');
    expect(nvda?.allDay).toBe(true);
    expect(nvda?.title).toBe('NVDA earnings');
    expect(nvda?.details?.when).toBe('amc');
    expect(nvda?.details?.epsEstimate).toBeCloseTo(1.31);
    expect(nvda?.sources[0]?.name).toBe('Nasdaq');
    expect(nvda?.sources[0]?.url).toBe(`${NASDAQ_EARNINGS_URL}?date=2026-10-28`);

    const msft = events.find((e) => e.symbol === 'MSFT');
    expect(msft?.details?.when).toBe('bmo');
    expect(msft?.details?.epsEstimate).toBeCloseTo(3.1);

    const loss = events.find((e) => e.symbol === 'LOSS');
    expect(loss?.details?.epsEstimate).toBeCloseTo(-0.25);
    expect(loss?.details?.when).toBeUndefined();
  });

  it('does not throw on malformed rows', () => {
    const json = {
      data: {
        rows: [
          { symbol: 'OK', time: 'time-pre-market', epsForecast: '$1.00' },
          'not-an-object',
          { time: 'time-pre-market' }, // no symbol
          { symbol: 'NOTWATCH', epsForecast: '$1.00' },
        ],
      },
    };
    const events = parseNasdaqEarningsDay(json, {
      date: '2026-10-28',
      symbols: new Set(['OK']),
      fetchedAt: FETCHED_AT,
    });
    expect(events.length).toBe(1);
    expect(events[0]?.symbol).toBe('OK');
  });

  it('returns [] for an empty/garbage payload', () => {
    expect(
      parseNasdaqEarningsDay(null, {
        date: '2026-10-28',
        symbols: new Set(['NVDA']),
        fetchedAt: FETCHED_AT,
      }),
    ).toEqual([]);
    expect(
      parseNasdaqEarningsDay({}, {
        date: '2026-10-28',
        symbols: new Set(['NVDA']),
        fetchedAt: FETCHED_AT,
      }),
    ).toEqual([]);
  });
});

describe('fetchNasdaqEarnings', () => {
  it('crawls the horizon, filters to watchlist, and sorts', async () => {
    const fixture = await loadFixture('nasdaq-earnings-2026-10-28.json');
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      calls.push(url);
      // Only the 2026-10-28 response has matching rows; other dates return empty.
      if (url.endsWith('date=2026-10-28')) {
        return new Response(fixture, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: { rows: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const events = await fetchNasdaqEarnings({
      client,
      symbols: ['NVDA', 'MSFT'],
      from: new Date('2026-10-27T00:00:00.000Z'),
      horizonDays: 3,
      now: () => Date.parse(FETCHED_AT),
    });

    expect(calls.length).toBe(3);
    expect(calls[0]).toContain('date=2026-10-27');
    expect(calls[1]).toContain('date=2026-10-28');
    expect(calls[2]).toContain('date=2026-10-29');

    // Two matched rows, sorted.
    expect(events.length).toBe(2);
    expect(events.map((e) => e.symbol)).toEqual(['MSFT', 'NVDA']);
  });

  it('returns [] when symbols is empty without making any requests', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const events = await fetchNasdaqEarnings({ client, symbols: [], horizonDays: 5 });
    expect(events).toEqual([]);
    expect(calls).toBe(0);
  });

  it('throws on non-2xx', async () => {
    const fetchImpl: FetchLike = async () => new Response('nope', { status: 502 });
    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    await expect(
      fetchNasdaqEarnings({
        client,
        symbols: ['NVDA'],
        from: new Date('2026-10-27T00:00:00.000Z'),
        horizonDays: 1,
      }),
    ).rejects.toThrow(/HTTP 5\d\d/);
  });
});
