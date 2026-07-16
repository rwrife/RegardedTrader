import { describe, it, expect } from 'vitest';
import { TechnicianPrompts } from '../index.js';

describe('TechnicianPrompts', () => {
  it('SYSTEM_PROMPT forbids trade recommendations and demands JSON', () => {
    const s = TechnicianPrompts.SYSTEM_PROMPT;
    expect(s).toMatch(/JSON/);
    expect(s).toMatch(/never\s+recommend/i);
    expect(s).toMatch(/technical/i);
  });

  it('buildUserPrompt lists the five output keys and inlines symbol/quote/indicators', () => {
    const user = TechnicianPrompts.buildUserPrompt({
      symbol: 'AAPL',
      quote: { symbol: 'AAPL', price: 200 } as never,
      indicators: { sma20: 195, sma50: 190, rsi14: 55, macd: null, atr14: 3 } as never,
    });
    for (const key of ['trend', 'momentum', 'volatility', 'keyLevels', 'commentary']) {
      expect(user).toMatch(new RegExp(key));
    }
    expect(user).toMatch(/AAPL/);
    expect(user).toMatch(/Indicators/);
  });
});
