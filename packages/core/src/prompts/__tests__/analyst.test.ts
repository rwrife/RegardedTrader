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
    });
    expect(user).toMatch(/bullCase/);
    expect(user).toMatch(/bearCase/);
    expect(user).toMatch(/catalysts/);
    expect(user).toMatch(/risks/);
    expect(user).toMatch(/NVDA/);
  });
});
