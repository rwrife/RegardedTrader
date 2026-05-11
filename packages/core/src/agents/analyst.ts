import type { LLM } from './llm.js';
import type { Briefing, Indicators, NewsItem, Quote } from '../schemas/index.js';
import { DISCLAIMER } from './llm.js';

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

  async brief(input: AnalystInput): Promise<Briefing> {
    const user = `Produce a JSON object with keys:
  bullCase (string, 2-4 sentences),
  bearCase (string, 2-4 sentences),
  catalysts (string[], up to 5),
  risks (string[], up to 5).

Data:
${JSON.stringify(input, null, 2)}`;

    const raw = await this.llm.complete({ system: SYSTEM, user, json: true });
    let parsed: {
      bullCase: string;
      bearCase: string;
      catalysts: string[];
      risks: string[];
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { bullCase: '', bearCase: '', catalysts: [], risks: [] };
    }

    return {
      symbol: input.symbol,
      asOf: new Date().toISOString(),
      quote: input.quote,
      indicators: input.indicators,
      bullCase: parsed.bullCase ?? '',
      bearCase: parsed.bearCase ?? '',
      catalysts: parsed.catalysts ?? [],
      risks: parsed.risks ?? [],
      news: input.news,
      disclaimer: DISCLAIMER,
    };
  }
}
