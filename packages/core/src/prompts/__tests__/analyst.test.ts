import { describe, it, expect } from 'vitest';
import { AnalystPrompts } from '../index.js';

describe('AnalystPrompts', () => {
  it('SYSTEM_PROMPT mentions strict JSON and grounding', () => {
    const s = AnalystPrompts.SYSTEM_PROMPT;
    expect(s).toMatch(/JSON/);
    expect(s).toMatch(/ONLY|only/);
    expect(s).toMatch(/analyst/i);
  });

  it('buildUserPrompt lists all four output keys and inlines the data', () => {
    const user = AnalystPrompts.buildUserPrompt({
      symbol: 'NVDA',
      quote: { symbol: 'NVDA', price: 100 } as never,
      indicators: { sma20: null, sma50: null, rsi14: null, macd: null, atr14: null } as never,
      news: [],
      nextEarnings: { date: '2026-06-18', daysUntil: 11, title: 'NVDA earnings' },
    });
    expect(user).toMatch(/bullCase/);
    expect(user).toMatch(/bearCase/);
    expect(user).toMatch(/catalysts/);
    expect(user).toMatch(/risks/);
    expect(user).toMatch(/NVDA/);
    expect(user).toMatch(/nextEarnings/);
    expect(user).toMatch(/avoid.*options/i);
  });

  it('includes sentiment guardrails when a recent sentiment snapshot is supplied', () => {
    const user = AnalystPrompts.buildUserPrompt({
      symbol: 'NVDA',
      quote: { symbol: 'NVDA', price: 100 } as never,
      indicators: { sma20: null, sma50: null, rsi14: null, macd: null, atr14: null } as never,
      news: [],
      sentiment: {
        symbol: 'NVDA',
        asOf: '2026-07-01T12:00:00.000Z',
        score: 0.35,
        confidence: 0.8,
        volume: 25,
        bySource: {},
      },
    });
    expect(user).toMatch(/Sentiment context/);
    expect(user).toMatch(/one input among many/i);
    expect(user).toMatch(/not.*buy\/sell recommendation/i);
  });
});
