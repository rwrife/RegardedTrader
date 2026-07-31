import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PoliteFetchClient } from './http.js';
import { TickerResolutionError, TickerResolver } from './resolver.js';
import type { TickerSource } from './source.js';
import { createNasdaqTraderTickerSource } from './sources/nasdaq-trader.js';
import { createSecEdgarTickerSource } from './sources/sec.js';
import { createYahooTickerSource } from './sources/yahoo.js';

const RUN_LIVE_TICKER_TESTS = process.env.RUN_LIVE_TICKER_TESTS === '1';
const liveDescribe = RUN_LIVE_TICKER_TESTS ? describe : describe.skip;

liveDescribe('tickers live smoke', () => {
  async function fetchAny(
    sources: ReadonlyArray<TickerSource>,
    input: string,
    alternates: ReadonlyArray<string> = [],
  ) {
    const candidates = [input, ...alternates];
    for (const candidate of candidates) {
      for (const source of sources) {
        const profile = await source.fetch(candidate);
        if (profile !== null) {
          return profile;
        }
      }
    }
    return null;
  }

  it(
    'resolves a real-world symbol set and rejects a known non-equity index symbol',
    async () => {
      const cacheDir = await mkdtemp(join(tmpdir(), 'rt-live-tickers-'));
      try {
        const client = new PoliteFetchClient({
          defaultRatePerSec: 2,
          perHostRatePerSec: {
            'www.sec.gov': 1,
            'data.sec.gov': 1,
          },
        });

        const sources: TickerSource[] = [
          createSecEdgarTickerSource({
            client,
            cacheDir,
            operatorContact: process.env.OPERATOR_CONTACT ?? 'regardedtrader-live-tests@example.invalid',
          }),
          createYahooTickerSource({ client }),
          createNasdaqTraderTickerSource({ client, cacheDir }),
        ];

        const resolver = new TickerResolver(sources, { timeoutMs: 12_000, conflictThreshold: 0.4 });

        const expectations: Array<{
          input: string;
          acceptable: string[];
          alternates?: string[];
        }> = [
          { input: 'NVDA', acceptable: ['NVDA'] },
          { input: 'AAPL', acceptable: ['AAPL'] },
          { input: 'BRK.B', acceptable: ['BRK.B', 'BRK-B'], alternates: ['BRK-B'] },
          { input: 'TSM', acceptable: ['TSM'] },
          { input: 'SPY', acceptable: ['SPY'] },
        ];

        for (const { input, acceptable, alternates = [] } of expectations) {
          let profile = null;
          try {
            profile = await resolver.resolve(input);
          } catch (error) {
            if (!(error instanceof TickerResolutionError) || error.diagnostics?.kind !== 'conflict') {
              throw error;
            }
            profile = await fetchAny(sources, input, alternates);
          }

          expect(profile).not.toBeNull();
          if (profile === null) {
            continue;
          }

          expect(acceptable).toContain(profile.symbol);
          expect(typeof profile.name).toBe('string');
          expect(typeof profile.exchange).toBe('string');
          expect(Array.isArray(profile.sourceUrls)).toBe(true);

          if (
            typeof profile.name !== 'string' ||
            typeof profile.exchange !== 'string' ||
            !Array.isArray(profile.sourceUrls)
          ) {
            throw new Error(`live ticker profile missing required fields for ${input}`);
          }

          expect(profile.name.length).toBeGreaterThan(1);
          expect(profile.exchange.length).toBeGreaterThan(1);
          expect(profile.sourceUrls.length).toBeGreaterThan(0);

          // Partial profiles from individual sources may omit these optional fields.
          if ('validatedAt' in profile && typeof profile.validatedAt === 'string') {
            expect(profile.validatedAt.length).toBeGreaterThan(10);
          }
          if ('confidence' in profile && typeof profile.confidence === 'number') {
            expect(profile.confidence).toBeGreaterThan(0);
          }
        }

        await expect(resolver.resolve('^GSPC')).rejects.toBeInstanceOf(TickerResolutionError);
      } finally {
        await rm(cacheDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
