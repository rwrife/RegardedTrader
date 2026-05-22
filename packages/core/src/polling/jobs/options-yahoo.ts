/**
 * Yahoo Finance adapter for the options-chain poller (#23).
 *
 * Wraps `yahoo-finance2`'s `options()` endpoint behind the framework-free
 * {@link OptionsChainFetcher} interface so the poller doesn't reach into
 * any specific provider directly.
 */

import yahooFinance from 'yahoo-finance2';
import type { OptionContract } from '../../schemas/index.js';
import type { OptionsChainFetch, OptionsChainFetcher } from './options.js';

// `yahoo-finance2` does not ship strict types for the raw contract rows we
// consume here, so we widen them to `unknown` and validate fields one at a
// time. This keeps the rest of `core` free of `any`.
interface RawContract {
  contractSymbol?: unknown;
  expiration?: unknown;
  strike?: unknown;
  bid?: unknown;
  ask?: unknown;
  lastPrice?: unknown;
  volume?: unknown;
  openInterest?: unknown;
  impliedVolatility?: unknown;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function intOrNull(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < 0) return null;
  return Math.trunc(v);
}

function expiryYmd(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Yahoo emits epoch seconds for `expiration`; tolerate ms too.
    const ms = raw > 1e12 ? raw : raw * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof raw === 'string') {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return '';
}

function toContract(
  raw: RawContract,
  underlying: string,
  type: 'call' | 'put',
): OptionContract | null {
  const symbol = typeof raw.contractSymbol === 'string' ? raw.contractSymbol : null;
  const strike = numOrNull(raw.strike);
  const expiry = expiryYmd(raw.expiration);
  if (!symbol || strike === null || !expiry) return null;
  return {
    symbol,
    underlying: underlying.toUpperCase(),
    expiry,
    strike,
    type,
    bid: numOrNull(raw.bid),
    ask: numOrNull(raw.ask),
    last: numOrNull(raw.lastPrice),
    volume: intOrNull(raw.volume),
    openInterest: intOrNull(raw.openInterest),
    iv: numOrNull(raw.impliedVolatility),
  };
}

/**
 * Build an {@link OptionsChainFetcher} backed by `yahoo-finance2`.
 *
 * The adapter only touches the documented `options()` endpoint and returns
 * the underlying spot from `quote.regularMarketPrice` when present.
 */
export function createYahooOptionsFetcher(): OptionsChainFetcher {
  return {
    async expirations(symbol: string): Promise<readonly Date[]> {
      const res = await yahooFinance.options(symbol, {});
      const dates = res?.expirationDates;
      if (!Array.isArray(dates)) return [];
      return dates
        .map((d: unknown) => {
          if (d instanceof Date) return d;
          if (typeof d === 'number' && Number.isFinite(d)) {
            const ms = d > 1e12 ? d : d * 1000;
            return new Date(ms);
          }
          if (typeof d === 'string') {
            const x = new Date(d);
            return Number.isNaN(x.getTime()) ? null : x;
          }
          return null;
        })
        .filter((d): d is Date => d !== null)
        .sort((a, b) => a.getTime() - b.getTime());
    },

    async chain(symbol: string, expiry: Date): Promise<OptionsChainFetch> {
      const res = await yahooFinance.options(symbol, { date: expiry });
      const chain = res?.options?.[0];
      const price = numOrNull(res?.quote?.regularMarketPrice);
      if (!chain) return { contracts: [], underlyingPrice: price };
      const calls = Array.isArray(chain.calls) ? (chain.calls as RawContract[]) : [];
      const puts = Array.isArray(chain.puts) ? (chain.puts as RawContract[]) : [];
      const contracts: OptionContract[] = [];
      for (const c of calls) {
        const v = toContract(c, symbol, 'call');
        if (v) contracts.push(v);
      }
      for (const p of puts) {
        const v = toContract(p, symbol, 'put');
        if (v) contracts.push(v);
      }
      return { contracts, underlyingPrice: price };
    },
  };
}
