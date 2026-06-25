/**
 * Per-agent disclaimer tests (issue #77 acceptance criterion).
 *
 * Each test asserts that the agent's user-facing output carries the
 * canonical `DISCLAIMER` constant from `core/src/constants.ts` in a place
 * that surfaces render. The `Briefing` / `BriefingTechnical` / `BriefingNews`
 * Zod schemas additionally enforce a non-empty `disclaimer` at the
 * wire/storage seam.
 */
import { describe, it, expect, vi } from 'vitest';
import { Analyst } from './analyst.js';
import { Technician } from './technician.js';
import { OptionsStrategist, attachRiskGraph } from './options-strategist.js';
import type { LLM } from './llm.js';
import { DISCLAIMER } from '../constants.js';
import { definedRiskPlan } from './__fixtures__/option-contracts.js';
import {
  Briefing,
  BriefingTechnical,
  type Indicators,
  type Quote,
  type TradePlan,
} from '../schemas/index.js';

function fakeLLM(reply: string): LLM {
  return { complete: vi.fn().mockResolvedValue(reply) };
}

const QUOTE: Quote = {
  symbol: 'NVDA',
  price: 500,
  change: 1,
  changePercent: 0.2,
  volume: 1_000_000,
  asOf: '2026-01-01T00:00:00.000Z',
};

const INDICATORS: Indicators = {
  rsi14: 55,
  sma20: 495,
  sma50: 480,
  ema12: 498,
  ema26: 490,
  macd: 7,
  macdSignal: 5,
  atr14: 8,
};

describe('agent disclaimers (issue #77)', () => {
  it('Analyst attaches the canonical disclaimer and the Briefing schema accepts it', async () => {
    const llm = fakeLLM(
      JSON.stringify({
        bullCase: 'Solid fundamentals.',
        bearCase: 'Valuation rich.',
        catalysts: ['earnings'],
        risks: ['macro'],
      }),
    );
    const a = new Analyst(llm);
    const out = await a.brief({
      symbol: 'NVDA',
      quote: QUOTE,
      indicators: INDICATORS,
      news: [],
    });

    expect(out.disclaimer).toBe(DISCLAIMER);
    expect(out.disclaimer.length).toBeGreaterThan(0);
    // Schema accepts the canonical disclaimer.
    expect(() => Briefing.parse(out)).not.toThrow();
  });

  it('Briefing schema rejects an empty disclaimer', () => {
    expect(() =>
      Briefing.parse({
        symbol: 'NVDA',
        asOf: '2026-01-01T00:00:00.000Z',
        quote: QUOTE,
        indicators: INDICATORS,
        bullCase: '',
        bearCase: '',
        catalysts: [],
        risks: [],
        news: [],
        disclaimer: '',
        sourcesUsed: [],
      }),
    ).toThrow();
  });

  it('Technician sets a non-empty disclaimer and BriefingTechnical schema enforces it', async () => {
    const llm = fakeLLM(
      JSON.stringify({
        trend: 'Up.',
        momentum: 'Strong.',
        volatility: 'Moderate.',
        keyLevels: [490, 500, 510],
        commentary: 'Constructive read.',
      }),
    );
    const t = new Technician(llm);
    const out = await t.analyze({ symbol: 'NVDA', quote: QUOTE, indicators: INDICATORS });

    expect(out.disclaimer).toBe(DISCLAIMER);
    expect(out.disclaimer.length).toBeGreaterThan(0);

    // Empty disclaimer must fail validation.
    expect(() =>
      BriefingTechnical.parse({
        trend: 'Up.',
        momentum: 'Strong.',
        volatility: 'Moderate.',
        keyLevels: [490],
        commentary: 'x',
        sourcesUsed: [],
        disclaimer: '',
      }),
    ).toThrow();
  });

  it('OptionsStrategist plans carry the canonical disclaimer in notes', async () => {
    const plan: TradePlan = definedRiskPlan({ name: 'long-call' });
    const llm = fakeLLM(JSON.stringify({ plans: [plan] }));
    const s = new OptionsStrategist(llm);
    const out = await s.propose({
      symbol: 'NVDA',
      thesis: 'bullish',
      maxLossUsd: 500,
      chain: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.notes ?? '').toContain(DISCLAIMER);
  });

  it('attachRiskGraph always appends the canonical disclaimer (defense in depth)', () => {
    const bare: TradePlan = { ...definedRiskPlan({ name: 'bare' }), notes: undefined };
    const enriched = attachRiskGraph(bare);
    expect(enriched.notes ?? '').toContain(DISCLAIMER);
  });
});
