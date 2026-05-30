/**
 * Implied-volatility solver. Given a market price for an option, find the
 * sigma that reproduces it under Black-Scholes. Uses bisection — slower than
 * Newton-Raphson but bullet-proof against bad initial guesses and zero-vega
 * regions near deep OTM / very short-dated options.
 *
 * Returns `null` if no solution exists in the search bracket (e.g. price is
 * below intrinsic, above the underlying, or otherwise unreachable).
 *
 * Part of issue #76.
 */

import { price, type OptionType } from './bsm.js';

export interface IvInput {
  marketPrice: number;
  S: number;
  K: number;
  T: number;
  r: number;
  q?: number;
  type: OptionType;
  /** Search bracket. Defaults to [1e-6, 5.0] (0.0001% to 500%). */
  loVol?: number;
  hiVol?: number;
  /** Convergence tolerance on price. Default 1e-6. */
  tol?: number;
  /** Max bisection iterations. Default 100. */
  maxIter?: number;
}

export function impliedVol(input: IvInput): number | null {
  const { marketPrice, S, K, T, r, type } = input;
  const q = input.q ?? 0;
  const lo = input.loVol ?? 1e-6;
  const hi = input.hiVol ?? 5.0;
  const tol = input.tol ?? 1e-6;
  const maxIter = input.maxIter ?? 100;

  if (!(marketPrice > 0)) return null;
  if (!(S > 0 && K > 0 && T > 0)) return null;
  if (!(lo > 0 && hi > lo)) return null;

  // Sanity bounds: a call cannot exceed S * e^(-qT); a put cannot exceed
  // K * e^(-rT). Return null instead of looping if the input is impossible.
  const upperBound =
    type === 'call' ? S * Math.exp(-q * T) : K * Math.exp(-r * T);
  if (marketPrice >= upperBound) return null;

  // Intrinsic discounted lower bound (European). If market < this, also bail.
  const intrinsic =
    type === 'call'
      ? Math.max(0, S * Math.exp(-q * T) - K * Math.exp(-r * T))
      : Math.max(0, K * Math.exp(-r * T) - S * Math.exp(-q * T));
  if (marketPrice < intrinsic - tol) return null;

  let a = lo;
  let b = hi;
  let fa = price({ S, K, T, r, sigma: a, q, type }) - marketPrice;
  let fb = price({ S, K, T, r, sigma: b, q, type }) - marketPrice;

  // Bracket must straddle zero. If both same sign, no root in bracket.
  if (fa * fb > 0) return null;

  for (let i = 0; i < maxIter; i++) {
    const m = 0.5 * (a + b);
    const fm = price({ S, K, T, r, sigma: m, q, type }) - marketPrice;
    if (Math.abs(fm) < tol || (b - a) / 2 < 1e-8) return m;
    if (fa * fm < 0) {
      b = m;
      fb = fm;
    } else {
      a = m;
      fa = fm;
    }
  }
  return 0.5 * (a + b);
}
