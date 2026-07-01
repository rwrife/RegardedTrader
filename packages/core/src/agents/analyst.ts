import type { LLM } from './llm.js';
import type { Briefing, Indicators, NewsItem, Quote } from '../schemas/index.js';
import { AnalystOutputSchema } from '../schemas/index.js';
import { DISCLAIMER } from './llm.js';
import { AgentParseError } from './errors.js';

export interface AnalystInput {
  symbol: string;
  quote: Quote;
  indicators: Indicators;
  news: NewsItem[];
}

const SYSTEM = `You are a careful equity research analyst. You produce concise,
balanced bull/bear assessments grounded ONLY in the data the user provides. You
never invent specific numbers, earnings dates, or news that isn't given. Output
strict JSON matching the schema requested.`;

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
    const user = `Produce a JSON object with keys:
  bullCase (string, 2-4 sentences),
  bearCase (string, 2-4 sentences),
  catalysts (string[], up to 5),
  risks (string[], up to 5).

Data:
${JSON.stringify(input, null, 2)}`;

    const raw = await this.llm.complete({ system: SYSTEM, user, json: true });
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
