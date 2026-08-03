import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SnapshotStore } from './store.js';
import { pollNews } from './jobs/news.js';
import { pollOptions } from './jobs/options.js';
import { createYahooOptionsFetcher } from './jobs/options-yahoo.js';
import { createYahooHistoryFetcher, createYahooQuoteSource } from './jobs/quote-yahoo.js';
import { pollQuote } from './jobs/quote.js';
import { createCnbcQuoteSource } from './jobs/quote-cnbc.js';

const RUN_LIVE_POLLING_TESTS = process.env.RUN_LIVE_POLLING_TESTS === '1';
const liveDescribe = RUN_LIVE_POLLING_TESTS ? describe : describe.skip;

liveDescribe('polling live smoke', () => {
  const isTransientLiveFailure = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return /(Too Many Requests|HTTP 429|HTTP 5\d{2}|ENOTFOUND|ECONNRESET|ECONNREFUSED|timed out|fetch failed|invalid json response body)/i.test(
      message,
    );
  };

  it(
    'runs one short quote/options/news cycle against live endpoints',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'rt-live-polling-'));
      try {
        const store = new SnapshotStore({ root });
        const symbol = 'NVDA';
        let successes = 0;

        try {
          const quoteResult = await pollQuote({
            symbol,
            store,
            sources: [createYahooQuoteSource(), createCnbcQuoteSource()],
            historyFetcher: createYahooHistoryFetcher(),
          });
          expect(quoteResult.ok).toBe(true);
          expect(['yahoo', 'cnbc']).toContain(quoteResult.source);
          successes += 1;
        } catch (error) {
          if (!isTransientLiveFailure(error)) throw error;
        }

        try {
          const optionsResult = await pollOptions({
            symbol,
            store,
            fetcher: createYahooOptionsFetcher(),
            chains: 1,
          });
          expect(optionsResult.fetched).toBeGreaterThanOrEqual(0);
          expect(optionsResult.inserted).toBeGreaterThanOrEqual(0);
          successes += 1;
        } catch (error) {
          if (!isTransientLiveFailure(error)) throw error;
        }

        try {
          const newsResult = await pollNews({
            symbol,
            store,
          });
          expect(newsResult.fetched).toBeGreaterThanOrEqual(0);
          expect(newsResult.inserted).toBeGreaterThanOrEqual(0);
          successes += 1;
        } catch (error) {
          if (!isTransientLiveFailure(error)) throw error;
        }

        expect(successes).toBeGreaterThanOrEqual(1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
