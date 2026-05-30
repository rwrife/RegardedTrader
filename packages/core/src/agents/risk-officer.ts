import type { TradePlan } from '../schemas/index.js';

export interface RiskCaps {
  maxLossUsd: number;
  maxLegs: number;
  forbidNakedShorts: boolean;
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
    if (plan.legs.length > this.caps.maxLegs) {
      violations.push(`leg count ${plan.legs.length} exceeds cap ${this.caps.maxLegs}`);
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
