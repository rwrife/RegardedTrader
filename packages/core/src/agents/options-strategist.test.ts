import { describe, it, expect, vi } from 'vitest';
import { OptionsStrategist, attachRiskGraph } from './options-strategist.js';
import { AgentParseError } from './errors.js';
import type { LLM } from './llm.js';
import { DISCLAIMER } from './llm.js';
import { makeContract, definedRiskPlan } from './__fixtures__/option-contracts.js';
import type { OptionContract, TradePlan } from '../schemas/index.js';

function fakeLLM(reply: string): LLM {
  return { complete: vi.fn().mockResolvedValue(reply) };
}

const SAMPLE_CHAIN: OptionContract[] = [
  makeContract({ strike: 100, type: 'call', bid: 1.0, ask: 1.2 }),
  makeContract({ strike: 110, type: 'call', bid: 0.4, ask: 0.6 }),
];

describe('OptionsStrategist', () => {
  it('parses valid JSON and returns TradePlans with riskGraph attached', async () => {
    const plan: TradePlan = definedRiskPlan({
      name: 'long-call',
      maxGain: null,
    });
    const llm = fakeLLM(JSON.stringify({ plans: [plan] }));
    const s = new OptionsStrategist(llm);

    const out = await s.propose({
      symbol: 'NVDA',
      thesis: 'bullish',
      maxLossUsd: 500,
      chain: SAMPLE_CHAIN,
    });

    expect(out).toHaveLength(1);
    const p = out[0]!;
    expect(p.name).toBe('long-call');
    expect(p.riskGraph).toBeDefined();
    expect(p.riskGraph?.underlying.length).toBeGreaterThan(2);
    expect(p.notes).toContain(DISCLAIMER);
    expect(llm.complete).toHaveBeenCalledOnce();
  });

  it('throws AgentParseError on malformed JSON instead of silently returning []', async () => {
    const llm = fakeLLM('this is not json');
    const s = new OptionsStrategist(llm);
    await expect(
      s.propose({
        symbol: 'NVDA',
        thesis: 'bullish',
        maxLossUsd: 500,
        chain: SAMPLE_CHAIN,
      }),
    ).rejects.toBeInstanceOf(AgentParseError);
  });

  it('throws AgentParseError when "plans" is not an array', async () => {
    const llm = fakeLLM(JSON.stringify({ plans: { not: 'an array' } }));
    const s = new OptionsStrategist(llm);
    await expect(
      s.propose({
        symbol: 'NVDA',
        thesis: 'bullish',
        maxLossUsd: 500,
        chain: SAMPLE_CHAIN,
      }),
    ).rejects.toBeInstanceOf(AgentParseError);
  });

  it('throws AgentParseError when "plans" key is missing entirely', async () => {
    const llm = fakeLLM(JSON.stringify({ other: 'shape' }));
    const s = new OptionsStrategist(llm);
    await expect(
      s.propose({
        symbol: 'NVDA',
        thesis: 'bullish',
        maxLossUsd: 500,
        chain: SAMPLE_CHAIN,
      }),
    ).rejects.toBeInstanceOf(AgentParseError);
  });

  it('does not call the network — LLM is fully injectable', async () => {
    const llm = fakeLLM(JSON.stringify({ plans: [] }));
    const s = new OptionsStrategist(llm);
    await s.propose({
      symbol: 'NVDA',
      thesis: 'bullish',
      maxLossUsd: 500,
      chain: SAMPLE_CHAIN,
    });
    // Single call, with json:true, system+user message shape.
    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({ json: true }),
    );
  });
});

describe('attachRiskGraph', () => {
  it('attaches a deterministic riskGraph and overrides maxLoss / maxGain / breakEvens', () => {
    const plan = definedRiskPlan({ maxLoss: 999, maxGain: 999, breakEvens: [42] });
    const out = attachRiskGraph(plan);
    expect(out.riskGraph).toBeDefined();
    // long call max loss = debit ~= 1.1 * 100 = 110; the computed value
    // overrides the LLM's 999.
    expect(out.maxLoss).toBeLessThan(999);
    expect(out.notes).toContain(DISCLAIMER);
  });

  it('appends the disclaimer even when legs are unusable for risk-graph', () => {
    // Premium-less contract (no bid/ask/last) skips risk-graph attachment but
    // still gets the disclaimer.
    const c = makeContract({ strike: 100, type: 'call' });
    const broken: OptionContract = { ...c, bid: null, ask: null, last: null };
    const plan: TradePlan = definedRiskPlan({
      legs: [{ action: 'buy', qty: 1, contract: broken }],
    });
    const out = attachRiskGraph(plan);
    expect(out.riskGraph).toBeUndefined();
    expect(out.notes).toContain(DISCLAIMER);
    // Original maxLoss should survive untouched.
    expect(out.maxLoss).toBe(plan.maxLoss);
  });

  it('falls back to the LLM maxLoss when the computed risk-graph is unbounded', () => {
    // Naked short call has unbounded loss → riskGraph.maxLoss === null.
    // attachRiskGraph should keep the LLM-provided maxLoss number so the
    // schema stays satisfied (RiskOfficer is the one that hard-rejects).
    const plan: TradePlan = definedRiskPlan({
      maxLoss: 4242,
      legs: [
        {
          action: 'sell',
          qty: 1,
          contract: makeContract({ strike: 100, type: 'call', bid: 1.0, ask: 1.2 }),
        },
      ],
    });
    const out = attachRiskGraph(plan);
    expect(out.riskGraph).toBeDefined();
    expect(out.riskGraph?.maxLoss).toBeNull();
    expect(out.maxLoss).toBe(4242);
  });

  it('preserves existing notes and appends the disclaimer (not replace)', () => {
    const plan = definedRiskPlan({ notes: 'custom note.' });
    const out = attachRiskGraph(plan);
    expect(out.notes?.startsWith('custom note.')).toBe(true);
    expect(out.notes).toContain(DISCLAIMER);
  });
});
