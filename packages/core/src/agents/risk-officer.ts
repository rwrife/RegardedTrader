import type { TradePlan } from '../schemas/index.js';

export interface RiskCaps {
  maxLossUsd: number;
  maxLegs: number;
  forbidNakedShorts: boolean;
  /**
   * Maximum days-to-expiry (DTE) of the longest-dated leg. `0` disables the
   * check. Added in #181; defaults to 45 to match `RiskConfig`.
   */
  maxDte?: number;
  /**
   * User's total tradable account size in USD, paired with
   * `maxPctOfAccount`. `0` (or `undefined`) means "not configured" — the
   * pct-of-account check is skipped.
   */
  accountSizeUsd?: number;
  /**
   * Cap on effectiveMaxLoss as a fraction of `accountSizeUsd`. Only
   * enforced when both `accountSizeUsd` and this value are `> 0`.
   */
  maxPctOfAccount?: number;
}

export class RiskOfficer {
  constructor(private readonly caps: RiskCaps) {}

  review(plan: TradePlan): { ok: boolean; violations: string[] } {
    const violations: string[] = [];
    // Prefer the deterministic risk-graph maxLoss when present (#76). If the
    // risk-graph reports unbounded loss (null), that is itself a violation —
    // we never let unbounded-loss structures slip past the cap.
    let effectiveMaxLoss: number | null = plan.maxLoss;
    if (plan.riskGraph) {
      if (plan.riskGraph.maxLoss === null) {
        effectiveMaxLoss = null;
      } else {
        effectiveMaxLoss = Math.abs(plan.riskGraph.maxLoss);
      }
    }
    if (effectiveMaxLoss === null) {
      violations.push('maxLoss is unbounded (naked short or undefined-risk structure)');
    } else if (effectiveMaxLoss > this.caps.maxLossUsd) {
      violations.push(
        `maxLoss ${effectiveMaxLoss} exceeds cap ${this.caps.maxLossUsd}`,
      );
    }

    // Pct-of-account cap (#181). Only enforced when both accountSizeUsd and
    // maxPctOfAccount are positive, and we know a bounded maxLoss.
    const accountSize = this.caps.accountSizeUsd ?? 0;
    const pct = this.caps.maxPctOfAccount ?? 0;
    if (effectiveMaxLoss !== null && accountSize > 0 && pct > 0) {
      const pctCap = accountSize * pct;
      if (effectiveMaxLoss > pctCap) {
        // Round the cap to 2dp to keep the message tidy for arbitrary pct.
        const capStr = Number.isInteger(pctCap) ? String(pctCap) : pctCap.toFixed(2);
        violations.push(
          `maxLoss ${effectiveMaxLoss} exceeds ${(pct * 100).toFixed(2)}% of account ` +
            `($${capStr} of $${accountSize})`,
        );
      }
    }

    if (plan.legs.length > this.caps.maxLegs) {
      violations.push(`leg count ${plan.legs.length} exceeds cap ${this.caps.maxLegs}`);
    }

    // DTE cap (#181). Compute days-to-expiry against "today" (UTC) for each
    // leg and flag if any exceed the cap. `maxDte === 0` disables the check.
    const maxDte = this.caps.maxDte ?? 0;
    if (maxDte > 0 && plan.legs.length > 0) {
      const today = todayUtcMs();
      let worstDte = -Infinity;
      let worstSymbol = '';
      for (const leg of plan.legs) {
        const dte = computeDteDays(leg.contract.expiry, today);
        if (dte === null) continue; // unparseable expiry — skip rather than false-flag
        if (dte > worstDte) {
          worstDte = dte;
          worstSymbol = leg.contract.symbol;
        }
      }
      if (Number.isFinite(worstDte) && worstDte > maxDte) {
        violations.push(
          `DTE ${worstDte} on ${worstSymbol} exceeds cap ${maxDte}`,
        );
      }
    }

    if (this.caps.forbidNakedShorts) {
      const shorts = plan.legs.filter((l) => l.action === 'sell');
      for (const s of shorts) {
        const covered = plan.legs.some(
          (other) =>
            other !== s &&
            other.action === 'buy' &&
            other.contract.type === s.contract.type &&
            other.contract.expiry === s.contract.expiry,
        );
        if (!covered) {
          violations.push(`naked short detected: ${s.contract.symbol}`);
          break;
        }
      }
    }
    return { ok: violations.length === 0, violations };
  }
}

/** Midnight UTC of the current day in ms since epoch. */
function todayUtcMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * Return whole days between `todayMs` and the option's expiry. Expiry is
 * expected in ISO `YYYY-MM-DD` form (matches `OptionContract.expiry`). Uses
 * `Math.ceil` so a same-day expiry counts as 0 DTE and a next-day expiry as
 * 1 DTE. Returns `null` for unparseable input (defensive — the schema does
 * not currently constrain format).
 */
function computeDteDays(expiry: string, todayMs: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(expiry);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const expMs = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(expMs)) return null;
  return Math.ceil((expMs - todayMs) / 86_400_000);
}
