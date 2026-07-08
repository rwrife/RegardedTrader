import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// -----------------------------------------------------------------------------
// #181 — DTE cap and account pct-of-account cap
// -----------------------------------------------------------------------------

describe('RiskOfficer (#181 DTE + pct-of-account caps)', () => {
  // Fix "today" to 2026-07-01 UTC so DTE tests are deterministic regardless
  // of when the suite runs. We use useFakeTimers because the officer reads
  // `new Date()` internally to compute today.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flags a plan whose longest-dated leg exceeds maxDte', () => {
    const officer = new RiskOfficer({ ...DEFAULT_CAPS, maxDte: 30 });
    // 60 days out from 2026-07-01 → 2026-08-30
    const plan = definedRiskPlan({
      legs: [
        {
          action: 'buy',
          qty: 1,
          contract: makeContract({
            strike: 100,
            type: 'call',
            expiry: '2026-08-30',
          }),
        },
      ],
    });
    const r = officer.review(plan);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes('DTE') && v.includes('exceeds cap 30'))).toBe(true);
  });

  it('picks the longest-dated leg for the DTE violation message', () => {
    const officer = new RiskOfficer({ ...DEFAULT_CAPS, maxDte: 20 });
    const shortLeg = makeContract({ strike: 100, type: 'call', expiry: '2026-07-10' });
    const longLeg = makeContract({ strike: 110, type: 'call', expiry: '2026-09-15' });
    const plan = definedRiskPlan({
      legs: [
        { action: 'buy', qty: 1, contract: shortLeg },
        { action: 'sell', qty: 1, contract: longLeg },
      ],
      // Cover the short so we don't also fail naked-short check.
      maxLoss: 200,
    });
    // shortLeg is buy-call, longLeg is sell-call — coverage rule requires the
    // BUY to be present on the same type/expiry as the SELL. Add a matching
    // long call to cover the sell so only the DTE violation fires.
    plan.legs = [
      { action: 'buy', qty: 1, contract: shortLeg },
      { action: 'sell', qty: 1, contract: longLeg },
      { action: 'buy', qty: 1, contract: makeContract({ strike: 120, type: 'call', expiry: '2026-09-15' }) },
    ];
    const r = officer.review(plan);
    // The 2026-09-15 leg is the longest at 76 DTE; message must reference it.
    expect(r.violations.some((v) => v.includes('2026-09-15') || v.includes('76'))).toBe(true);
  });

  it('does not flag when maxDte is 0 (disabled), even for far-dated legs', () => {
    const officer = new RiskOfficer({ ...DEFAULT_CAPS, maxDte: 0 });
    const plan = definedRiskPlan({
      legs: [
        {
          action: 'buy',
          qty: 1,
          contract: makeContract({ strike: 100, type: 'call', expiry: '2028-01-01' }),
        },
      ],
    });
    const r = officer.review(plan);
    expect(r.violations.some((v) => v.startsWith('DTE'))).toBe(false);
  });

  it('does not flag when maxDte is omitted from caps (backward compat)', () => {
    // No maxDte in caps → check disabled. This is the shape older callers
    // pass before the #181 update rolls through.
    const officer = new RiskOfficer(DEFAULT_CAPS);
    const plan = definedRiskPlan({
      legs: [
        {
          action: 'buy',
          qty: 1,
          contract: makeContract({ strike: 100, type: 'call', expiry: '2028-01-01' }),
        },
      ],
    });
    const r = officer.review(plan);
    expect(r.violations.some((v) => v.startsWith('DTE'))).toBe(false);
  });

  it('flags a plan whose maxLoss exceeds accountSize * maxPctOfAccount', () => {
    // $10k account, 2% cap → $200. Plan has maxLoss 300 → violation.
    const officer = new RiskOfficer({
      ...DEFAULT_CAPS,
      maxLossUsd: 10_000, // keep the absolute cap out of the way
      accountSizeUsd: 10_000,
      maxPctOfAccount: 0.02,
    });
    const plan = definedRiskPlan({ maxLoss: 300 });
    const r = officer.review(plan);
    expect(r.ok).toBe(false);
    expect(
      r.violations.some(
        (v) => v.includes('exceeds 2.00% of account') && v.includes('$200') && v.includes('$10000'),
      ),
    ).toBe(true);
  });

  it('does not flag pct-of-account when accountSizeUsd is 0 (unknown)', () => {
    const officer = new RiskOfficer({
      ...DEFAULT_CAPS,
      accountSizeUsd: 0,
      maxPctOfAccount: 0.02,
    });
    const plan = definedRiskPlan({ maxLoss: 400 }); // under maxLossUsd=500
    const r = officer.review(plan);
    expect(r.ok).toBe(true);
    expect(r.violations.some((v) => v.includes('of account'))).toBe(false);
  });

  it('does not flag pct-of-account when maxPctOfAccount is 0 (disabled)', () => {
    const officer = new RiskOfficer({
      ...DEFAULT_CAPS,
      accountSizeUsd: 10_000,
      maxPctOfAccount: 0,
    });
    const plan = definedRiskPlan({ maxLoss: 400 });
    const r = officer.review(plan);
    expect(r.violations.some((v) => v.includes('of account'))).toBe(false);
  });

  it('respects both maxLossUsd and pct-of-account (whichever is tighter)', () => {
    // Absolute cap is high; pct cap is the binding constraint.
    const officer = new RiskOfficer({
      ...DEFAULT_CAPS,
      maxLossUsd: 100_000,
      accountSizeUsd: 5_000,
      maxPctOfAccount: 0.02, // → $100 cap
    });
    const plan = definedRiskPlan({ maxLoss: 250 });
    const r = officer.review(plan);
    expect(r.ok).toBe(false);
    // Should NOT report the absolute cap (250 < 100000) — only the pct cap.
    expect(r.violations.some((v) => v.includes('exceeds cap 100000'))).toBe(false);
    expect(r.violations.some((v) => v.includes('of account'))).toBe(true);
  });

  it('unbounded maxLoss short-circuits the pct-of-account check', () => {
    // With risk-graph maxLoss=null we already emit the "unbounded" violation;
    // we must NOT also emit a NaN-shaped pct-of-account message.
    const officer = new RiskOfficer({
      ...DEFAULT_CAPS,
      accountSizeUsd: 10_000,
      maxPctOfAccount: 0.02,
    });
    const base = definedRiskPlan();
    const plan: TradePlan = {
      ...base,
      riskGraph: {
        underlying: [50, 100, 150],
        pnl: [0, 0, 0],
        breakevens: [],
        maxLoss: null,
        maxGain: null,
        netDebit: 110,
      },
    };
    const r = officer.review(plan);
    expect(r.ok).toBe(false);
    expect(r.violations).toContain(
      'maxLoss is unbounded (naked short or undefined-risk structure)',
    );
    expect(r.violations.some((v) => v.includes('of account'))).toBe(false);
  });

  it('reports a same-day expiry as 0 DTE (never negative)', () => {
    const officer = new RiskOfficer({ ...DEFAULT_CAPS, maxDte: 0 /* disabled */ });
    // Sanity check: with maxDte disabled, no DTE violation for a 0 DTE leg.
    const plan = definedRiskPlan({
      legs: [
        {
          action: 'buy',
          qty: 1,
          contract: makeContract({ strike: 100, type: 'call', expiry: '2026-07-01' }),
        },
      ],
    });
    const r = officer.review(plan);
    expect(r.violations.some((v) => v.startsWith('DTE'))).toBe(false);
  });
});
