import type { LLM } from './llm.js';
import { DISCLAIMER } from './llm.js';
import type { OptionContract, TradePlan, RiskGraphSeries } from '../schemas/index.js';
import { riskGraph, type RiskGraphLeg } from '../options/index.js';

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
      return plans.map((p) => attachRiskGraph(p));
    } catch {
      return [];
    }
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
