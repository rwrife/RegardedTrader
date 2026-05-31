import { describe, expect, it } from 'vitest';
import {
  RECOMMENDATION_DISCLAIMER,
  type Recommendation,
  type Verdict,
  Recommendation as RecommendationSchema,
  Verdict as VerdictSchema,
} from '../../schemas/recommendation.js';
import {
  applyRules,
  HardGates,
  HARD_GATES_VERSION,
  hardGatesRule,
  type RecommendationContext,
  type Rule,
} from './index.js';
import { HARD_GATE_FLAGS } from './hard-gates.js';

function v(overrides: Partial<Verdict> = {}): Verdict {
  return VerdictSchema.parse({
    action: 'BUY',
    conviction: 0.8,
    rationale: 'momentum strong',
    signals: [],
    contraSignals: [],
    ...overrides,
  });
}

function rec(overrides: Partial<Recommendation> = {}): Recommendation {
  return RecommendationSchema.parse({
    symbol: 'NVDA',
    generatedAt: '2026-05-31T09:00:00.000Z',
    asOf: { quote: '2026-05-31T08:59:00.000Z', options: null, sentiment: null, news: null },
    equity: v({ action: 'BUY', conviction: 0.8 }),
    options: {
      coveredCall: v({ action: 'BUY', conviction: 0.7 }),
      coveredPut: null,
      nakedCall: v({ action: 'SELL', conviction: 0.9 }),
      nakedPut: null,
    },
    riskFlags: [],
    sources: [],
    modelInfo: { provider: 'openai', model: 'gpt-4o-mini', ruleVersion: 'draft' },
    disclaimer: RECOMMENDATION_DISCLAIMER,
    ...overrides,
  });
}

function ctx(overrides: Partial<RecommendationContext> = {}): RecommendationContext {
  return {
    symbol: 'NVDA',
    risk: { forbidNakedShorts: false, ...(overrides.risk ?? {}) },
    quote: { stale: false, ...(overrides.quote ?? {}) },
    options: overrides.options !== undefined ? overrides.options : { hasChain: true },
    ...overrides,
  };
}

describe('applyRules', () => {
  it('returns the draft unchanged when there are no rules', () => {
    const draft = rec();
    expect(applyRules(ctx(), draft, [])).toEqual(draft);
  });

  it('threads each rule output into the next rule input', () => {
    const tagging: Rule = {
      name: 'tag',
      version: '1',
      apply: (_c, d) => ({ ...d, riskFlags: [...d.riskFlags, 'a'] }),
    };
    const more: Rule = {
      name: 'more',
      version: '1',
      apply: (_c, d) => ({ ...d, riskFlags: [...d.riskFlags, 'b'] }),
    };
    const out = applyRules(ctx(), rec(), [tagging, more]);
    expect(out.riskFlags).toEqual(['a', 'b']);
  });

  it('does not mutate the input draft', () => {
    const draft = rec();
    const snapshot = JSON.parse(JSON.stringify(draft)) as unknown;
    const mutating: Rule = {
      name: 'm',
      version: '1',
      apply: (_c, d) => ({ ...d, riskFlags: [...d.riskFlags, 'x'] }),
    };
    applyRules(ctx(), draft, [mutating]);
    expect(JSON.parse(JSON.stringify(draft))).toEqual(snapshot);
  });
});

describe('HardGates', () => {
  it('exposes a version string', () => {
    expect(new HardGates().version).toBe(HARD_GATES_VERSION);
    expect(hardGatesRule.version).toBe(HARD_GATES_VERSION);
  });

  it('passes through cleanly when nothing is wrong', () => {
    const draft = rec({
      options: { coveredCall: null, coveredPut: null, nakedCall: null, nakedPut: null },
    });
    const out = new HardGates().apply(ctx(), draft);
    expect(out).toEqual(draft);
    expect(out.riskFlags).toEqual([]);
  });

  it('nulls naked verdicts and flags when forbidNakedShorts is set', () => {
    const out = new HardGates().apply(
      ctx({ risk: { forbidNakedShorts: true } }),
      rec(),
    );
    expect(out.options.nakedCall).toBeNull();
    expect(out.options.nakedPut).toBeNull();
    expect(out.options.coveredCall).not.toBeNull();
    expect(out.riskFlags).toContain(HARD_GATE_FLAGS.nakedShortsForbidden);
  });

  it('nulls every options verdict and flags when no chain is available', () => {
    const out = new HardGates().apply(ctx({ options: null }), rec());
    expect(out.options).toEqual({
      coveredCall: null,
      coveredPut: null,
      nakedCall: null,
      nakedPut: null,
    });
    expect(out.riskFlags).toContain(HARD_GATE_FLAGS.noOptionsChain);
    // Naked-shorts flag should NOT also fire — there are no naked verdicts
    // left to strip, so adding the flag would be noise.
    expect(out.riskFlags).not.toContain(HARD_GATE_FLAGS.nakedShortsForbidden);
  });

  it('also handles `hasChain: false` (empty chain snapshot)', () => {
    const out = new HardGates().apply(ctx({ options: { hasChain: false } }), rec());
    expect(out.options.coveredCall).toBeNull();
    expect(out.riskFlags).toContain(HARD_GATE_FLAGS.noOptionsChain);
  });

  it('clamps conviction and flags on stale quotes', () => {
    const out = new HardGates().apply(
      ctx({ quote: { stale: true } }),
      rec({
        equity: v({ action: 'BUY', conviction: 0.9 }),
        options: {
          coveredCall: v({ action: 'BUY', conviction: 0.7 }),
          coveredPut: null,
          nakedCall: null,
          nakedPut: null,
        },
      }),
    );
    expect(out.equity.conviction).toBe(0.5);
    expect(out.options.coveredCall?.conviction).toBe(0.5);
    expect(out.riskFlags).toContain(HARD_GATE_FLAGS.staleQuote);
  });

  it('does not raise conviction that is already below the stale cap', () => {
    const out = new HardGates().apply(
      ctx({ quote: { stale: true } }),
      rec({
        equity: v({ action: 'HOLD', conviction: 0.2 }),
        options: { coveredCall: null, coveredPut: null, nakedCall: null, nakedPut: null },
      }),
    );
    // 0.2 < 0.3 threshold so low-confidence ALSO fires; conviction stays 0.2.
    expect(out.equity.conviction).toBe(0.2);
    expect(out.riskFlags).toContain(HARD_GATE_FLAGS.staleQuote);
    expect(out.riskFlags).toContain(HARD_GATE_FLAGS.lowConfidence);
  });

  it('forces equity to HOLD when aggregate confidence is below 0.3', () => {
    const out = new HardGates().apply(
      ctx(),
      rec({
        equity: v({ action: 'BUY', conviction: 0.2 }),
        options: { coveredCall: null, coveredPut: null, nakedCall: null, nakedPut: null },
      }),
    );
    expect(out.equity.action).toBe('HOLD');
    expect(out.equity.rationale).toContain('HardGates');
    expect(out.riskFlags).toContain(HARD_GATE_FLAGS.lowConfidence);
  });

  it('forces non-null options verdicts to HOLD under low confidence too', () => {
    const out = new HardGates().apply(
      ctx(),
      rec({
        equity: v({ action: 'SELL', conviction: 0.1 }),
        options: {
          coveredCall: v({ action: 'BUY', conviction: 0.1 }),
          coveredPut: null,
          nakedCall: null,
          nakedPut: null,
        },
      }),
    );
    expect(out.equity.action).toBe('HOLD');
    expect(out.options.coveredCall?.action).toBe('HOLD');
  });

  it('aggregates only over surviving verdicts (post-strip)', () => {
    // Two BUYs at 0.8, naked-short SELL at 0.9. Mean of all three = 0.833.
    // After stripping naked under forbidNakedShorts, mean of {0.8, 0.8} = 0.8.
    // Neither value trips the 0.3 threshold so action survives. We're
    // checking that the naked verdict's high conviction doesn't prevent a
    // separate low-confidence draft from being HELD.
    const out = new HardGates().apply(
      ctx({ risk: { forbidNakedShorts: true } }),
      rec({
        equity: v({ action: 'BUY', conviction: 0.2 }),
        options: {
          coveredCall: null,
          coveredPut: null,
          // Pre-strip mean would be (0.2 + 0.95) / 2 = 0.575 — above the
          // gate. Post-strip mean is just 0.2, so low-confidence MUST fire.
          nakedCall: v({ action: 'SELL', conviction: 0.95 }),
          nakedPut: null,
        },
      }),
    );
    expect(out.options.nakedCall).toBeNull();
    expect(out.equity.action).toBe('HOLD');
    expect(out.riskFlags).toContain(HARD_GATE_FLAGS.nakedShortsForbidden);
    expect(out.riskFlags).toContain(HARD_GATE_FLAGS.lowConfidence);
  });

  it('de-duplicates risk flags it appends', () => {
    const out = new HardGates().apply(
      ctx({ options: null }),
      rec({ riskFlags: [HARD_GATE_FLAGS.noOptionsChain] }),
    );
    expect(out.riskFlags.filter((f) => f === HARD_GATE_FLAGS.noOptionsChain)).toHaveLength(1);
  });

  it('respects custom thresholds', () => {
    const strict = new HardGates({ lowConfidenceThreshold: 0.95 });
    const out = strict.apply(
      ctx(),
      rec({
        equity: v({ action: 'BUY', conviction: 0.9 }),
        options: { coveredCall: null, coveredPut: null, nakedCall: null, nakedPut: null },
      }),
    );
    expect(out.equity.action).toBe('HOLD');
    expect(out.riskFlags).toContain(HARD_GATE_FLAGS.lowConfidence);
  });

  it('produces output that re-validates against the Recommendation schema', () => {
    const out = new HardGates().apply(
      ctx({
        risk: { forbidNakedShorts: true },
        quote: { stale: true },
        options: { hasChain: true },
      }),
      rec(),
    );
    expect(() => RecommendationSchema.parse(out)).not.toThrow();
  });
});
