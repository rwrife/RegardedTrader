import type { LLM } from './llm.js';
import { DISCLAIMER } from './llm.js';
import type { OptionContract, TradePlan, RiskGraphSeries } from '../schemas/index.js';
import type { Recommendation, Verdict } from '../schemas/recommendation.js';
import { StrategistOutputSchema } from '../schemas/index.js';
import { AgentParseError } from './errors.js';
import { riskGraph, type RiskGraphLeg } from '../options/index.js';
import { OptionsStrategistPrompts } from '../prompts/index.js';

export interface StrategistInput {
  symbol: string;
  thesis: string;
  maxLossUsd: number;
  chain: OptionContract[];
  latestRecommendation?: Recommendation;
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
    const withRisk = result.data.plans.map((p) => attachRiskGraph(p));
    return prioritizeAndAnnotatePlans(withRisk, input);
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

type Direction = 'bullish' | 'bearish' | 'neutral';

function prioritizeAndAnnotatePlans(
  plans: TradePlan[],
  input: StrategistInput,
): TradePlan[] {
  const latest = input.latestRecommendation;
  if (!latest) return plans;

  const conflictNote = thesisConflictNote(input.thesis, latest);
  return plans
    .map((plan, index) => ({
      plan: conflictNote ? appendPlanNote(plan, conflictNote) : plan,
      score: planRecommendationScore(plan, latest),
      index,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.plan);
}

function thesisConflictNote(thesis: string, recommendation: Recommendation): string | null {
  const thesisDirection = inferDirection(thesis);
  if (thesisDirection === 'neutral') return null;

  const action = recommendation.equity.action;
  const recommendationDirection: Direction =
    action === 'BUY'
      ? 'bullish'
      : action === 'SELL' || action === 'AVOID'
        ? 'bearish'
        : 'neutral';

  if (recommendationDirection === 'neutral' || thesisDirection === recommendationDirection) {
    return null;
  }

  return `Latest recommendation conflict: thesis is ${thesisDirection}, but the latest equity recommendation is ${action} (conviction ${recommendation.equity.conviction.toFixed(2)}).`;
}

function appendPlanNote(plan: TradePlan, note: string): TradePlan {
  const existing = plan.notes ?? '';
  if (existing.includes(note)) return plan;
  return { ...plan, notes: existing ? `${existing} ${note}` : note };
}

function planRecommendationScore(plan: TradePlan, recommendation: Recommendation): number {
  const { hasShortCall, hasShortPut } = legFlags(plan);
  const planDirection = inferPlanDirection(plan);

  let score = 0;
  score += verdictWeight(recommendation.options.coveredCall, hasShortCall);
  score += verdictWeight(recommendation.options.coveredPut, hasShortPut);

  if (planDirection === 'bullish') {
    score += equityDirectionWeight(recommendation.equity.action, 'bullish');
  } else if (planDirection === 'bearish') {
    score += equityDirectionWeight(recommendation.equity.action, 'bearish');
  }

  return score;
}

function verdictWeight(verdict: Verdict | null, applies: boolean): number {
  if (!applies || !verdict) return 0;
  if (verdict.action === 'BUY') return 3;
  if (verdict.action === 'HOLD') return 1;
  if (verdict.action === 'SELL') return -3;
  return -1;
}

function equityDirectionWeight(
  action: Recommendation['equity']['action'],
  direction: Direction,
): number {
  if (action === 'HOLD') return 0;
  if (direction === 'bullish') return action === 'BUY' ? 2 : -2;
  if (direction === 'bearish') return action === 'SELL' || action === 'AVOID' ? 2 : -2;
  return 0;
}

function legFlags(plan: TradePlan): { hasShortCall: boolean; hasShortPut: boolean } {
  let hasShortCall = false;
  let hasShortPut = false;
  for (const leg of plan.legs) {
    if (leg.action !== 'sell') continue;
    if (leg.contract.type === 'call') hasShortCall = true;
    if (leg.contract.type === 'put') hasShortPut = true;
  }
  return { hasShortCall, hasShortPut };
}

function inferPlanDirection(plan: TradePlan): Direction {
  let net = 0;
  for (const leg of plan.legs) {
    const qty = leg.qty * (leg.action === 'buy' ? 1 : -1);
    net += leg.contract.type === 'call' ? qty : -qty;
  }
  if (net > 0) return 'bullish';
  if (net < 0) return 'bearish';
  return 'neutral';
}

function inferDirection(text: string): Direction {
  const t = text.toLowerCase();
  const bullish = /\b(bull|bullish|upside|uptrend|rally|breakout|long|calls?)\b/.test(t);
  const bearish = /\b(bear|bearish|downside|downtrend|selloff|breakdown|short|puts?)\b/.test(t);
  if (bullish && !bearish) return 'bullish';
  if (bearish && !bullish) return 'bearish';
  return 'neutral';
}
