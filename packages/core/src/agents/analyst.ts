import type { LLM } from './llm.js';
import type { Briefing, Indicators, NewsItem, Quote } from '../schemas/index.js';
import { AnalystOutputSchema } from '../schemas/index.js';
import { DISCLAIMER } from './llm.js';
import { AgentParseError } from './errors.js';
import { AnalystPrompts } from '../prompts/index.js';

export interface AnalystInput {
  symbol: string;
  quote: Quote;
  indicators: Indicators;
  news: NewsItem[];
}

export class Analyst {
  constructor(private readonly llm: LLM) {}

  /**
   * Ask the LLM for a bull/bear briefing and validate its JSON with Zod
   * (issue #165). Malformed JSON, missing keys, or wrong types raise a
   * typed {@link AgentParseError} — callers used to swallow the failure and
   * emit an empty briefing, which the CLI/web then rendered as blank
   * cards with no signal that anything went wrong.
   */
  async brief(input: AnalystInput): Promise<Briefing> {
    const user = AnalystPrompts.buildUserPrompt(input);

    const raw = await this.llm.complete({
      system: AnalystPrompts.SYSTEM_PROMPT,
      user,
      json: true,
    });
    let jsonValue: unknown;
    try {
      jsonValue = JSON.parse(raw);
    } catch (err) {
      throw new AgentParseError(
        'Analyst',
        [(err as Error).message ?? 'invalid JSON'],
        raw,
      );
    }
    const result = AnalystOutputSchema.safeParse(jsonValue);
    if (!result.success) {
      const issues = result.error.issues.map(
        (i) => `${i.path.join('.') || '<root>'}: ${i.message}`,
      );
      throw new AgentParseError('Analyst', issues, raw);
    }
    const parsed = result.data;

    return {
      symbol: input.symbol,
      asOf: new Date().toISOString(),
      quote: input.quote,
      indicators: input.indicators,
      bullCase: parsed.bullCase,
      bearCase: parsed.bearCase,
      catalysts: parsed.catalysts,
      risks: parsed.risks,
      news: input.news,
      disclaimer: DISCLAIMER,
      sourcesUsed: [],
    };
  }
}
