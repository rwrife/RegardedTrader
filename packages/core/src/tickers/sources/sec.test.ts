import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PoliteFetchClient, type FetchLike } from '../http.js';
import {
  createSecEdgarTickerSource,
  mapSicToSector,
  padCik,
  parseSecSubmissionsProfile,
  parseSecTickerDirectory,
  SEC_SUBMISSIONS_BASE,
  SEC_TICKERS_URL,
} from './sec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture(name: string): Promise<string> {
  return readFile(join(__dirname, '__fixtures__', name), 'utf8');
}

describe('parseSecTickerDirectory', () => {
  it('parses symbol/name/cik rows from SEC company_tickers payload', async () => {
    const json = JSON.parse(await loadFixture('sec-company-tickers-sample.json'));
    const rows = parseSecTickerDirectory(json);

    expect(rows.map((r) => r.symbol)).toEqual(['AAPL', 'MSFT', 'NVDA']);
    expect(rows[0]).toMatchObject({
      symbol: 'AAPL',
      name: 'Apple Inc.',
      cik: 320193,
      sourceUrl: SEC_TICKERS_URL,
    });
  });
});

describe('parseSecSubmissionsProfile', () => {
  it('extracts profile metadata from submissions payload', async () => {
    const json = JSON.parse(await loadFixture('sec-submissions-AAPL-profile.json'));
    const parsed = parseSecSubmissionsProfile(json);

    expect(parsed).toMatchObject({
      symbol: 'AAPL',
      name: 'Apple Inc.',
      cik: 320193,
      sicCode: '3571',
      sicDescription: 'Electronic Computers',
      exchange: 'Nasdaq',
      country: 'US',
      website: 'https://www.apple.com/',
    });
  });
});

describe('mapSicToSector', () => {
  it('maps SIC prefixes to coarse sectors', () => {
    expect(mapSicToSector('3571')).toBe('Manufacturing');
    expect(mapSicToSector('6021')).toBe('Finance');
    expect(mapSicToSector('7370')).toBe('Services');
    expect(mapSicToSector('')).toBeNull();
  });
});

describe('createSecEdgarTickerSource', () => {
  it('exposes expected name/weight and validates weight bounds', () => {
    const client = new PoliteFetchClient({
      fetchImpl: async () => new Response('{}', { status: 200 }),
      sleep: async () => {},
    });

    const src = createSecEdgarTickerSource({ client });
    expect(src.name).toBe('sec-edgar');
    expect(src.weight).toBeCloseTo(0.95);

    expect(() => createSecEdgarTickerSource({ client, weight: -0.01 })).toThrow(/weight/);
    expect(() => createSecEdgarTickerSource({ client, weight: 1.01 })).toThrow(/weight/);
  });

  it('fetch() by symbol loads ticker directory then submissions and maps SIC fields', async () => {
    const tickersBody = await loadFixture('sec-company-tickers-sample.json');
    const submissionsBody = await loadFixture('sec-submissions-AAPL-profile.json');
    const cacheDir = await mkdtemp(join(tmpdir(), 'rt-sec-fetch-cache-'));

    try {
      const calls: Array<{ url: string; headers: Headers }> = [];
      const fetchImpl: FetchLike = async (input, init) => {
        const url = String(input);
        calls.push({ url, headers: new Headers(init?.headers) });

        if (url === SEC_TICKERS_URL) {
          return new Response(tickersBody, { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url === `${SEC_SUBMISSIONS_BASE}/CIK${padCik(320193)}.json`) {
          return new Response(submissionsBody, { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('not found', { status: 404 });
      };

      const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
      const src = createSecEdgarTickerSource({
        client,
        cacheDir,
        operatorContact: 'sec-ops@example.test',
      });

      const profile = await src.fetch('aapl');
      expect(profile).not.toBeNull();
      expect(profile?.symbol).toBe('AAPL');
      expect(profile?.name).toBe('Apple Inc.');
      expect(profile?.exchange).toBe('NASDAQ');
      expect(profile?.sector).toBe('Manufacturing');
      expect(profile?.industry).toBe('3571 - Electronic Computers');
      expect(profile?.description).toContain('CIK 0000320193');
      expect(profile?.description).toContain('Country: US');
      expect(profile?.description).toContain('Website: https://www.apple.com/');
      expect(profile?.sourceUrls).toEqual([
        SEC_TICKERS_URL,
        `${SEC_SUBMISSIONS_BASE}/CIK${padCik(320193)}.json`,
      ]);

      expect(calls).toHaveLength(2);
      expect(calls[0]?.headers.get('User-Agent')).toBe('RegardedTrader sec-ops@example.test');
      expect(calls[0]?.headers.get('From')).toBe('sec-ops@example.test');
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('fetch() accepts CIK input', async () => {
    const tickersBody = await loadFixture('sec-company-tickers-sample.json');
    const submissionsBody = await loadFixture('sec-submissions-AAPL-profile.json');

    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url === SEC_TICKERS_URL) return new Response(tickersBody, { status: 200 });
      if (url === `${SEC_SUBMISSIONS_BASE}/CIK0000320193.json`) {
        return new Response(submissionsBody, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const src = createSecEdgarTickerSource({ client });

    const profile = await src.fetch('0000320193');
    expect(profile?.symbol).toBe('AAPL');
    expect(profile?.name).toBe('Apple Inc.');
  });

  it('search() performs prefix lookup on symbol and company name', async () => {
    const tickersBody = await loadFixture('sec-company-tickers-sample.json');

    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url === SEC_TICKERS_URL) return new Response(tickersBody, { status: 200 });
      return new Response('not found', { status: 404 });
    };

    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const src = createSecEdgarTickerSource({ client });

    const bySymbol = await src.search('aa');
    expect(bySymbol[0]?.symbol).toBe('AAPL');

    const byName = await src.search('micro');
    expect(byName[0]?.symbol).toBe('MSFT');
  });

  it('reuses a fresh cached ticker directory without network', async () => {
    const tickersBody = await loadFixture('sec-company-tickers-sample.json');
    const cacheDir = await mkdtemp(join(tmpdir(), 'rt-sec-cache-'));

    try {
      let onlineCalls = 0;
      const onlineFetch: FetchLike = async (input) => {
        const url = String(input);
        if (url === SEC_TICKERS_URL) {
          onlineCalls += 1;
          return new Response(tickersBody, { status: 200 });
        }
        return new Response('not found', { status: 404 });
      };

      const now = () => new Date('2026-07-26T00:00:00.000Z');
      const src1 = createSecEdgarTickerSource({
        client: new PoliteFetchClient({ fetchImpl: onlineFetch, sleep: async () => {} }),
        cacheDir,
        now,
      });

      const r1 = await src1.search('aap');
      expect(r1[0]?.symbol).toBe('AAPL');
      expect(onlineCalls).toBe(1);

      const offlineFetch: FetchLike = async () => {
        throw new Error('network should not be used when cache is fresh');
      };
      const src2 = createSecEdgarTickerSource({
        client: new PoliteFetchClient({ fetchImpl: offlineFetch, sleep: async () => {} }),
        cacheDir,
        now,
      });

      const r2 = await src2.search('nvd');
      expect(r2[0]?.symbol).toBe('NVDA');
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
