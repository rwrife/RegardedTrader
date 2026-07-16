/**
 * Prompts for the {@link Technician} agent (issue #182).
 *
 * Extracted from `agents/technician.ts` so prompt edits stop touching
 * behaviour files (per AGENTS.md `core/src/prompts/` convention).
 */
import type { Indicators, Quote } from '../schemas/index.js';

export const SYSTEM_PROMPT = `You are a technical analyst. You read price/indicator data and
produce a concise, plain-English chart read. You ONLY use the numbers the user
provides — never invent price levels, news, or earnings dates. You never
recommend specific trades. Output strict JSON matching the schema requested.`;

export interface TechnicianUserPromptInput {
  symbol: string;
  quote: Quote;
  indicators: Indicators;
}

export function buildUserPrompt(input: TechnicianUserPromptInput): string {
  const { symbol, quote, indicators } = input;
  return `Produce a JSON object with keys:
  trend (string, one short sentence: "uptrend" / "downtrend" / "rangebound" + brief reason),
  momentum (string, one short sentence referencing RSI/MACD),
  volatility (string, one short sentence referencing ATR if available),
  keyLevels (number[], 2-4 round-number support/resistance levels near the current price),
  commentary (string, 2-3 sentences combining the above into a plain-English chart read).

Rules:
- Do not invent values. If an indicator is null, say so.
- Do not recommend trades, only describe the chart.
- Use ONLY the data below.

Symbol: ${symbol}
Quote: ${JSON.stringify(quote)}
Indicators: ${JSON.stringify(indicators)}`;
}
