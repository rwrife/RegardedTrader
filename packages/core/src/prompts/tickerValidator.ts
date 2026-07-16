/**
 * Prompts for the {@link TickerValidator} agent (issue #182).
 *
 * Extracted from `agents/ticker-validator.ts` per AGENTS.md
 * `core/src/prompts/` convention.
 */
import type { WebSearchResult } from '../clients/web-search.js';

export const SYSTEM_PROMPT = `You are a US-equities reference librarian. Given a candidate
ticker symbol and a few web search snippets, you decide whether the symbol
unambiguously refers to ONE publicly traded US equity (NYSE, NASDAQ, NYSE
American, OTC). If yes, you extract a structured profile. If not, you say so
and propose alternatives. You never invent facts that are not visible in the
provided snippets. You only output JSON.`;

export const VALID_INSTRUCTION = `Reply with strict JSON in ONE of these two shapes.

Shape A — confident match:
{
  "match": true,
  "profile": {
    "symbol": "<canonical uppercase ticker, 1-10 chars, A-Z . - only>",
    "name": "<official company name>",
    "exchange": "<NYSE | NASDAQ | NYSE American | OTC | ...>",
    "sector": "<GICS-style sector, e.g. Technology>",
    "industry": "<GICS-style industry, e.g. Semiconductors>",
    "description": "<1-2 sentence plain-English company description>"
  }
}

Shape B — ambiguous, wrong, or insufficient info:
{
  "match": false,
  "reason": "<one short sentence explaining why>",
  "suggestions": [
    { "symbol": "<TICKER>", "name": "<company>", "reason": "<why it might be what the user meant>" }
  ]
}

Rules:
- Only output JSON. No prose, no markdown.
- "symbol" must be uppercase, 1-10 chars, only letters / dot / hyphen.
- If the snippets are about a private company, an ETF, a crypto coin, a person,
  or a non-US listing, return Shape B.
- If two different US equities plausibly match the input, return Shape B with
  both as suggestions.
- "description" must be derived from the snippets, not memorized.`;

export interface TickerValidatorUserPromptInput {
  symbol: string;
  results: WebSearchResult[];
}

export function buildUserPrompt(input: TickerValidatorUserPromptInput): string {
  const { symbol, results } = input;
  return [
    `Candidate ticker: ${symbol}`,
    '',
    'Web search snippets:',
    ...results.map(
      (r, i) => `[${i + 1}] ${r.title}\n    ${r.snippet}\n    URL: ${r.url}`,
    ),
    '',
    VALID_INSTRUCTION,
  ].join('\n');
}
