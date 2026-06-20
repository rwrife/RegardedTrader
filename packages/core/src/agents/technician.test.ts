import { describe, it, expect, vi } from 'vitest';
import { Technician } from './technician.js';
import type { LLM } from './llm.js';
import { DISCLAIMER } from './llm.js';
import { BriefingTechnical, type Indicators, type Quote } from '../schemas/index.js';

function fakeLLM(reply: string): LLM {
  return { complete: vi.fn().mockResolvedValue(reply) };
}

const QUOTE: Quote = {
  symbol: 'NVDA',
  price: 500,
  change: 2.5,
  changePercent: 0.5,
  volume: 1_000_000,
  asOf: '2026-01-01T00:00:00.000Z',
};

const INDICATORS: Indicators = {
  rsi14: 62.4,
  sma20: 495.1,
  sma50: 480.7,
  ema12: 498.2,
  ema26: 490.6,
  macd: 7.6,
  macdSignal: 5.2,
  atr14: 8.4,
};

const FULL_REPLY = JSON.stringify({
  trend: 'Uptrend — 20SMA above 50SMA.',
  momentum: 'RSI 62.4 neutral-to-strong; MACD above signal.',
  volatility: 'ATR ~8.4, moderate.',
  keyLevels: [480, 495, 510],
  commentary:
    'NVDA is trending up with healthy momentum and moderate volatility. Watch 510 for resistance and 480 for support. Not financial advice.',
});

describe('Technician', () => {
  it('parses a well-formed JSON reply into a BriefingTechnical', async () => {
    const llm = fakeLLM(FULL_REPLY);
    const t = new Technician(llm);
    const out = await t.analyze({ symbol: 'NVDA', quote: QUOTE, indicators: INDICATORS });

    expect(out.trend).toMatch(/Uptrend/);
    expect(out.momentum).toMatch(/RSI/);
    expect(out.volatility).toMatch(/ATR/);
    expect(out.keyLevels).toEqual([480, 495, 510]);
    expect(out.commentary.length).toBeGreaterThan(10);
    expect(out.sourcesUsed).toContain('indicators');
    expect(llm.complete).toHaveBeenCalledOnce();
    // Schema-validated at the seam.
    expect(() => BriefingTechnical.parse(out)).not.toThrow();
  });

  it('falls back to deterministic strings on malformed JSON without throwing', async () => {
    const llm = fakeLLM('this is not json');
    const t = new Technician(llm);
    const out = await t.analyze({ symbol: 'NVDA', quote: QUOTE, indicators: INDICATORS });

    // SMA20 > SMA50 → bias upward fallback.
    expect(out.trend).toMatch(/upward/i);
    // RSI 62.4 is neutral.
    expect(out.momentum).toMatch(/neutral/i);
    expect(out.volatility).toMatch(/ATR/);
    expect(out.keyLevels).toEqual([]);
    expect(out.commentary).toContain(DISCLAIMER);
  });

  it('filters non-numeric values out of keyLevels', async () => {
    const llm = fakeLLM(
      JSON.stringify({
        trend: 'sideways',
        momentum: 'flat',
        volatility: 'low',
        keyLevels: [100, 'oops', null, 110, NaN],
        commentary: 'Rangebound.',
      }),
    );
    const t = new Technician(llm);
    const out = await t.analyze({ symbol: 'NVDA', quote: QUOTE, indicators: INDICATORS });
    expect(out.keyLevels).toEqual([100, 110]);
  });

  it('handles null indicators with informative fallbacks', async () => {
    const llm = fakeLLM('{}');
    const empty: Indicators = {
      rsi14: null,
      sma20: null,
      sma50: null,
      ema12: null,
      ema26: null,
      macd: null,
      macdSignal: null,
      atr14: null,
    };
    const t = new Technician(llm);
    const out = await t.analyze({ symbol: 'NVDA', quote: QUOTE, indicators: empty });
    expect(out.trend).toMatch(/unavailable/i);
    expect(out.momentum).toMatch(/unavailable/i);
    expect(out.volatility).toMatch(/unavailable/i);
  });

  it('reports overbought/oversold momentum in fallbacks', async () => {
    const overbought: Indicators = { ...INDICATORS, rsi14: 78 };
    const oversold: Indicators = { ...INDICATORS, rsi14: 22 };
    const t = new Technician(fakeLLM('{}'));

    const a = await t.analyze({ symbol: 'NVDA', quote: QUOTE, indicators: overbought });
    expect(a.momentum).toMatch(/overbought/i);
    const b = await t.analyze({ symbol: 'NVDA', quote: QUOTE, indicators: oversold });
    expect(b.momentum).toMatch(/oversold/i);
  });
});
