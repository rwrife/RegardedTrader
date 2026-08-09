import type { OptionContract, SkewPoint, SkewSeries } from '../schemas/index.js';

export interface ComputeSkewOptions {
  /**
   * Underlying spot price. Required to normalize strike into moneyness.
   * `moneyness = strike / spot`.
   */
  spot: number;
  /**
   * Optional expiry filter. When omitted, returns one `SkewSeries` per expiry
   * found in `contracts`.
   */
  expiry?: string;
}

/**
 * Compute IV skew/smile points for each expiry in an options chain.
 *
 * Pure and deterministic: no network, no clock, no side effects.
 */
export function computeSkew(
  contracts: ReadonlyArray<OptionContract>,
  opts: ComputeSkewOptions,
): SkewSeries[] {
  const { spot } = opts;
  if (!(spot > 0)) return [];

  const filtered = opts.expiry
    ? contracts.filter((c) => c.expiry === opts.expiry)
    : contracts;
  if (filtered.length === 0) return [];

  const byExpiry = new Map<string, OptionContract[]>();
  for (const c of filtered) {
    const bucket = byExpiry.get(c.expiry) ?? [];
    bucket.push(c);
    byExpiry.set(c.expiry, bucket);
  }

  const out: SkewSeries[] = [];
  for (const [expiry, rows] of byExpiry) {
    const callIv = buildPoints(rows, 'call', spot);
    const putIv = buildPoints(rows, 'put', spot);
    if (callIv.length === 0 && putIv.length === 0) continue;

    const points = [...callIv, ...putIv].sort((a, b) => a.moneyness - b.moneyness);
    out.push({
      expiry,
      callIv,
      putIv,
      atmIv: estimateAtmIv(points),
      gappy: hasMissingIv(rows),
    });
  }

  return out.sort((a, b) => a.expiry.localeCompare(b.expiry));
}

function buildPoints(
  contracts: ReadonlyArray<OptionContract>,
  type: OptionContract['type'],
  spot: number,
): SkewPoint[] {
  const byStrike = new Map<number, number>();
  for (const c of contracts) {
    if (c.type !== type) continue;
    if (c.iv == null || !Number.isFinite(c.iv) || c.iv <= 0) continue;
    if (!(c.strike > 0)) continue;
    if (!byStrike.has(c.strike)) byStrike.set(c.strike, c.iv);
  }

  return Array.from(byStrike.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([strike, iv]) => ({
      strike,
      moneyness: strike / spot,
      iv,
    }));
}

function hasMissingIv(contracts: ReadonlyArray<OptionContract>): boolean {
  return contracts.some((c) => c.iv == null || !Number.isFinite(c.iv));
}

function estimateAtmIv(points: ReadonlyArray<SkewPoint>): number | null {
  if (points.length === 0) return null;

  const exact = points.filter((p) => p.moneyness === 1);
  if (exact.length > 0) return average(exact.map((p) => p.iv));

  let lower: SkewPoint | null = null;
  let upper: SkewPoint | null = null;
  for (const p of points) {
    if (p.moneyness <= 1) lower = p;
    if (p.moneyness >= 1) {
      upper = p;
      break;
    }
  }

  if (lower && upper && lower.moneyness !== upper.moneyness) {
    const w = (1 - lower.moneyness) / (upper.moneyness - lower.moneyness);
    return lower.iv + (upper.iv - lower.iv) * w;
  }
  if (lower) return lower.iv;
  if (upper) return upper.iv;
  return null;
}

function average(values: ReadonlyArray<number>): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
