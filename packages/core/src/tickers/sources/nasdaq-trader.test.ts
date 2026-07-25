import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PoliteFetchClient, type FetchLike } from '../http.js';
import {
  createNasdaqTraderTickerSource,
  NASDAQ_LISTED_URL,
  OTHER_LISTED_URL,
  parseNasdaqListedText,
  parseOtherListedText,
} from './nasdaq-trader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture(name: string): Promise<string> {
  return readFile(join(__dirname, '__fixtures__', name), 'utf8');
}

describe('parseNasdaqListedText', () => {
  it('parses rows, drops Test Issue entries, and maps exchange/type', async () => {
    const text = await loadFixture('nasdaqlisted-sample.txt');
    const rows = parseNasdaqListedText(text);
    expect(rows.map((r) => r.symbol)).toEqual(['AAPL', 'QQQ']);

    expect(rows[0]).toMatchObject({
      symbol: 'AAPL',
      exchange: 'NASDAQ',
      securityType: 'Common Stock',
    });
    expect(rows[1]).toMatchObject({
      symbol: 'QQQ',
      exchange: 'NASDAQ',
      securityType: 'ETF',
    });
  });
});

describe('parseOtherListedText', () => {
  it('parses rows, drops Test Issue entries, and maps exchange codes', async () => {
    const text = await loadFixture('otherlisted-sample.txt');
    const rows = parseOtherListedText(text);
    expect(rows.map((r) => r.symbol)).toEqual(['IBM', 'SPY']);

    expect(rows[0]).toMatchObject({
      symbol: 'IBM',
      exchange: 'NYSE',
      securityType: 'Common Stock',
    });
    expect(rows[1]).toMatchObject({
      symbol: 'SPY',
      exchange: 'NYSEARCA',
      securityType: 'ETF',
    });
  });
});

describe('createNasdaqTraderTickerSource', () => {
  it('exposes expected name/weight and validates weight bounds', () => {
    const client = new PoliteFetchClient({
      fetchImpl: async () => new Response('', { status: 200 }),
      sleep: async () => {},
    });

    const src = createNasdaqTraderTickerSource({ client });
    expect(src.name).toBe('nasdaq-trader');
    expect(src.weight).toBeCloseTo(0.85);

    expect(() => createNasdaqTraderTickerSource({ client, weight: -0.01 })).toThrow(/weight/);
    expect(() => createNasdaqTraderTickerSource({ client, weight: 1.01 })).toThrow(/weight/);
  });

  it('fetch() performs exact symbol lookup from merged files', async () => {
    const listed = await loadFixture('nasdaqlisted-sample.txt');
    const other = await loadFixture('otherlisted-sample.txt');

    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url === NASDAQ_LISTED_URL) {
        return new Response(listed, { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      if (url === OTHER_LISTED_URL) {
        return new Response(other, { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      return new Response('not found', { status: 404 });
    };

    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const src = createNasdaqTraderTickerSource({ client });

    const aapl = await src.fetch('aapl');
    expect(aapl).not.toBeNull();
    expect(aapl?.symbol).toBe('AAPL');
    expect(aapl?.exchange).toBe('NASDAQ');
    expect(aapl?.sourceUrls).toEqual([NASDAQ_LISTED_URL]);

    const ibm = await src.fetch('IBM');
    expect(ibm?.symbol).toBe('IBM');
    expect(ibm?.exchange).toBe('NYSE');
    expect(ibm?.sourceUrls).toEqual([OTHER_LISTED_URL]);

    expect(await src.fetch('MISSING')).toBeNull();
  });

  it('search() supports prefix lookup on symbol and company name', async () => {
    const listed = await loadFixture('nasdaqlisted-sample.txt');
    const other = await loadFixture('otherlisted-sample.txt');

    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url === NASDAQ_LISTED_URL) return new Response(listed, { status: 200 });
      if (url === OTHER_LISTED_URL) return new Response(other, { status: 200 });
      return new Response('not found', { status: 404 });
    };

    const client = new PoliteFetchClient({ fetchImpl, sleep: async () => {} });
    const src = createNasdaqTraderTickerSource({ client });

    const bySymbol = await src.search('AA');
    expect(bySymbol[0]?.symbol).toBe('AAPL');

    const byName = await src.search('spdr');
    expect(byName[0]?.symbol).toBe('SPY');

    const noResults = await src.search('zzzzzzzz');
    expect(noResults).toEqual([]);
  });

  it('reads a fresh cached table from disk and avoids network', async () => {
    const listed = await loadFixture('nasdaqlisted-sample.txt');
    const other = await loadFixture('otherlisted-sample.txt');

    const cacheDir = await mkdtemp(join(tmpdir(), 'rt-nasdaq-cache-'));
    try {
      let calls = 0;
      const onlineFetch: FetchLike = async (input) => {
        calls += 1;
        const url = String(input);
        if (url === NASDAQ_LISTED_URL) return new Response(listed, { status: 200 });
        if (url === OTHER_LISTED_URL) return new Response(other, { status: 200 });
        return new Response('not found', { status: 404 });
      };

      const now = () => new Date('2026-07-25T12:00:00.000Z');
      const onlineClient = new PoliteFetchClient({ fetchImpl: onlineFetch, sleep: async () => {} });
      const src1 = createNasdaqTraderTickerSource({
        client: onlineClient,
        cacheDir,
        now,
      });

      expect((await src1.fetch('AAPL'))?.symbol).toBe('AAPL');
      expect(calls).toBe(2);

      const offlineFetch: FetchLike = async () => {
        throw new Error('network should not be used when cache is fresh');
      };
      const offlineClient = new PoliteFetchClient({ fetchImpl: offlineFetch, sleep: async () => {} });
      const src2 = createNasdaqTraderTickerSource({
        client: offlineClient,
        cacheDir,
        now,
      });

      expect((await src2.fetch('IBM'))?.symbol).toBe('IBM');
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
