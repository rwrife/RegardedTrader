/**
 * Prompts for the {@link Analyst} agent (issue #182).
 *
 * The `SYSTEM_PROMPT` and `buildUserPrompt` helper live here — separately from
 * the agent behaviour — so prompt tone, safety language, and JSON-schema
 * instructions can be audited and regressed in one place, per AGENTS.md
 * ("New LLM prompt? Put it in `core/src/prompts/`").
 */
import type { Briefing, Indicators, NewsItem, Quote } from '../schemas/index.js';

export const SYSTEM_PROMPT = `You are a careful equity research analyst. You produce concise,
balanced bull/bear assessments grounded ONLY in the data the user provides. You
never invent specific numbers, earnings dates, or news that isn't given. Output
strict JSON matching the schema requested.`;

export interface AnalystUserPromptInput {
  symbol: string;
  quote: Quote;
  indicators: Indicators;
  news: NewsItem[];
}

export function buildUserPrompt(input: AnalystUserPromptInput): string {
  return `Produce a JSON object with keys:
  bullCase (string, 2-4 sentences),
  bearCase (string, 2-4 sentences),
  catalysts (string[], up to 5),
  risks (string[], up to 5).

Data:
${JSON.stringify(input, null, 2)}`;
}

// Re-export the briefing type so prompt-authoring callers have a single
// import surface if they need to reason about the output shape too.
export type { Briefing };
