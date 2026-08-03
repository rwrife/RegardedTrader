import { describe, expect, it } from 'vitest';
import { PoliteFetchClient } from '../tickers/http.js';
import { fetchNasdaqEarnings } from './sources/earnings-nasdaq.js';
import { fetchSecEarnings } from './sources/earnings-sec.js';
import { fetchYahooEarnings } from './sources/earnings-yahoo.js';
import { fetchFedHolidays } from './sources/fed.js';
import { fetchNyseHolidays } from './sources/nyse.js';

const RUN_LIVE_CALENDAR_TESTS = process.env.RUN_LIVE_CALENDAR_TESTS === '1';
const liveDescribe = RUN_LIVE_CALENDAR_TESTS ? describe : describe.skip;

liveDescribe('calendar live smoke', () => {
  it(
    'hits live holiday and earnings endpoints without throwing',
    async () => {
      const client = new PoliteFetchClient({
        defaultRatePerSec: 1,
        perHostRatePerSec: {
          'www.sec.gov': 1,
          'data.sec.gov': 1,
        },
      });

      const [nyse, fed, yahoo, nasdaq, sec] = await Promise.all([
        fetchNyseHolidays({ client }),
        fetchFedHolidays({ client }),
        fetchYahooEarnings({ client, symbol: 'NVDA' }),
        fetchNasdaqEarnings({
          client,
          symbols: ['NVDA'],
          from: new Date(),
          horizonDays: 7,
        }),
        fetchSecEarnings({
          client,
          symbol: 'AAPL',
        }),
      ]);

      expect(Array.isArray(nyse)).toBe(true);
      expect(Array.isArray(fed)).toBe(true);
      expect(Array.isArray(yahoo)).toBe(true);
      expect(Array.isArray(nasdaq)).toBe(true);
      expect(Array.isArray(sec)).toBe(true);
      expect(nyse.length).toBeGreaterThan(0);
      expect(fed.length).toBeGreaterThan(0);
      expect(sec.length).toBeGreaterThan(0);
    },
    180_000,
  );
});
