/**
 * Options-chain poller (#23, parent #19).
 *
 * For a given symbol, pulls the next `chains` expiries (default 3) from the
 * injected {@link OptionsChainFetcher} and persists one `options` snapshot
 * per (symbol, expiry) pair to the {@link SnapshotStore}. For each snapshot
 * the poller emits an `options.update` event through the optional `onEvent`
 * callback so the in-process event bus / SSE bridge (#25) can fan it out.
 *
 * Each persisted snapshot's `data` payload carries:
 *   - `metrics`   — {@link OptionsChainMetrics} (ATM IV, IV skew, OI / volume
 *                   totals, P/C ratio, contract count)
 *   - `contracts` — the validated {@link OptionContract}[] for the chain
 *
 * The poller is intentionally framework-free: callers inject a fetcher, a
 * clock, and the store. No network, no disk, and no specific provider
 * lives inside this module — the Yahoo adapter lives in
 * `./options-yahoo.ts`.
 */

import { z } from 'zod';
import { OptionContract, Ticker } from '../../schemas/index.js';
import type { SnapshotStore } from '../store.js';

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

const NonNegInt = z.number().int().nonnegative();

/**
 * Top-of-book metrics computed per (symbol, expiry) chain. Fields that
 * cannot be derived from the supplied chain (e.g. ATM IV without an
 * underlying price, or 25Δ skew on a chain that ships no IVs at all) are
 * left `null` rather than guessed.
 */
export const OptionsChainMetrics = z.object({
  symbol: Ticker,
  /** UTC date in `YYYY-MM-DD`. */
  expiry: z.string(),
  /** Underlying spot at fetch time (when the upstream reports it). */
  underlyingPrice: z.number().nullable(),
  /** Average of nearest-strike call & put IV. */
  atmIv: z.number().nullable(),
  /**
   * IV skew, defined as `IV(25Δ put) − IV(25Δ call)`. Positive values
   * indicate richer downside protection (the usual "put skew").
   *
   * When per-contract deltas are available we pick by `|delta|` closest to
   * 0.25; otherwise we fall back to a strike-based proxy (≈ ±10% OTM) and
   * the result is best-effort.
   */
  ivSkew25d: z.number().nullable(),
  openInterest: z.object({
    call: NonNegInt,
    put: NonNegInt,
    total: NonNegInt,
  }),
  volume: z.object({
    call: NonNegInt,
    put: NonNegInt,
    total: NonNegInt,
  }),
  /** Put volume / call volume. `null` when call volume is zero. */
  putCallRatio: z.number().nullable(),
  contractCount: NonNegInt,
});
export type OptionsChainMetrics = z.infer<typeof OptionsChainMetrics>;

/**
 * Persisted snapshot payload for the `options` kind. The store wraps this
 * in a `SnapshotEntry { ts, data: OptionsChainSnapshot }`.
 */
export const OptionsChainSnapshot = z.object({
  metrics: OptionsChainMetrics,
  contracts: z.array(OptionContract),
});
export type OptionsChainSnapshot = z.infer<typeof OptionsChainSnapshot>;

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface OptionsUpdateEvent {
  readonly type: 'options.update';
  readonly symbol: string;
  readonly expiry: string;
  readonly metrics: OptionsChainMetrics;
}

export interface OptionsChainFetch {
  readonly contracts: OptionContract[];
  readonly underlyingPrice: number | null;
}

/**
 * Provider-agnostic options-chain fetcher. Implementations must:
 *   - return upcoming expirations in ascending order from `expirations()`,
 *   - return the chain for the requested expiry from `chain()`.
 *
 * Errors should be thrown; the poller will route them through `onError`.
 */
export interface OptionsChainFetcher {
  expirations(symbol: string): Promise<readonly Date[]>;
  chain(symbol: string, expiry: Date): Promise<OptionsChainFetch>;
}

/** Default number of chains to pull per symbol per poll. */
export const DEFAULT_OPTIONS_CHAINS = 3;

export interface PollOptionsOptions {
  readonly symbol: string;
  readonly store: SnapshotStore;
  readonly fetcher: OptionsChainFetcher;
  /** Number of upcoming expiries to pull. Default 3. */
  readonly chains?: number;
  /** Injectable clock for snapshot `ts`. */
  readonly now?: () => Date;
  /** Optional event sink for `options.update`. */
  readonly onEvent?: (e: OptionsUpdateEvent) => void;
  /**
   * Per-expiry (or whole-fetch) error hook for diagnostics; never thrown.
   * `expiry` is `null` when the failure happened before any expiry could
   * be resolved (e.g. the `expirations()` call itself failed).
   */
  readonly onError?: (expiry: string | null, err: unknown) => void;
}

export interface PollOptionsResult {
  /** Total contracts fetched across all expiries this poll. */
  readonly fetched: number;
  /** Number of (symbol, expiry) snapshots persisted. */
  readonly inserted: number;
  readonly byExpiry: Record<
    string,
    { fetched: number; inserted: boolean; error?: string }
  >;
}

/* -------------------------------------------------------------------------- */
/* Metric helpers                                                             */
/* -------------------------------------------------------------------------- */

function nearestByStrike(
  contracts: readonly OptionContract[],
  price: number,
  type: 'call' | 'put',
): OptionContract | null {
  let best: OptionContract | null = null;
  let bestDist = Infinity;
  for (const c of contracts) {
    if (c.type !== type) continue;
    if (c.iv === null || c.iv === undefined) continue;
    const dist = Math.abs(c.strike - price);
    if (dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

function nearestByAbsDelta(
  contracts: readonly OptionContract[],
  targetAbs: number,
  type: 'call' | 'put',
): OptionContract | null {
  let best: OptionContract | null = null;
  let bestDist = Infinity;
  for (const c of contracts) {
    if (c.type !== type) continue;
    if (c.iv === null || c.iv === undefined) continue;
    if (c.delta === null || c.delta === undefined) continue;
    const dist = Math.abs(Math.abs(c.delta) - targetAbs);
    if (dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Compute {@link OptionsChainMetrics} for a single chain. Exported so the
 * scheduler / tests can compute against synthetic chains without going
 * through the full poller.
 */
export function computeChainMetrics(
  symbol: string,
  expiry: string,
  contracts: readonly OptionContract[],
  underlyingPrice: number | null,
): OptionsChainMetrics {
  let callOi = 0;
  let putOi = 0;
  let callVol = 0;
  let putVol = 0;

  for (const c of contracts) {
    const oi = c.openInterest ?? 0;
    const vol = c.volume ?? 0;
    if (c.type === 'call') {
      callOi += oi;
      callVol += vol;
    } else {
      putOi += oi;
      putVol += vol;
    }
  }

  let atmIv: number | null = null;
  if (underlyingPrice !== null && contracts.length > 0) {
    const ivs: number[] = [];
    for (const t of ['call', 'put'] as const) {
      const n = nearestByStrike(contracts, underlyingPrice, t);
      if (n && n.iv !== null && n.iv !== undefined) ivs.push(n.iv);
    }
    if (ivs.length > 0) {
      atmIv = ivs.reduce((a, b) => a + b, 0) / ivs.length;
    }
  }

  let ivSkew25d: number | null = null;
  const hasDeltas = contracts.some(
    (c) => c.delta !== null && c.delta !== undefined,
  );
  if (hasDeltas) {
    const put25 = nearestByAbsDelta(contracts, 0.25, 'put');
    const call25 = nearestByAbsDelta(contracts, 0.25, 'call');
    if (put25?.iv != null && call25?.iv != null) {
      ivSkew25d = put25.iv - call25.iv;
    }
  } else if (underlyingPrice !== null) {
    // Strike-based proxy when greeks are absent: ≈10% OTM each side.
    const putStrike = underlyingPrice * 0.9;
    const callStrike = underlyingPrice * 1.1;
    const put = nearestByStrike(contracts, putStrike, 'put');
    const call = nearestByStrike(contracts, callStrike, 'call');
    if (put?.iv != null && call?.iv != null) {
      ivSkew25d = put.iv - call.iv;
    }
  }

  const putCallRatio = callVol > 0 ? putVol / callVol : null;

  return OptionsChainMetrics.parse({
    symbol: symbol.toUpperCase(),
    expiry,
    underlyingPrice,
    atmIv,
    ivSkew25d,
    openInterest: { call: callOi, put: putOi, total: callOi + putOi },
    volume: { call: callVol, put: putVol, total: callVol + putVol },
    putCallRatio,
    contractCount: contracts.length,
  });
}

/* -------------------------------------------------------------------------- */
/* Poller                                                                     */
/* -------------------------------------------------------------------------- */

function expiryYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * Poll the options chain for `symbol` across the next `chains` expiries,
 * compute per-chain metrics, persist a snapshot per expiry, and emit one
 * `options.update` event per persisted snapshot.
 *
 * Per-expiry fetch failures are routed through `onError` and do NOT abort
 * the remaining expiries — the poller is best-effort per chain. A failure
 * on `expirations()` itself reports with `expiry === null` and returns an
 * empty result.
 */
export async function pollOptions(
  opts: PollOptionsOptions,
): Promise<PollOptionsResult> {
  const sym = Ticker.parse(opts.symbol.toUpperCase());
  const chains = Math.max(0, Math.floor(opts.chains ?? DEFAULT_OPTIONS_CHAINS));
  const now = opts.now ?? (() => new Date());
  const byExpiry: Record<
    string,
    { fetched: number; inserted: boolean; error?: string }
  > = {};

  if (chains === 0) {
    return { fetched: 0, inserted: 0, byExpiry };
  }

  let expirations: readonly Date[];
  try {
    expirations = await opts.fetcher.expirations(sym);
  } catch (e) {
    opts.onError?.(null, e);
    return { fetched: 0, inserted: 0, byExpiry };
  }

  const picked = expirations.slice(0, chains);
  let fetched = 0;
  let inserted = 0;

  for (const exp of picked) {
    const expiry = expiryYmd(exp);
    byExpiry[expiry] = { fetched: 0, inserted: false };
    try {
      const res = await opts.fetcher.chain(sym, exp);
      // Defensive copy + Zod validation per contract — drops anything that
      // doesn't satisfy the schema (the poller stays strict at the boundary).
      const contracts: OptionContract[] = [];
      for (const c of res.contracts) {
        const parsed = OptionContract.safeParse(c);
        if (parsed.success) contracts.push(parsed.data);
      }
      byExpiry[expiry].fetched = contracts.length;
      fetched += contracts.length;

      const metrics = computeChainMetrics(
        sym,
        expiry,
        contracts,
        res.underlyingPrice,
      );
      const snapshot = OptionsChainSnapshot.parse({ metrics, contracts });
      const written = await opts.store.appendSnapshot(sym, 'options', {
        ts: now().toISOString(),
        data: snapshot,
      });
      if (written !== null) {
        inserted += 1;
        byExpiry[expiry].inserted = true;
        opts.onEvent?.({
          type: 'options.update',
          symbol: sym,
          expiry,
          metrics,
        });
      }
    } catch (e) {
      byExpiry[expiry].error = (e as Error).message ?? 'fetch failed';
      opts.onError?.(expiry, e);
    }
  }

  return { fetched, inserted, byExpiry };
}
