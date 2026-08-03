import { describe, it, expect } from 'vitest';
import { OptionsStrategistPrompts } from '../index.js';

describe('OptionsStrategistPrompts', () => {
  it('SYSTEM_PROMPT forbids naked shorts and requires educational-note discipline', () => {
    const s = OptionsStrategistPrompts.SYSTEM_PROMPT;
    expect(s).toMatch(/NEVER recommend naked/);
    expect(s).toMatch(/educational/);
    expect(s).toMatch(/JSON/);
    expect(s).toMatch(/plans/);
  });

  it('SYSTEM_PROMPT instructs strategy preference and thesis-vs-recommendation contradiction callouts', () => {
    const s = OptionsStrategistPrompts.SYSTEM_PROMPT;
    expect(s).toMatch(/latestRecommendation/i);
    expect(s).toMatch(/prefer/i);
    expect(s).toMatch(/contradict/i);
  });

  it('buildUserPrompt inlines thesis, budget, symbol and truncates chain to 60', () => {
    const chain = Array.from({ length: 100 }, (_, i) => ({
      symbol: 'SPY',
      type: 'call' as const,
      strike: 400 + i,
      expiry: '2026-01-16',
      bid: 1,
      ask: 1.1,
      last: 1.05,
    }));
    const user = OptionsStrategistPrompts.buildUserPrompt({
      symbol: 'SPY',
      thesis: 'bullish through Jan',
      maxLossUsd: 500,
      chain: chain as never,
    });
    expect(user).toMatch(/Underlying: SPY/);
    expect(user).toMatch(/bullish through Jan/);
    expect(user).toMatch(/\$500/);
    expect(user).toMatch(/TradePlan/);
    // Should include the first strike but not the 100th (truncated to 60)
    expect(user).toContain('"strike": 400');
    expect(user).not.toContain('"strike": 499');
  });

  it('buildUserPrompt includes latestRecommendation when present', () => {
    const chain = [
      {
        symbol: 'NVDA',
        type: 'call' as const,
        strike: 120,
        expiry: '2026-01-16',
        bid: 1,
        ask: 1.1,
        last: 1.05,
      },
    ];
    const user = OptionsStrategistPrompts.buildUserPrompt({
      symbol: 'NVDA',
      thesis: 'bullish momentum',
      maxLossUsd: 500,
      chain: chain as never,
      latestRecommendation: {
        symbol: 'NVDA',
        generatedAt: '2026-01-01T00:00:00.000Z',
        asOf: { quote: '2026-01-01T00:00:00.000Z', options: null, sentiment: null, news: null },
        equity: {
          action: 'SELL',
          conviction: 0.7,
          rationale: 'weak setup',
          signals: [],
          contraSignals: [],
        },
        options: { coveredCall: null, coveredPut: null, nakedCall: null, nakedPut: null },
        riskFlags: [],
        sources: [],
        modelInfo: { provider: 'test', model: 'test', ruleVersion: '1.0.0' },
        disclaimer: 'Not financial advice.',
      },
    });
    expect(user).toMatch(/latestRecommendation/i);
    expect(user).toMatch(/SELL/);
  });
});
