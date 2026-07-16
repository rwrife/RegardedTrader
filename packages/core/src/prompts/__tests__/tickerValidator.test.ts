import { describe, it, expect } from 'vitest';
import { TickerValidatorPrompts } from '../index.js';

describe('TickerValidatorPrompts', () => {
  it('SYSTEM_PROMPT restricts to US equities and JSON-only output', () => {
    const s = TickerValidatorPrompts.SYSTEM_PROMPT;
    expect(s).toMatch(/US-equities/);
    expect(s).toMatch(/only output JSON/i);
    expect(s).toMatch(/NYSE|NASDAQ/);
  });

  it('VALID_INSTRUCTION describes both match shapes and the symbol rules', () => {
    const v = TickerValidatorPrompts.VALID_INSTRUCTION;
    expect(v).toMatch(/"match": true/);
    expect(v).toMatch(/"match": false/);
    expect(v).toMatch(/suggestions/);
    expect(v).toMatch(/uppercase/);
  });

  it('buildUserPrompt embeds candidate + numbered snippets + instruction', () => {
    const user = TickerValidatorPrompts.buildUserPrompt({
      symbol: 'NVDA',
      results: [
        { title: 'Nvidia Corp', snippet: 'Semiconductor company', url: 'https://ex.com/1' },
        { title: 'NVDA on NASDAQ', snippet: 'listing details', url: 'https://ex.com/2' },
      ],
    });
    expect(user).toMatch(/Candidate ticker: NVDA/);
    expect(user).toMatch(/\[1\] Nvidia Corp/);
    expect(user).toMatch(/\[2\] NVDA on NASDAQ/);
    expect(user).toMatch(/Reply with strict JSON/);
  });
});
