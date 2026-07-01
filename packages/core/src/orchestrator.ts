import type { MarketDataClient } from './clients/index.js';
import { computeIndicators } from './indicators/index.js';
import {
  Analyst,
  OptionsStrategist,
  RiskOfficer,
  AgentParseError,
  DISCLAIMER,
} from './agents/index.js';
import type {
  LLM,
  RiskCaps,
  TechnicianAgent,
  NewsScoutAgent,
} from './agents/index.js';
import {
  Briefing,
  type Briefing as BriefingT,
  type BriefingStrategist,
  type PlansResponse,
  type ReviewedTradePlan,
  type RiskReview,
  type TradePlan,
} from './schemas/index.js';

/**
 * Optional inputs to `Orchestrator.briefing` (issue #126). Supplying a
 * `thesis` + `maxLossUsd` triggers a strategist pass; otherwise the briefing
 * is analyst-only (+ optional Technician / NewsScout when registered).
 */
export interface BriefingOptions {
  thesis?: string;
  maxLossUsd?: number;
  expiry?: string;
}

export interface OrchestratorAgents {
  technician?: TechnicianAgent;
  newsScout?: NewsScoutAgent;
}

export class Orchestrator {
  private readonly analyst: Analyst;
  private readonly strategist: OptionsStrategist;
  private readonly risk: RiskOfficer;
  private readonly technician?: TechnicianAgent;
  private readonly newsScout?: NewsScoutAgent;

  constructor(
    private readonly market: MarketDataClient,
    llm: LLM,
    caps: RiskCaps = { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true },
    agents: OrchestratorAgents = {},
  ) {
    this.analyst = new Analyst(llm);
    this.strategist = new OptionsStrategist(llm);
    this.risk = new RiskOfficer(caps);
    this.technician = agents.technician;
    this.newsScout = agents.newsScout;
  }

  /**
   * Full briefing pipeline (issue #126). Fans agents out in parallel where
   * safe, runs `RiskOfficer` last on any strategist candidates, and returns
   * a Zod-validated `Briefing`. Optional Technician / NewsScout agents are
   * skipped — not failed — when not registered, so this method works in
   * minimal deployments and in fuller ones without code changes.
   */
  async briefing(symbol: string, opts: BriefingOptions = {}): Promise<BriefingT> {
    const [quote, history, news] = await Promise.all([
      this.market.quote(symbol),
      this.market.history(symbol, 180),
      this.market.news(symbol),
    ]);
    const indicators = computeIndicators(history);

    // Fan out the analyst + optional Technician/NewsScout in parallel.
    // The strategist runs only when a thesis + budget are supplied; the
    // `RiskOfficer` reviews its candidates after they come back.
    const technicalPromise = this.technician
      ? this.technician.analyze({ symbol, quote, indicators })
      : Promise.resolve(undefined);
    const newsPromise = this.newsScout
      ? this.newsScout.scout({ symbol, news })
      : Promise.resolve(undefined);

    const strategistPromise = this.runStrategistSection(symbol, opts);

    const [base, ta, scout, strategist] = await Promise.all([
      this.analyst.brief({ symbol, quote, indicators, news }),
      technicalPromise,
      newsPromise,
      strategistPromise,
    ]);

    // Aggregate risk verdict for the briefing. Briefing-only calls do not
    // get a verdict; strategist calls always do.
    const riskVerdict: RiskReview | undefined = strategist
      ? aggregateRiskVerdict(strategist.candidates)
      : undefined;

    const sourcesUsed = collectSources({ ta, scout });

    const candidate: BriefingT = {
      ...base,
      disclaimer: base.disclaimer || DISCLAIMER,
      ...(ta ? { ta } : {}),
      ...(scout ? { newsScout: scout } : {}),
      ...(strategist ? { strategist } : {}),
      ...(riskVerdict ? { riskVerdict } : {}),
      sourcesUsed,
    };

    // Validate at the seam — every emitted briefing must conform.
    return Briefing.parse(candidate);
  }

  async proposePlans(input: {
    symbol: string;
    thesis: string;
    maxLossUsd: number;
    expiry?: string;
  }): Promise<PlansResponse> {
    const chain = await this.market.optionsChain(input.symbol, input.expiry);
    const plans = await this.strategist.propose({ ...input, chain });
    const reviewed = plans.map((plan: TradePlan) => ({
      plan,
      review: this.risk.review(plan),
    }));
    const noCompliantPlans =
      reviewed.length > 0 && reviewed.every((r) => !r.review.ok);
    return noCompliantPlans
      ? { plans: reviewed, noCompliantPlans: true }
      : { plans: reviewed };
  }

  private async runStrategistSection(
    symbol: string,
    opts: BriefingOptions,
  ): Promise<BriefingStrategist | undefined> {
    if (!opts.thesis || typeof opts.maxLossUsd !== 'number') return undefined;
    const chain = await this.market.optionsChain(symbol, opts.expiry);
    let plans;
    try {
      plans = await this.strategist.propose({
        symbol,
        thesis: opts.thesis,
        maxLossUsd: opts.maxLossUsd,
        chain,
      });
    } catch (err) {
      if (err instanceof AgentParseError) {
        // Surface the parse failure as a distinct signal on the briefing
        // instead of aborting the whole pipeline (issue #165).
        return {
          thesis: opts.thesis,
          candidates: [],
          noCompliantPlans: false,
          parseError: err.message,
        };
      }
      throw err;
    }
    const candidates: ReviewedTradePlan[] = plans.map((plan) => ({
      plan,
      review: this.risk.review(plan),
    }));
    const noCompliantPlans =
      candidates.length > 0 && candidates.every((c) => !c.review.ok);
    return {
      thesis: opts.thesis,
      candidates,
      noCompliantPlans,
    };
  }
}

function aggregateRiskVerdict(candidates: ReviewedTradePlan[]): RiskReview {
  if (candidates.length === 0) {
    return { ok: true, violations: [] };
  }
  const failing = candidates.filter((c) => !c.review.ok);
  if (failing.length === 0) return { ok: true, violations: [] };
  const violations = failing.flatMap((c) =>
    c.review.violations.map((v) => `${c.plan.name}: ${v}`),
  );
  return { ok: false, violations };
}

function collectSources(parts: {
  ta?: { sourcesUsed: string[] } | undefined;
  scout?: { sourcesUsed: string[] } | undefined;
}): string[] {
  const out = new Set<string>();
  for (const s of parts.ta?.sourcesUsed ?? []) out.add(s);
  for (const s of parts.scout?.sourcesUsed ?? []) out.add(s);
  return Array.from(out);
}
