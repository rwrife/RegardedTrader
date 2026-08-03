/**
 * Prompts for the {@link Analyst} agent (issue #182).
 *
 * The `SYSTEM_PROMPT` and `buildUserPrompt` helper live here — separately from
 * the agent behaviour — so prompt tone, safety language, and JSON-schema
 * instructions can be audited and regressed in one place, per AGENTS.md
 * ("New LLM prompt? Put it in `core/src/prompts/`").
 */
import type {
  Briefing,
  Indicators,
  NewsItem,
  Quote,
} from '../schemas/index.js';
import type { SentimentSnapshot } from '../schemas/sentiment.js';

export const SYSTEM_PROMPT = `You are a careful equity research analyst. You produce concise,
balanced bull/bear assessments grounded ONLY in the data the user provides. You
never invent specific numbers, earnings dates, or news that isn't given. Output
strict JSON matching the schema requested.`;

export interface AnalystUserPromptInput {
  symbol: string;
  quote: Quote;
  indicators: Indicators;
  news: NewsItem[];
  sentiment?: SentimentSnapshot;
  nextEarnings?: {
    date: string;
    daysUntil: number;
    title?: string;
    startUtc?: string;
  };
}

export function buildUserPrompt(input: AnalystUserPromptInput): string {
  const sentimentBlock = input.sentiment
    ? `
Sentiment context (optional, supplemental only):
- Recent aggregate sentiment snapshot:
${JSON.stringify(input.sentiment, null, 2)}
- Guardrails:
  - Treat sentiment as one input among many (price action, indicators, and news remain primary).
  - Do NOT interpret sentiment alone as a buy/sell recommendation.
  - If sentiment and other inputs conflict, explicitly call out that conflict.
`
    : '';

  return `Produce a JSON object with keys:
  bullCase (string, 2-4 sentences),
  bearCase (string, 2-4 sentences),
  catalysts (string[], up to 5),
  risks (string[], up to 5).

If provided headlines include an \`id\` field (e.g. "h1"), cite relevant IDs
inline inside bullCase/bearCase/catalysts/risks like "[h1]" so downstream
surfaces can trace each claim.
${sentimentBlock}

If \`nextEarnings\` is present:
- when \`nextEarnings.daysUntil <= 7\`, explicitly treat speculative options
  setups as elevated event risk and recommend avoiding new options exposure.
- when \`nextEarnings.daysUntil <= 1\`, explicitly call out potential IV crush
  risk in the \`risks\` list.

Data:
${JSON.stringify(input, null, 2)}`;
}

// Re-export the briefing type so prompt-authoring callers have a single
// import surface if they need to reason about the output shape too.
export type { Briefing };
