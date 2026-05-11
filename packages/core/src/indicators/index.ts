import type { OHLCV, Indicators } from '../schemas/index.js';

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

export function computeIndicators(bars: OHLCV[]): Indicators {
  const closes = bars.map((b) => b.c);
  const sma20Arr = sma(closes, 20);
  const sma50Arr = sma(closes, 50);
  const ema12Arr = ema(closes, 12);
  const ema26Arr = ema(closes, 26);
  const rsiArr = rsi(closes, 14);
  const atrArr = atr(bars, 14);

  const macdLine = ema12Arr.map((v, i) =>
    v !== null && ema26Arr[i] !== null ? v - (ema26Arr[i] as number) : null,
  );
  const macdNumeric = macdLine.map((v) => v ?? 0);
  const macdSignalArr = ema(macdNumeric, 9);

  const last = <T>(arr: T[]): T | null => (arr.length ? arr[arr.length - 1]! : null);

  return {
    rsi14: last(rsiArr) ?? null,
    sma20: last(sma20Arr) ?? null,
    sma50: last(sma50Arr) ?? null,
    ema12: last(ema12Arr) ?? null,
    ema26: last(ema26Arr) ?? null,
    macd: last(macdLine) ?? null,
    macdSignal: last(macdSignalArr) ?? null,
    atr14: last(atrArr) ?? null,
  };
}
