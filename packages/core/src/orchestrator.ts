import type { MarketDataClient } from './clients/index.js';
import { computeIndicators } from './indicators/index.js';
import { Analyst, OptionsStrategist, RiskOfficer } from './agents/index.js';
import type { LLM, RiskCaps } from './agents/index.js';
import type { Briefing, TradePlan } from './schemas/index.js';

export class Orchestrator {
  private readonly analyst: Analyst;
  private readonly strategist: OptionsStrategist;
  private readonly risk: RiskOfficer;

  constructor(
    private readonly market: MarketDataClient,
    llm: LLM,
    caps: RiskCaps = { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true },
  ) {
    this.analyst = new Analyst(llm);
    this.strategist = new OptionsStrategist(llm);
    this.risk = new RiskOfficer(caps);
  }

  async briefing(symbol: string): Promise<Briefing> {
    const [quote, history, news] = await Promise.all([
      this.market.quote(symbol),
      this.market.history(symbol, 180),
      this.market.news(symbol),
    ]);
    const indicators = computeIndicators(history);
    return this.analyst.brief({ symbol, quote, indicators, news });
  }

  async proposePlans(input: {
    symbol: string;
    thesis: string;
    maxLossUsd: number;
    expiry?: string;
  }): Promise<{ plan: TradePlan; ok: boolean; violations: string[] }[]> {
    const chain = await this.market.optionsChain(input.symbol, input.expiry);
    const plans = await this.strategist.propose({ ...input, chain });
    return plans.map((plan) => ({ plan, ...this.risk.review(plan) }));
  }
}
