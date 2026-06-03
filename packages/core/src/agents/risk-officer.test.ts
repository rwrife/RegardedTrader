import { describe, it, expect } from 'vitest';
import { RiskOfficer, type RiskCaps } from './risk-officer.js';
import type { TradePlan } from '../schemas/index.js';
import { definedRiskPlan, makeContract } from './__fixtures__/option-contracts.js';

const DEFAULT_CAPS: RiskCaps = {
  maxLossUsd: 500,
  maxLegs: 4,
  forbidNakedShorts: true,
};

function withRiskGraph(
  plan: TradePlan,
  maxLoss: number | null,
): TradePlan {
  return {
    ...plan,
    riskGraph: {
      underlying: [50, 100, 150],
      pnl: [0, 0, 0],
      breakevens: [],
      maxLoss,
      maxGain: null,
      netDebit: 110,
    },
  };
}

describe('RiskOfficer', () => {
  it('returns ok with no violations when the plan is within all caps', () => {
    const officer = new RiskOfficer(DEFAULT_CAPS);
    const r = officer.review(definedRiskPlan());
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('flags plans whose maxLoss exceeds the cap', () => {
    const officer = new RiskOfficer(DEFAULT_CAPS);
    const plan = definedRiskPlan({ maxLoss: 1200 });
    const r = officer.review(plan);
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('maxLoss 1200 exceeds cap 500');
  });

  it('flags risk-graph unbounded maxLoss (null) as a violation', () => {
    const officer = new RiskOfficer(DEFAULT_CAPS);
    const plan = withRiskGraph(definedRiskPlan(), null);
    const r = officer.review(plan);
    expect(r.ok).toBe(false);
    expect(r.violations).toContain(
      'maxLoss is unbounded (naked short or undefined-risk structure)',
    );
  });

  it('prefers the risk-graph maxLoss over the plan maxLoss when both are present', () => {
    const officer = new RiskOfficer(DEFAULT_CAPS);
    // plan.maxLoss within cap, but the risk-graph reports a much bigger loss
    // and the officer must use the risk-graph number.
    const plan = withRiskGraph(
      definedRiskPlan({ maxLoss: 100 }),
      -900, // absolute value 900 > cap 500
    );
    const r = officer.review(plan);
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('maxLoss 900 exceeds cap 500');
    expect(r.violations).not.toContain('maxLoss 100 exceeds cap 500');
  });

  it('uses the absolute value of risk-graph maxLoss (which is negative)', () => {
    const officer = new RiskOfficer({ ...DEFAULT_CAPS, maxLossUsd: 1000 });
    const plan = withRiskGraph(definedRiskPlan({ maxLoss: 100 }), -250);
    const r = officer.review(plan);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('flags a plan that exceeds the maxLegs cap', () => {
    const officer = new RiskOfficer({ ...DEFAULT_CAPS, maxLegs: 2 });
    const plan = definedRiskPlan({
      legs: [
        { action: 'buy', qty: 1, contract: makeContract({ strike: 100, type: 'call' }) },
        { action: 'buy', qty: 1, contract: makeContract({ strike: 105, type: 'call' }) },
        { action: 'sell', qty: 1, contract: makeContract({ strike: 110, type: 'call' }) },
      ],
    });
    const r = officer.review(plan);
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('leg count 3 exceeds cap 2');
  });

  it('detects a naked short leg when forbidNakedShorts is true', () => {
    const officer = new RiskOfficer(DEFAULT_CAPS);
    const plan = definedRiskPlan({
      legs: [
        {
          action: 'sell',
          qty: 1,
          contract: makeContract({ strike: 100, type: 'call' }),
        },
      ],
      maxLoss: 200,
    });
    const r = officer.review(plan);
    expect(r.ok).toBe(false);
    expect(
      r.violations.some((v) => v.startsWith('naked short detected')),
    ).toBe(true);
  });

  it('does not flag a covered short (vertical spread)', () => {
    const officer = new RiskOfficer(DEFAULT_CAPS);
    const plan = definedRiskPlan({
      legs: [
        {
          action: 'buy',
          qty: 1,
          contract: makeContract({ strike: 100, type: 'call' }),
        },
        {
          action: 'sell',
          qty: 1,
          contract: makeContract({ strike: 110, type: 'call' }),
        },
      ],
      maxLoss: 200,
    });
    const r = officer.review(plan);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('allows naked shorts when forbidNakedShorts is false', () => {
    const officer = new RiskOfficer({ ...DEFAULT_CAPS, forbidNakedShorts: false });
    const plan = definedRiskPlan({
      legs: [
        {
          action: 'sell',
          qty: 1,
          contract: makeContract({ strike: 100, type: 'call' }),
        },
      ],
      maxLoss: 200,
    });
    const r = officer.review(plan);
    expect(
      r.violations.some((v) => v.startsWith('naked short detected')),
    ).toBe(false);
  });

  it('treats a short put covered by a long call (different type) as still naked', () => {
    // Coverage rule requires matching contract.type AND expiry on the buy leg.
    const officer = new RiskOfficer(DEFAULT_CAPS);
    const plan = definedRiskPlan({
      legs: [
        {
          action: 'buy',
          qty: 1,
          contract: makeContract({ strike: 100, type: 'call' }),
        },
        {
          action: 'sell',
          qty: 1,
          contract: makeContract({ strike: 90, type: 'put' }),
        },
      ],
      maxLoss: 200,
    });
    const r = officer.review(plan);
    expect(
      r.violations.some((v) => v.startsWith('naked short detected')),
    ).toBe(true);
  });
});
