import type { ImpliedMoveRow, OptionContract } from '../schemas/index.js';

interface StraddlePoint {
  strike: number;
  straddleMid: number;
}

export function computeImpliedMoves(
  contracts: ReadonlyArray<OptionContract>,
  spot: number,
): ImpliedMoveRow[] {
  if (!(spot > 0)) return [];

  const byExpiry = new Map<string, OptionContract[]>();
  for (const c of contracts) {
    const bucket = byExpiry.get(c.expiry) ?? [];
    bucket.push(c);
    byExpiry.set(c.expiry, bucket);
  }

  const rows: ImpliedMoveRow[] = [];
  for (const [expiry, expiryContracts] of byExpiry) {
    const points = buildStraddlePoints(expiryContracts);
    const straddleMid = estimateAtmStraddle(points, spot);
    if (straddleMid == null || !(straddleMid > 0)) continue;
    rows.push({
      expiry,
      straddleMid,
      impliedMoveAbs: straddleMid,
      impliedMovePct: straddleMid / spot,
    });
  }

  return rows.sort((a, b) => a.expiry.localeCompare(b.expiry));
}

function buildStraddlePoints(contracts: ReadonlyArray<OptionContract>): StraddlePoint[] {
  const calls = new Map<number, number>();
  const puts = new Map<number, number>();
  for (const c of contracts) {
    const mid = contractMid(c);
    if (mid == null) continue;
    if (c.type === 'call' && !calls.has(c.strike)) calls.set(c.strike, mid);
    if (c.type === 'put' && !puts.has(c.strike)) puts.set(c.strike, mid);
  }

  const out: StraddlePoint[] = [];
  for (const [strike, callMid] of calls) {
    const putMid = puts.get(strike);
    if (putMid == null) continue;
    out.push({ strike, straddleMid: callMid + putMid });
  }
  return out.sort((a, b) => a.strike - b.strike);
}

function estimateAtmStraddle(
  points: ReadonlyArray<StraddlePoint>,
  spot: number,
): number | null {
  if (points.length === 0) return null;
  if (points.length === 1) return points[0]!.straddleMid;

  for (const p of points) {
    if (p.strike === spot) return p.straddleMid;
  }

  let lower: StraddlePoint | null = null;
  let upper: StraddlePoint | null = null;
  for (const p of points) {
    if (p.strike <= spot) lower = p;
    if (p.strike >= spot) {
      upper = p;
      break;
    }
  }

  if (lower && upper && lower.strike !== upper.strike) {
    const w = (spot - lower.strike) / (upper.strike - lower.strike);
    return lower.straddleMid + (upper.straddleMid - lower.straddleMid) * w;
  }
  if (lower) return lower.straddleMid;
  if (upper) return upper.straddleMid;
  return null;
}

function contractMid(contract: OptionContract): number | null {
  const { bid, ask, last } = contract;
  if (bid != null && ask != null && Number.isFinite(bid) && Number.isFinite(ask)) {
    return (bid + ask) / 2;
  }
  if (last != null && Number.isFinite(last)) return last;
  return null;
}
