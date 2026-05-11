import type { LLM } from './llm.js';
import { DISCLAIMER } from './llm.js';
import type { OptionContract, TradePlan } from '../schemas/index.js';

const SYSTEM = `You are an options strategist. Given an underlying, a directional
or volatility thesis, a max-loss budget, and a slice of the options chain, you
propose 1-3 defined-risk structures (long call/put, vertical spread, calendar,
iron condor). You output STRICT JSON with an array "plans" of TradePlan objects.
You NEVER recommend naked short options. You ALWAYS include a "notes" field
mentioning that this is educational, not advice.`;

export interface StrategistInput {
  symbol: string;
  thesis: string;
  maxLossUsd: number;
  chain: OptionContract[];
}

export class OptionsStrategist {
  constructor(private readonly llm: LLM) {}

  async propose(input: StrategistInput): Promise<TradePlan[]> {
    const user = `Underlying: ${input.symbol}
Thesis: ${input.thesis}
Max loss budget: $${input.maxLossUsd}

Available contracts (truncated as needed):
${JSON.stringify(input.chain.slice(0, 60), null, 2)}

Return JSON: { "plans": TradePlan[] }`;
    const raw = await this.llm.complete({ system: SYSTEM, user, json: true });
    try {
      const obj = JSON.parse(raw);
      const plans: TradePlan[] = Array.isArray(obj.plans) ? obj.plans : [];
      return plans.map((p) => ({
        ...p,
        notes: (p.notes ? p.notes + ' ' : '') + DISCLAIMER,
      }));
    } catch {
      return [];
    }
  }
}
