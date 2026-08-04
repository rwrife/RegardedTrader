import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import yahooFinance from 'yahoo-finance2';
import { createYahooOptionsFetcher } from './options-yahoo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readJsonFixture<T>(name: string): T {
  const raw = readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
  return JSON.parse(raw) as T;
}

describe('createYahooOptionsFetcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses mixed expiration date formats from a recorded payload', async () => {
    const fixture = readJsonFixture<Record<string, unknown>>('options-yahoo-expirations.json');
    const optionsSpy = vi.spyOn(yahooFinance, 'options').mockResolvedValue(fixture);

    const fetcher = createYahooOptionsFetcher();
    const out = await fetcher.expirations('nvda');

    expect(optionsSpy).toHaveBeenCalledWith('nvda', {});
    expect(out.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-08-18', '2026-12-18']);
  });

  it('maps recorded chain rows and drops malformed contracts', async () => {
    const fixture = readJsonFixture<Record<string, unknown>>('options-yahoo-chain.json');
    vi.spyOn(yahooFinance, 'options').mockResolvedValue(fixture);

    const fetcher = createYahooOptionsFetcher();
    const out = await fetcher.chain('nvda', new Date('2026-12-18T00:00:00.000Z'));

    expect(out.underlyingPrice).toBe(1187.5);
    expect(out.contracts).toHaveLength(2);
    expect(out.contracts[0]).toEqual({
      symbol: 'NVDA261218C00120000',
      underlying: 'NVDA',
      expiry: '2026-12-18',
      strike: 1200,
      type: 'call',
      bid: 41.2,
      ask: 42.5,
      last: 41.8,
      volume: 2123,
      openInterest: 9321,
      iv: 0.44,
    });
    expect(out.contracts[1]).toEqual({
      symbol: 'NVDA261218P00110000',
      underlying: 'NVDA',
      expiry: '2026-12-18',
      strike: 1100,
      type: 'put',
      bid: 22.1,
      ask: 23.2,
      last: 22.9,
      volume: 1765,
      openInterest: 8012,
      iv: 0.41,
    });
  });
});
