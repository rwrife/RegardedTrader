import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  fetchSecEarnings,
  padCik,
  parseSecEarningsSubmissions,
  parseTickerMap,
  SEC_SUBMISSIONS_BASE,
  SEC_TICKERS_URL,
} from './earnings-sec.js';
import { PoliteFetchClient, type FetchLike } from '../../tickers/http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture(name: string): Promise<string> {
  return readFile(join(__dirname, '__fixtures__', name), 'utf8');
}

const FETCHED_AT = '2026-07-12T00:00:00.000Z';

describe('padCik', () => {
  it('zero-pads to 10 digits', () => {
    expect(padCik(320193)).toBe('0000320193');
    expect(padCik(1045810)).toBe('0001045810');
    expect(padCik(1)).toBe('0000000001');
  });

  it('rejects non-positive / non-integer CIKs', () => {
    expect(() => padCik(0)).toThrow(/invalid CIK/);
    expect(() => padCik(-1)).toThrow(/invalid CIK/);
    expect(() => padCik(1.5)).toThrow(/invalid CIK/);
  });
});

describe('parseTickerMap', () => {
  it('builds a case-insensitive ticker → CIK lookup', async () => {
    const json = JSON.parse(await loadFixture('sec-company-tickers.json'));
    const map = parseTickerMap(json);
    expect(map.get('AAPL')).toBe(320193);
    expect(map.get('MSFT')).toBe(789019);
    expect(map.get('NVDA')).toBe(1045810);
    // Not lowercased by the parser; lookups happen against upper-case symbols.
    expect(map.get('aapl')).toBeUndefined();
  });

  it('drops malformed rows without throwing', () => {
    const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const logger = {
      warn: (msg: string, meta?: Record<string, unknown>) => {
        warnings.push({ msg, meta });
      },
    };
    const map = parseTickerMap(
      {
        '0': { cik_str: 1, ticker: 'ONE' },
        '1': 'not-an-object',
        '2': { cik_str: 'not-a-number', ticker: 'BAD' },
        '3': { cik_str: 2, ticker: '' },
        '4': null,
      },
      logger,
    );
    expect(map.size).toBe(1);
    expect(map.get('ONE')).toBe(1);
    expect(warnings.length).toBe(0); // Malformed rows are silently dropped.
  });

  it('handles a non-object payload gracefully', () => {
    const warnings: string[] = [];
    const map = parseTickerMap(null, { warn: (m) => warnings.push(m) });
    expect(map.size).toBe(0);
    expect(warnings.length).toBe(1);
  });
});

describe('parseSecEarningsSubmissions', () => {
  it('emits earnings events for 8-Ks with item 2.02, cap 4, newest-first', async () => {
    const json = JSON.parse(await loadFixture('sec-submissions-AAPL.json'));
    const events = parseSecEarningsSubmissions(json, {
      symbol: 'AAPL',
      cik: 320193,
      fetchedAt: FETCHED_AT,
      maxQuarters: 4,
    });

    // 4 qualifying 8-K/2.02 filings in the fixture; 5.02 and 10-Q are ignored.
    expect(events.length).toBe(4);
    const dates = events.map((e) => e.startUtc);
    expect(dates).toEqual([
      '2026-07-31T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
      '2026-01-30T00:00:00.000Z',
      '2025-10-30T00:00:00.000Z',
    ]);

    for (const e of events) {
      expect(e.kind).toBe('earnings');
      expect(e.symbol).toBe('AAPL');
      expect(e.allDay).toBe(true);
      expect(e.endUtc).toBe(e.startUtc);
      expect(e.title).toBe('AAPL earnings');
      expect(e.sources[0]?.name).toBe('SEC');
      expect(e.sources[0]?.url).toBe(
        `${SEC_SUBMISSIONS_BASE}/CIK0000320193.json`,
      );
      expect(e.fetchedAt).toBe(FETCHED_AT);
      expect(e.id).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('honours maxQuarters', async () => {
    const json = JSON.parse(await loadFixture('sec-submissions-AAPL.json'));
    const events = parseSecEarningsSubmissions(json, {
      symbol: 'AAPL',
      cik: 320193,
      fetchedAt: FETCHED_AT,
      maxQuarters: 2,
    });
    expect(events.length).toBe(2);
    expect(events[0]?.startUtc).toBe('2026-07-31T00:00:00.000Z');
    expect(events[1]?.startUtc).toBe('2026-05-01T00:00:00.000Z');
  });

  it('produces deterministic ids across runs (idempotent upsert)', async () => {
    const json = JSON.parse(await loadFixture('sec-submissions-AAPL.json'));
    const a = parseSecEarningsSubmissions(json, {
      symbol: 'AAPL',
      cik: 320193,
      fetchedAt: FETCHED_AT,
      maxQuarters: 4,
    });
    const b = parseSecEarningsSubmissions(json, {
      symbol: 'AAPL',
      cik: 320193,
      fetchedAt: '2027-01-01T00:00:00.000Z',
      maxQuarters: 4,
    });
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });

  it('skips rows with malformed filingDate but does not throw', () => {
    const warnings: string[] = [];
    const events = parseSecEarningsSubmissions(
      {
        filings: {
          recent: {
            accessionNumber: ['a', 'b'],
            form: ['8-K', '8-K'],
            filingDate: ['nope', '2026-05-01'],
            items: ['2.02', '2.02'],
          },
        },
      },
      {
        symbol: 'AAPL',
        cik: 320193,
        fetchedAt: FETCHED_AT,
        maxQuarters: 4,
        logger: { warn: (m) => warnings.push(m) },
      },
    );
    expect(events.length).toBe(1);
    expect(events[0]?.startUtc).toBe('2026-05-01T00:00:00.000Z');
    expect(warnings.some((w) => w.includes('filingDate'))).toBe(true);
  });

  it('returns [] on missing/empty filings block', () => {
    expect(
      parseSecEarningsSubmissions(
        {},
        { symbol: 'AAPL', cik: 320193, fetchedAt: FETCHED_AT, maxQuarters: 4 },
      ),
    ).toEqual([]);
    expect(
      parseSecEarningsSubmissions(
        { filings: { recent: {} } },
        { symbol: 'AAPL', cik: 320193, fetchedAt: FETCHED_AT, maxQuarters: 4 },
      ),
    ).toEqual([]);
  });

  it('returns [] on non-object payload', () => {
    const warnings: string[] = [];
    expect(
      parseSecEarningsSubmissions(null, {
        symbol: 'AAPL',
        cik: 320193,
        fetchedAt: FETCHED_AT,
        maxQuarters: 4,
        logger: { warn: (m) => warnings.push(m) },
      }),
    ).toEqual([]);
    expect(warnings.length).toBe(1);
  });
});

describe('fetchSecEarnings', () => {
  it('resolves CIK then fetches submissions and returns capped events', async () => {
    const tickersFixture = await loadFixture('sec-company-tickers.json');
    const submissionsFixture = await loadFixture('sec-submissions-AAPL.json');
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      if (url === SEC_TICKERS_URL) {
        return new Response(tickersFixture, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === `${SEC_SUBMISSIONS_BASE}/CIK0000320193.json`) {
        return new Response(submissionsFixture, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const client = new PoliteFetchClient({ fetchImpl });

    const events = await fetchSecEarnings({
      client,
      symbol: 'aapl', // lower case; must be normalised
      now: () => Date.parse(FETCHED_AT),
    });

    expect(calls[0]).toBe(SEC_TICKERS_URL);
    expect(calls[1]).toBe(`${SEC_SUBMISSIONS_BASE}/CIK0000320193.json`);
    expect(events.length).toBe(4);
    expect(events.every((e) => e.symbol === 'AAPL')).toBe(true);
    expect(events[0]?.fetchedAt).toBe(FETCHED_AT);
  });

  it('skips the ticker-map fetch when a pre-resolved map is supplied', async () => {
    const submissionsFixture = await loadFixture('sec-submissions-AAPL.json');
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      if (url === `${SEC_SUBMISSIONS_BASE}/CIK0000320193.json`) {
        return new Response(submissionsFixture, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const client = new PoliteFetchClient({ fetchImpl });

    const events = await fetchSecEarnings({
      client,
      symbol: 'AAPL',
      tickerToCik: new Map([['AAPL', 320193]]),
      now: () => Date.parse(FETCHED_AT),
    });

    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(`${SEC_SUBMISSIONS_BASE}/CIK0000320193.json`);
    expect(events.length).toBe(4);
  });

  it('returns [] and logs when the symbol is unknown to SEC', async () => {
    const tickersFixture = await loadFixture('sec-company-tickers.json');
    const fetchImpl: FetchLike = async () =>
      new Response(tickersFixture, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const client = new PoliteFetchClient({ fetchImpl });
    const warnings: string[] = [];

    const events = await fetchSecEarnings({
      client,
      symbol: 'NOPE',
      now: () => Date.parse(FETCHED_AT),
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(events).toEqual([]);
    expect(warnings.some((w) => w.includes('not found'))).toBe(true);
  });

  it('throws on non-2xx submissions responses (source marked stale)', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('boom', { status: 503 });
    const client = new PoliteFetchClient({ fetchImpl, defaultRatePerSec: 1000 });
    await expect(
      fetchSecEarnings({
        client,
        symbol: 'AAPL',
        tickerToCik: new Map([['AAPL', 320193]]),
        now: () => Date.parse(FETCHED_AT),
      }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('throws on invalid JSON from ticker-map endpoint', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === SEC_TICKERS_URL) {
        return new Response('not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const client = new PoliteFetchClient({ fetchImpl });
    await expect(
      fetchSecEarnings({
        client,
        symbol: 'AAPL',
        now: () => Date.parse(FETCHED_AT),
      }),
    ).rejects.toThrow(/invalid JSON from ticker map/);
  });
});
