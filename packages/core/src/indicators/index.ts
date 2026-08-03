import type { OHLCV, Indicators } from '../schemas/index.js';

/** Population standard deviation of `values`. Undefined for `values.length < 1`. */
function pstdev(values: number[]): number {
  const n = values.length;
  if (n < 1) return NaN;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let sqDiff = 0;
  for (const v of values) {
    const d = v - mean;
    sqDiff += d * d;
  }
  return Math.sqrt(sqDiff / n);
}

function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (prev === null) {
      if (i === period - 1) {
        const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
        prev = seed;
        out.push(seed);
      } else {
        out.push(null);
      }
    } else {
      prev = v * k + prev * (1 - k);
      out.push(prev);
    }
  }
  return out;
}

function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = [null];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    const g = Math.max(diff, 0);
    const l = Math.max(-diff, 0);
    if (i <= period) {
      gain += g;
      loss += l;
      if (i === period) {
        const avgG = gain / period;
        const avgL = loss / period;
        const rs = avgL === 0 ? 100 : avgG / avgL;
        out.push(100 - 100 / (1 + rs));
      } else {
        out.push(null);
      }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      const rs = loss === 0 ? 100 : gain / loss;
      out.push(100 - 100 / (1 + rs));
    }
  }
  return out;
}

function atr(bars: OHLCV[], period = 14): (number | null)[] {
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (i === 0) {
      trs.push(b.h - b.l);
    } else {
      const prev = bars[i - 1]!;
      trs.push(Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c)));
    }
  }
  return sma(trs, period);
}

export interface IndicatorSeries {
  sma20: (number | null)[];
  sma50: (number | null)[];
  ema12: (number | null)[];
  ema26: (number | null)[];
  rsi14: (number | null)[];
  macd: (number | null)[];
  macdSignal: (number | null)[];
  macdHistogram: (number | null)[];
  atr14: (number | null)[];
}

/**
 * Full-length indicator vectors aligned to the input bars.
 *
 * This is shared by both surfaces so chart overlays / panes and CLI readouts
 * derive from exactly the same formulas and windows.
 */
export function computeIndicatorSeries(bars: OHLCV[]): IndicatorSeries {
  const closes = bars.map((b) => b.c);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(bars, 14);

  const macd = ema12.map((v, i) =>
    v !== null && ema26[i] !== null ? v - (ema26[i] as number) : null,
  );
  const macdNumeric = macd.map((v) => v ?? 0);
  const macdSignal = ema(macdNumeric, 9);
  const macdHistogram = macd.map((v, i) =>
    v !== null && macdSignal[i] !== null ? v - (macdSignal[i] as number) : null,
  );

  return {
    sma20,
    sma50,
    ema12,
    ema26,
    rsi14,
    macd,
    macdSignal,
    macdHistogram,
    atr14,
  };
}

/**
 * Bollinger Bands (issue #140).
 *
 * Classic Bollinger: a middle SMA line with an upper/lower band offset by
 * `mult` population standard deviations, computed over a trailing `period`
 * window of closing prices. Positions where the window is not yet full
 * return `null` for all three series so the output aligns 1:1 with the
 * input length.
 *
 * Deterministic, pure, no network. Uses population stdev to match the
 * canonical Bollinger definition (Bollinger 1980); this is also what
 * `bbands()` in TA-Lib returns.
 */
export interface BollingerBands {
  middle: (number | null)[];
  upper: (number | null)[];
  lower: (number | null)[];
}

export function bollinger(
  closes: readonly number[],
  period = 20,
  mult = 2,
): BollingerBands {
  if (!(period >= 1)) {
    throw new RangeError(`bollinger: period must be >= 1, got ${period}`);
  }
  if (!Number.isFinite(mult)) {
    throw new RangeError(`bollinger: mult must be finite, got ${mult}`);
  }
  const n = closes.length;
  const middleArr = sma([...closes], period);
  const upper: (number | null)[] = new Array(n).fill(null);
  const lower: (number | null)[] = new Array(n).fill(null);
  const middle: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const m = middleArr[i];
    if (m == null) continue;
    const windowStart = i - period + 1;
    const window: number[] = new Array(period);
    for (let j = 0; j < period; j++) window[j] = closes[windowStart + j]!;
    const sd = pstdev(window);
    middle[i] = m;
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { middle, upper, lower };
}

/**
 * Stochastic Oscillator (issue #140).
 *
 * Fast %K is the position of the current close within the trailing `k`-bar
 * high/low range, expressed 0-100. %D is the `d`-bar SMA of %K. If the
 * range is zero (flat window) %K is defined as 50, matching the TA-Lib
 * convention.
 *
 * Inputs must be equal-length arrays of highs/lows/closes; a `RangeError`
 * is thrown otherwise so schema mismatches don't silently produce garbage.
 */
export interface StochasticResult {
  k: (number | null)[];
  d: (number | null)[];
}

export function stochastic(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  k = 14,
  d = 3,
): StochasticResult {
  if (!(k >= 1)) {
    throw new RangeError(`stochastic: k must be >= 1, got ${k}`);
  }
  if (!(d >= 1)) {
    throw new RangeError(`stochastic: d must be >= 1, got ${d}`);
  }
  const n = closes.length;
  if (highs.length !== n || lows.length !== n) {
    throw new RangeError(
      `stochastic: highs (${highs.length}), lows (${lows.length}) and closes (${n}) must be the same length`,
    );
  }
  const kArr: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i < k - 1) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - k + 1; j <= i; j++) {
      if (highs[j]! > hi) hi = highs[j]!;
      if (lows[j]! < lo) lo = lows[j]!;
    }
    const range = hi - lo;
    kArr[i] = range === 0 ? 50 : ((closes[i]! - lo) / range) * 100;
  }
  // %D is the SMA of the non-null %K series. Slots where %K is still null
  // remain null in %D too.
  const dArr: (number | null)[] = new Array(n).fill(null);
  let count = 0;
  let sum = 0;
  const buf: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = kArr[i];
    if (v == null) {
      buf.length = 0;
      count = 0;
      sum = 0;
      continue;
    }
    buf.push(v);
    sum += v;
    count++;
    if (buf.length > d) {
      sum -= buf.shift()!;
      count--;
    }
    if (count === d) dArr[i] = sum / d;
  }
  return { k: kArr, d: dArr };
}

export function computeIndicators(bars: OHLCV[]): Indicators {
  const closes = bars.map((b) => b.c);
  const series = computeIndicatorSeries(bars);

  // Bollinger Bands (20, 2) and Stochastic (14, 3) — issue #140. Both are
  // additive/optional on the Indicators schema so pre-#140 fixtures still
  // validate; we only populate the last-window value like every other field
  // on this snapshot.
  const bb = bollinger(closes, 20, 2);
  const highs = bars.map((b) => b.h);
  const lows = bars.map((b) => b.l);
  const stoch = stochastic(highs, lows, closes, 14, 3);

  const last = <T>(arr: T[]): T | null => (arr.length ? arr[arr.length - 1]! : null);

  return {
    rsi14: last(series.rsi14) ?? null,
    sma20: last(series.sma20) ?? null,
    sma50: last(series.sma50) ?? null,
    ema12: last(series.ema12) ?? null,
    ema26: last(series.ema26) ?? null,
    macd: last(series.macd) ?? null,
    macdSignal: last(series.macdSignal) ?? null,
    atr14: last(series.atr14) ?? null,
    bbMiddle: last(bb.middle) ?? null,
    bbUpper: last(bb.upper) ?? null,
    bbLower: last(bb.lower) ?? null,
    stochK: last(stoch.k) ?? null,
    stochD: last(stoch.d) ?? null,
  };
}
