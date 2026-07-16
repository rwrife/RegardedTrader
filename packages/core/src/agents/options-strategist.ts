import type { LLM } from './llm.js';
import { DISCLAIMER } from './llm.js';
import type { OptionContract, TradePlan, RiskGraphSeries } from '../schemas/index.js';
import { StrategistOutputSchema } from '../schemas/index.js';
import { AgentParseError } from './errors.js';
import { riskGraph, type RiskGraphLeg } from '../options/index.js';
import { OptionsStrategistPrompts } from '../prompts/index.js';

export interface StrategistInput {
  symbol: string;
  thesis: string;
  maxLossUsd: number;
  chain: OptionContract[];
}

export class OptionsStrategist {
  constructor(private readonly llm: LLM) {}

  async propose(input: StrategistInput): Promise<TradePlan[]> {
    const user = OptionsStrategistPrompts.buildUserPrompt(input);
    const raw = await this.llm.complete({
      system: OptionsStrategistPrompts.SYSTEM_PROMPT,
      user,
      json: true,
    });
    let jsonValue: unknown;
    try {
      jsonValue = JSON.parse(raw);
    } catch (err) {
      throw new AgentParseError(
        'OptionsStrategist',
        [(err as Error).message ?? 'invalid JSON'],
        raw,
      );
    }
    const result = StrategistOutputSchema.safeParse(jsonValue);
    if (!result.success) {
      const issues = result.error.issues.map(
        (i) => `${i.path.join('.') || '<root>'}: ${i.message}`,
      );
      throw new AgentParseError('OptionsStrategist', issues, raw);
    }
    return result.data.plans.map((p) => attachRiskGraph(p));
  }
}

/**
 * Compute a deterministic risk-graph for the plan's legs, attach it, and
 * overwrite `maxLoss` / `maxGain` / `breakEvens` with the computed values so
 * downstream consumers (RiskOfficer, dashboards) all agree on one source of
 * truth. Falls back to whatever the LLM produced if the legs are unusable
 * (e.g. premium missing). Always appends the legally-required disclaimer.
 */
export function attachRiskGraph(p: TradePlan): TradePlan {
  const notes = (p.notes ? p.notes + ' ' : '') + DISCLAIMER;
  const legs = toRiskGraphLegs(p);
  if (!legs) return { ...p, notes };

  let series: RiskGraphSeries;
  try {
    series = riskGraph(legs);
  } catch {
    return { ...p, notes };
  }

  // Use the computed-finite max-loss when available; if unbounded (null),
  // fall back to the LLM's number so the schema stays satisfied. Downstream
  // RiskOfficer treats null max-loss as a hard reject.
  const computedMaxLoss = series.maxLoss === null ? p.maxLoss : Math.abs(series.maxLoss);
  return {
    ...p,
    notes,
    maxLoss: computedMaxLoss,
    maxGain: series.maxGain,
    breakEvens: series.breakevens,
    riskGraph: series,
  };
}

function toRiskGraphLegs(p: TradePlan): RiskGraphLeg[] | null {
  const out: RiskGraphLeg[] = [];
  for (const leg of p.legs) {
    const c = leg.contract;
    // Use mid-mark when both bid/ask exist, else last, else skip-the-plan.
    let premium: number | null = null;
    if (c.bid !== null && c.ask !== null) {
      premium = (c.bid + c.ask) / 2;
    } else if (c.last !== null) {
      premium = c.last;
    }
    if (premium === null || premium < 0) return null;
    out.push({
      side: leg.action === 'buy' ? 'long' : 'short',
      type: c.type,
      strike: c.strike,
      qty: leg.qty,
      premium,
    });
  }
  return out;
}
