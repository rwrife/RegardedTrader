/**
 * Black-Scholes-Merton pricing and greeks for European options.
 *
 * Pure functions — no I/O. All inputs and outputs are plain numbers, no Zod
 * validation here (callers validate at the boundary). Greeks are returned in
 * their natural, per-year, per-1.0 units:
 *
 *   - `vega` is dPrice/dSigma (per 1.0 vol). Divide by 100 for "per 1%".
 *   - `theta` is dPrice/dT in price-per-year. Divide by 365 for per-day.
 *   - `rho` is dPrice/dr (per 1.0 rate). Divide by 100 for "per 1%".
 *
 * The dividend-yield input `q` defaults to 0 so callers that do not model
 * dividends can ignore it. Time-to-expiry `T` is in years.
 *
 * Part of the OptionsStrategist greeks + risk-graph work (issue #76).
 */

export type OptionType = 'call' | 'put';

export interface BsmInput {
  /** Underlying spot price. Must be > 0. */
  S: number;
  /** Strike price. Must be > 0. */
  K: number;
  /** Time to expiry in years. Must be > 0. */
  T: number;
  /** Risk-free rate (annualized, continuous). e.g. 0.05 for 5%. */
  r: number;
  /** Implied volatility (annualized, decimal). e.g. 0.3 for 30%. Must be > 0. */
  sigma: number;
  /** Continuous dividend yield (annualized, decimal). Default 0. */
  q?: number;
  type: OptionType;
}

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  /** Per-year, in price units. Divide by 365 for per-day. */
  theta: number;
  /** Per 1.0 vol (multiply input sigma by 1.0). Divide by 100 for per-1%. */
  vega: number;
  /** Per 1.0 rate. Divide by 100 for per-1%. */
  rho: number;
}

/** Standard normal pdf φ(x). */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal cdf N(x). Uses Abramowitz & Stegun 7.1.26 via erf. Accurate
 * to ~1.5e-7 — more than enough for option pricing where market quotes are
 * pennies wide.
 */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** A&S 7.1.26 erf approximation, |error| < 1.5e-7. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1.0 / (1.0 + p * ax);
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function validate(input: BsmInput): void {
  const { S, K, T, sigma } = input;
  if (!(S > 0)) throw new RangeError(`bsm: S must be > 0, got ${S}`);
  if (!(K > 0)) throw new RangeError(`bsm: K must be > 0, got ${K}`);
  if (!(T > 0)) throw new RangeError(`bsm: T must be > 0, got ${T}`);
  if (!(sigma > 0)) throw new RangeError(`bsm: sigma must be > 0, got ${sigma}`);
}

/**
 * Price a European call/put. Use {@link greeks} if you also want sensitivities;
 * `price()` is a thin convenience wrapper that does the same math without
 * computing the rest.
 */
export function price(input: BsmInput): number {
  validate(input);
  const { S, K, T, r, sigma, type } = input;
  const q = input.q ?? 0;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  if (type === 'call') {
    return S * Math.exp(-q * T) * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  }
  return K * Math.exp(-r * T) * normCdf(-d2) - S * Math.exp(-q * T) * normCdf(-d1);
}

/** Price + the full standard greeks set. */
export function greeks(input: BsmInput): Greeks {
  validate(input);
  const { S, K, T, r, sigma, type } = input;
  const q = input.q ?? 0;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const eqT = Math.exp(-q * T);
  const erT = Math.exp(-r * T);
  const pdfD1 = normPdf(d1);

  const callPrice = S * eqT * normCdf(d1) - K * erT * normCdf(d2);
  const putPrice = K * erT * normCdf(-d2) - S * eqT * normCdf(-d1);
  const isCall = type === 'call';

  const px = isCall ? callPrice : putPrice;
  const delta = isCall ? eqT * normCdf(d1) : eqT * (normCdf(d1) - 1);
  const gamma = (eqT * pdfD1) / (S * sigma * sqrtT);
  const vega = S * eqT * pdfD1 * sqrtT;

  // Theta per year (price units).
  const term1 = -(S * pdfD1 * sigma * eqT) / (2 * sqrtT);
  const theta = isCall
    ? term1 - r * K * erT * normCdf(d2) + q * S * eqT * normCdf(d1)
    : term1 + r * K * erT * normCdf(-d2) - q * S * eqT * normCdf(-d1);

  const rho = isCall ? K * T * erT * normCdf(d2) : -K * T * erT * normCdf(-d2);

  return { price: px, delta, gamma, theta, vega, rho };
}
