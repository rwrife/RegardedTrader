/**
 * Options-chain helpers shared by the CLI `regard options <SYM>` screen and
 * the web `#/options/:sym` route (issue #155).
 *
 * Two responsibilities:
 *   1. Group a flat `OptionContract[]` (calls + puts) into per-strike rows so
 *      both surfaces render the same "strike | call | put" table without
 *      duplicating layout logic.
 *   2. Fill in missing greeks deterministically via BSM whenever the contract
 *      has enough inputs (spot + strike + expiry + iv). The market-data
 *      providers we ship rarely return greeks; computing them once here keeps
 *      both surfaces consistent and unit-testable.
 *
 * Pure functions only — no I/O. Inputs are validated `OptionContract` values
 * (the schema in `schemas/index.ts`); outputs preserve the same shape so
 * callers can keep passing the result through existing Zod-validated paths.
 */
import type { OptionContract } from '../schemas/index.js';
import { greeks } from './bsm.js';

export interface ChainRow {
  strike: number;
  call: OptionContract | null;
  put: OptionContract | null;
}

/**
 * Group a flat list of `OptionContract` (mixed calls + puts, possibly across
 * multiple expirations) into per-strike rows. Rows are sorted by strike
 * ascending. If multiple contracts share the same strike+type, the first one
 * wins (callers should pre-filter by expiry).
 */
export function groupChainByStrike(contracts: ReadonlyArray<OptionContract>): ChainRow[] {
  const byStrike = new Map<number, ChainRow>();
  for (const c of contracts) {
    const row = byStrike.get(c.strike) ?? { strike: c.strike, call: null, put: null };
    if (c.type === 'call' && row.call === null) row.call = c;
    else if (c.type === 'put' && row.put === null) row.put = c;
    byStrike.set(c.strike, row);
  }
  return Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
}

/**
 * Year fraction from `asOf` (ISO timestamp or YYYY-MM-DD) to the contract
 * `expiry` (YYYY-MM-DD), using a 365-day year. Returns `null` if either side
 * is unparseable or the result is non-positive (expired / same-day).
 *
 * Exported for tests; the greek filler uses it internally.
 */
export function yearsToExpiry(asOf: string, expiry: string): number | null {
  const a = Date.parse(asOf);
  // Anchor expiry to end-of-day UTC so a 1-day-out option doesn't collapse to
  // T≈0 just because the timestamps are at different times of day.
  const e = Date.parse(`${expiry}T23:59:59Z`);
  if (!Number.isFinite(a) || !Number.isFinite(e)) return null;
  const years = (e - a) / (365 * 24 * 60 * 60 * 1000);
  return years > 0 ? years : null;
}

export interface FillGreeksOptions {
  /** Underlying spot price. Required for BSM. */
  spot: number;
  /** Risk-free rate (annualized, decimal). Defaults to 0.05 (5%). */
  riskFreeRate?: number;
  /** Continuous dividend yield. Defaults to 0. */
  dividendYield?: number;
  /** Reference timestamp for time-to-expiry. Defaults to `new Date().toISOString()`. */
  asOf?: string;
}

/**
 * Return a copy of each contract with `delta`/`gamma`/`theta`/`vega` filled in
 * from BSM whenever:
 *   - the contract is missing the greek (`null`/`undefined`),
 *   - spot > 0, strike > 0, iv > 0, and time-to-expiry > 0.
 *
 * Contracts that don't have enough data pass through unchanged. We never
 * overwrite a greek the upstream feed already provided — broker-provided
 * greeks include skew/early-exercise effects our BSM model ignores.
 *
 * Theta is rescaled to per-day (matches the conventional broker display);
 * vega is rescaled to "per 1% vol move" for the same reason.
 */
export function fillGreeks(
  contracts: ReadonlyArray<OptionContract>,
  opts: FillGreeksOptions,
): OptionContract[] {
  const { spot } = opts;
  const r = opts.riskFreeRate ?? 0.05;
  const q = opts.dividendYield ?? 0;
  const asOf = opts.asOf ?? new Date().toISOString();
  if (!(spot > 0)) return contracts.map((c) => ({ ...c }));

  return contracts.map((c) => {
    const sigma = c.iv;
    if (sigma == null || !(sigma > 0)) return { ...c };
    const T = yearsToExpiry(asOf, c.expiry);
    if (T == null) return { ...c };
    if (!(c.strike > 0)) return { ...c };
    let g: ReturnType<typeof greeks>;
    try {
      g = greeks({ S: spot, K: c.strike, T, r, sigma, q, type: c.type });
    } catch {
      // BSM rejects pathological inputs (e.g. sigma <= 0 after rounding).
      // Pass the contract through unchanged rather than poisoning the row.
      return { ...c };
    }
    return {
      ...c,
      delta: c.delta ?? round4(g.delta),
      gamma: c.gamma ?? round4(g.gamma),
      // Per-day theta, per-1%-vol vega — the conventional broker display.
      theta: c.theta ?? round4(g.theta / 365),
      vega: c.vega ?? round4(g.vega / 100),
    };
  });
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
