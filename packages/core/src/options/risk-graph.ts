/**
 * Risk-graph / payoff-at-expiry calculator for multi-leg option structures.
 *
 * Pure function. Given a list of legs and an underlying-price sample range,
 * returns the P/L series at expiry, all break-even points (linear-interpolated
 * sign changes), max loss, and max gain. `maxGain` is `null` for unbounded
 * structures (e.g. long call). `maxLoss` is always finite for defined-risk
 * structures and can be `null` for naked short legs whose loss is unbounded.
 *
 * Conventions:
 *   - All P/L is in **dollars** (not per-share). `qty` is **number of
 *     contracts**, each contract is 100 shares (standard US equity options).
 *   - `premium` is the **per-share** cost of the leg. A $2.50 mid-mark option
 *     contributes $250 of cost per contract; pass `premium: 2.5`.
 *   - `side` is the customer-facing 'long' (paid debit) / 'short' (received
 *     credit) view, independent of `qty` sign.
 *
 * Part of issue #76.
 */

import type { OptionType } from './bsm.js';

export type { OptionType };
export type LegSide = 'long' | 'short';

export interface RiskGraphLeg {
  side: LegSide;
  type: OptionType;
  /** Strike, must be > 0. */
  strike: number;
  /** Number of contracts. Must be a positive integer. */
  qty: number;
  /** Per-share premium paid (long) or received (short). Must be >= 0. */
  premium: number;
}

export interface RiskGraphPoint {
  underlying: number;
  pnl: number;
}

export interface RiskGraph {
  /** Underlying-price grid used to sample the payoff. */
  underlying: number[];
  /** P/L in dollars at each underlying-price sample. */
  pnl: number[];
  /** Underlying prices where pnl crosses zero. May be empty. */
  breakevens: number[];
  /** Worst-case loss in dollars (negative number) or null if unbounded. */
  maxLoss: number | null;
  /** Best-case gain in dollars (positive number) or null if unbounded. */
  maxGain: number | null;
  /** Net debit (>0) or credit (<0) in dollars for the whole structure. */
  netDebit: number;
}

export interface RiskGraphOptions {
  /** Underlying low edge of the plot. Defaults to derived from strikes. */
  uLo?: number;
  /** Underlying high edge of the plot. Defaults to derived from strikes. */
  uHi?: number;
  /** Number of sample points. Default 101. Must be >= 3. */
  steps?: number;
}

/** Payoff at expiry, per share, for a single leg at underlying S. */
function legPayoffPerShare(leg: RiskGraphLeg, S: number): number {
  const intrinsic =
    leg.type === 'call' ? Math.max(0, S - leg.strike) : Math.max(0, leg.strike - S);
  const sign = leg.side === 'long' ? 1 : -1;
  // long: payoff = intrinsic - premium; short: payoff = premium - intrinsic
  return sign * intrinsic - sign * leg.premium;
}

/** Dollar payoff for a single leg at expiry: per-share * qty * 100. */
function legPayoffDollars(leg: RiskGraphLeg, S: number): number {
  return legPayoffPerShare(leg, S) * leg.qty * 100;
}

/**
 * Slope of the total payoff as S -> +∞ (per $1 of underlying). Long calls
 * contribute +qty*100, short calls contribute -qty*100. Puts contribute 0
 * (their value is capped at the strike going up).
 */
function slopeAtPlusInfinity(legs: RiskGraphLeg[]): number {
  let s = 0;
  for (const l of legs) {
    if (l.type !== 'call') continue;
    s += (l.side === 'long' ? 1 : -1) * l.qty * 100;
  }
  return s;
}

/**
 * Slope as S -> 0 (per $1 of underlying, as S decreases). Long puts pay off
 * as S falls so their slope (dPnL/dS) is negative. We return slope in the
 * dPnL/dS sense — a *positive* value here means PnL increases as S decreases
 * (i.e. unbounded gain to the downside if value is large in absolute terms).
 *
 * Specifically returns dPnL/dS at S=0+, which is negative for long puts
 * (you make money as S falls below strike). A long put has slope -qty*100.
 */
function slopeAtZero(legs: RiskGraphLeg[]): number {
  let s = 0;
  for (const l of legs) {
    if (l.type !== 'put') continue;
    // Long put intrinsic = K - S for S < K, so dIntrinsic/dS = -1.
    // Short put: opposite sign.
    s += (l.side === 'long' ? -1 : 1) * l.qty * 100;
  }
  return s;
}

function defaultRange(legs: RiskGraphLeg[]): { uLo: number; uHi: number } {
  const strikes = legs.map((l) => l.strike);
  const minK = Math.min(...strikes);
  const maxK = Math.max(...strikes);
  // Pad by 50% on each side; clamp lo to 0.
  const pad = Math.max(maxK * 0.5, 1);
  return {
    uLo: Math.max(0, minK - pad),
    uHi: maxK + pad,
  };
}

function validate(legs: RiskGraphLeg[]): void {
  if (legs.length === 0) throw new RangeError('riskGraph: legs must be non-empty');
  for (const l of legs) {
    if (!(l.strike > 0)) {
      throw new RangeError(`riskGraph: leg strike must be > 0, got ${l.strike}`);
    }
    if (!(Number.isInteger(l.qty) && l.qty > 0)) {
      throw new RangeError(`riskGraph: leg qty must be a positive integer, got ${l.qty}`);
    }
    if (!(l.premium >= 0)) {
      throw new RangeError(`riskGraph: leg premium must be >= 0, got ${l.premium}`);
    }
  }
}

/** Compute the full risk graph for a multi-leg structure. */
export function riskGraph(legs: RiskGraphLeg[], opts: RiskGraphOptions = {}): RiskGraph {
  validate(legs);

  const defaults = defaultRange(legs);
  const uLo = opts.uLo ?? defaults.uLo;
  const uHi = opts.uHi ?? defaults.uHi;
  const steps = opts.steps ?? 101;
  if (!(uHi > uLo)) throw new RangeError('riskGraph: uHi must be > uLo');
  if (!(Number.isInteger(steps) && steps >= 3)) {
    throw new RangeError('riskGraph: steps must be an integer >= 3');
  }

  // Net debit (>0) or credit (<0). Long legs pay premium, short legs receive.
  let netDebit = 0;
  for (const l of legs) {
    const sign = l.side === 'long' ? 1 : -1;
    netDebit += sign * l.premium * l.qty * 100;
  }

  const underlying: number[] = new Array(steps);
  const pnl: number[] = [];

  // Always include strikes themselves in the sample set so breakeven detection
  // is exact at kink points. We do this by building a base grid then merging.
  const dx = (uHi - uLo) / (steps - 1);
  for (let i = 0; i < steps; i++) {
    underlying[i] = uLo + i * dx;
  }
  // Insert each strike into the array (sorted, dedup) for accurate kinks.
  const strikeSet = new Set<number>(legs.map((l) => l.strike));
  for (const k of strikeSet) {
    if (k >= uLo && k <= uHi && !underlying.includes(k)) {
      underlying.push(k);
    }
  }
  underlying.sort((a, b) => a - b);

  for (let i = 0; i < underlying.length; i++) {
    const s = underlying[i] as number;
    let total = 0;
    for (const l of legs) total += legPayoffDollars(l, s);
    pnl.push(total);
  }

  // Break-evens: linear-interp every sign change. Skip exact-zero handling
  // by treating zero as "no crossing yet" unless the neighbor differs in sign.
  const breakevens: number[] = [];
  for (let i = 1; i < underlying.length; i++) {
    const y0 = pnl[i - 1] as number;
    const y1 = pnl[i] as number;
    const x0 = underlying[i - 1] as number;
    const x1 = underlying[i] as number;
    if (y0 === 0) {
      breakevens.push(x0);
      continue;
    }
    if (y0 * y1 < 0) {
      const x = x0 - (y0 * (x1 - x0)) / (y1 - y0);
      breakevens.push(x);
    }
  }
  // Catch the last point exactly on zero.
  const lastPnl = pnl[pnl.length - 1];
  const lastU = underlying[underlying.length - 1];
  if (lastPnl === 0 && lastU !== undefined) breakevens.push(lastU);
  // Dedup near-duplicates within 1e-9.
  const dedupBe: number[] = [];
  for (const b of breakevens) {
    if (!dedupBe.some((x) => Math.abs(x - b) < 1e-9)) dedupBe.push(b);
  }

  // Max gain / loss within sample.
  let sampleMax = -Infinity;
  let sampleMin = Infinity;
  for (const y of pnl) {
    if (y > sampleMax) sampleMax = y;
    if (y < sampleMin) sampleMin = y;
  }

  // Determine asymptotic behavior for unbounded structures.
  const slopeUp = slopeAtPlusInfinity(legs); // dPnL/dS at +inf
  const slopeDown = slopeAtZero(legs); // dPnL/dS as S -> 0+
  // As S -> +inf: if slopeUp > 0 -> gain unbounded; < 0 -> loss unbounded.
  // As S -> 0+:   if slopeDown < 0 -> gain unbounded (PnL rises as S falls);
  //               > 0 -> loss unbounded.
  let maxGain: number | null = sampleMax;
  let maxLoss: number | null = sampleMin;
  if (slopeUp > 0) maxGain = null;
  if (slopeUp < 0) maxLoss = null;
  if (slopeDown < 0) maxGain = null;
  if (slopeDown > 0) maxLoss = null;

  return {
    underlying,
    pnl,
    breakevens: dedupBe.sort((a, b) => a - b),
    maxLoss,
    maxGain,
    netDebit,
  };
}

/**
 * Per-point payoff sample emitted by {@link computeRiskGraph}. The shape
 * (`{ underlying, pnl }`) is what the dashboard payoff chart and the CLI
 * ASCII-plot iterate over.
 */
export interface RiskGraphResultPoint {
  underlying: number;
  pnl: number;
}

/**
 * Spec-named result shape for issue #127. Wraps the lower-level {@link
 * RiskGraph} into the API the issue's acceptance criteria specify:
 * `{ points, breakEvens, maxProfit, maxLoss }`. Use this from agents and
 * route handlers; use {@link riskGraph} when you need the raw parallel
 * `underlying` / `pnl` arrays (e.g. for direct plotting).
 */
export interface ComputeRiskGraphResult {
  /** Sampled payoff series at expiry, sorted by underlying price ascending. */
  points: RiskGraphResultPoint[];
  /** Underlying prices where pnl crosses zero. May be empty. */
  breakEvens: number[];
  /** Best-case gain in dollars (positive number) or null if unbounded. */
  maxProfit: number | null;
  /** Worst-case loss in dollars (negative number) or null if unbounded. */
  maxLoss: number | null;
  /** Positive = net debit, negative = net credit, in dollars. */
  netDebit: number;
}

/**
 * Compute the risk graph for a multi-leg option structure using the API
 * shape required by issue #127. This is a thin, deterministic wrapper around
 * {@link riskGraph} that zips the parallel `underlying`/`pnl` arrays into
 * `{ underlying, pnl }` points and renames the bound fields to match the
 * spec (`breakEvens`, `maxProfit`). The wrapped function is pure and
 * performs no I/O.
 *
 * Supports the structures called out in the issue: long/short call,
 * long/short put, verticals, calendars (single-expiry; multi-expiry is
 * tracked as follow-up), and iron condors.
 */
export function computeRiskGraph(
  legs: RiskGraphLeg[],
  opts: RiskGraphOptions = {},
): ComputeRiskGraphResult {
  const raw = riskGraph(legs, opts);
  const points: RiskGraphResultPoint[] = new Array(raw.underlying.length);
  for (let i = 0; i < raw.underlying.length; i++) {
    const u = raw.underlying[i] as number;
    const y = raw.pnl[i] as number;
    points[i] = { underlying: u, pnl: y };
  }
  return {
    points,
    breakEvens: raw.breakevens,
    maxProfit: raw.maxGain,
    maxLoss: raw.maxLoss,
    netDebit: raw.netDebit,
  };
}
