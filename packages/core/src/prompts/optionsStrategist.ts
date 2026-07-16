/**
 * Prompts for the {@link OptionsStrategist} agent (issue #182).
 *
 * Extracted from `agents/options-strategist.ts` per AGENTS.md
 * `core/src/prompts/` convention.
 */
import type { OptionContract } from '../schemas/index.js';

export const SYSTEM_PROMPT = `You are an options strategist. Given an underlying, a directional
or volatility thesis, a max-loss budget, and a slice of the options chain, you
propose 1-3 defined-risk structures (long call/put, vertical spread, calendar,
iron condor). You output STRICT JSON with an array "plans" of TradePlan objects.
You NEVER recommend naked short options. You ALWAYS include a "notes" field
mentioning that this is educational, not advice.`;

export interface OptionsStrategistUserPromptInput {
  symbol: string;
  thesis: string;
  maxLossUsd: number;
  chain: OptionContract[];
}

export function buildUserPrompt(input: OptionsStrategistUserPromptInput): string {
  return `Underlying: ${input.symbol}
Thesis: ${input.thesis}
Max loss budget: $${input.maxLossUsd}

Available contracts (truncated as needed):
${JSON.stringify(input.chain.slice(0, 60), null, 2)}

Return JSON: { "plans": TradePlan[] }`;
}
