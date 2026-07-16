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
});
