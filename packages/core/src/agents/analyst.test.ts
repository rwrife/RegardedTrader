/**
 * Analyst LLM-output validation tests (issue #165).
 *
 * The Analyst previously wrapped `JSON.parse` in a try/catch and, on any
 * failure, silently returned a Briefing with empty strings/arrays. CLI and
 * web surfaces then rendered blank cards with no signal that the LLM had
 * produced garbage. Post-#165 the Analyst validates the parsed reply
 * against `AnalystOutputSchema` and throws a typed `AgentParseError`,
 * carrying the offending path/message pairs so callers can distinguish a
 * hard parse failure from a real empty result.
 */
import { describe, it, expect, vi } from 'vitest';
import { Analyst } from './analyst.js';
import { AgentParseError } from './errors.js';
import type { LLM } from './llm.js';
import { DISCLAIMER } from './llm.js';
import type { Indicators, Quote } from '../schemas/index.js';
import { Briefing } from '../schemas/index.js';

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

const INPUT = { symbol: 'NVDA', quote: QUOTE, indicators: INDICATORS, news: [] };

describe('Analyst LLM-output validation (issue #165)', () => {
  it('parses a well-formed JSON reply into a schema-valid Briefing', async () => {
    const llm = fakeLLM(
      JSON.stringify({
        bullCase: 'Solid fundamentals and expanding TAM.',
        bearCase: 'Valuation is rich vs. peers.',
        catalysts: ['earnings', 'product launch'],
        risks: ['macro', 'competition'],
      }),
    );
    const out = await new Analyst(llm).brief(INPUT);
    expect(out.bullCase).toMatch(/fundamentals/);
    expect(out.bearCase).toMatch(/Valuation/);
    expect(out.catalysts).toEqual(['earnings', 'product launch']);
    expect(out.disclaimer).toBe(DISCLAIMER);
    expect(() => Briefing.parse(out)).not.toThrow();
  });

  it('defaults missing catalysts/risks arrays via the schema', async () => {
    const llm = fakeLLM(
      JSON.stringify({ bullCase: 'bull', bearCase: 'bear' }),
    );
    const out = await new Analyst(llm).brief(INPUT);
    expect(out.catalysts).toEqual([]);
    expect(out.risks).toEqual([]);
  });

  it('throws AgentParseError on malformed JSON (no silent empty briefing)', async () => {
    const llm = fakeLLM('not-json at all');
    await expect(new Analyst(llm).brief(INPUT)).rejects.toBeInstanceOf(
      AgentParseError,
    );
  });

  it('throws AgentParseError when required keys are missing', async () => {
    const llm = fakeLLM(JSON.stringify({ catalysts: [], risks: [] }));
    await expect(new Analyst(llm).brief(INPUT)).rejects.toBeInstanceOf(
      AgentParseError,
    );
  });

  it('throws AgentParseError when fields are the wrong type', async () => {
    const llm = fakeLLM(
      JSON.stringify({ bullCase: 42, bearCase: 'ok', catalysts: 'nope' }),
    );
    const err = await new Analyst(llm)
      .brief(INPUT)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentParseError);
    const parseErr = err as AgentParseError;
    expect(parseErr.agent).toBe('Analyst');
    // Issues carry path + message pairs so callers can locate the failure.
    expect(parseErr.issues.length).toBeGreaterThan(0);
    expect(parseErr.raw).toContain('42');
  });

  it('rejects empty-string bull/bear (would otherwise be the silent-empty bug)', async () => {
    const llm = fakeLLM(JSON.stringify({ bullCase: '', bearCase: '' }));
    await expect(new Analyst(llm).brief(INPUT)).rejects.toBeInstanceOf(
      AgentParseError,
    );
  });
});
