import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import yahooFinance from 'yahoo-finance2';
import { createYahooHistoryFetcher, createYahooQuoteSource } from './quote-yahoo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readJsonFixture<T>(name: string): T {
  const raw = readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
  return JSON.parse(raw) as T;
}

describe('createYahooQuoteSource', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps a recorded Yahoo quote payload into the Quote schema shape', async () => {
    const fixture = readJsonFixture<Record<string, unknown>>('quote-yahoo-quote.json');
    const quoteSpy = vi.spyOn(yahooFinance, 'quote').mockResolvedValue(fixture);

    const source = createYahooQuoteSource();
    const out = await source.quote('nvda');

    expect(quoteSpy).toHaveBeenCalledWith('NVDA');
    expect(out.symbol).toBe('NVDA');
    expect(out.price).toBe(1187.5);
    expect(out.change).toBe(12.34);
    expect(out.changePercent).toBe(1.05);
    expect(out.volume).toBe(123456789);
    expect(out.marketCap).toBe(2919100000000);
    expect(typeof out.asOf).toBe('string');
  });

  it('maps a recorded Yahoo daily history payload into OHLCV bars', async () => {
    type HistoryRow = {
      date: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    };
    const fixture = readJsonFixture<HistoryRow[]>('quote-yahoo-history.json').map((row) => ({
      date: new Date(row.date),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    }));
    const historySpy = vi.spyOn(yahooFinance, 'historical').mockResolvedValue(fixture);

    const fetcher = createYahooHistoryFetcher();
    const out = await fetcher.history('nvda', 30);

    expect(historySpy).toHaveBeenCalledTimes(1);
    expect(historySpy.mock.calls[0]?.[0]).toBe('NVDA');
    expect(out).toEqual([
      { t: '2026-05-19', o: 1160.1, h: 1180.4, l: 1155.2, c: 1178.8, v: 50123000 },
      { t: '2026-05-20', o: 1179.4, h: 1192.6, l: 1170.3, c: 1187.5, v: 48912000 },
    ]);
  });
});
