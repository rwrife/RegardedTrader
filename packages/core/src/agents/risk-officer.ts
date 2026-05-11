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
    if (plan.maxLoss > this.caps.maxLossUsd) {
      violations.push(`maxLoss ${plan.maxLoss} exceeds cap ${this.caps.maxLossUsd}`);
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
