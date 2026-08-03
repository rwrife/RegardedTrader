import type { MarketDataClient } from '../clients/index.js';
import type { PaperFill, PaperOrder, PaperPosition, TradePlan } from '../schemas/index.js';
import { PaperFill as PaperFillSchema, PaperOrder as PaperOrderSchema, PaperPosition as PaperPositionSchema, Ticker } from '../schemas/index.js';
import { PaperStore } from './store.js';

export interface SubmitOrderInput {
  mode: 'paper' | 'live';
  planId: string;
  plan: TradePlan;
}

export interface PaperBrokerOptions {
  market: MarketDataClient;
  store: PaperStore;
  now?: () => Date;
}

export class PaperBroker {
  private readonly market: MarketDataClient;
  private readonly store: PaperStore;
  private readonly now: () => Date;

  constructor(opts: PaperBrokerOptions) {
    this.market = opts.market;
    this.store = opts.store;
    this.now = opts.now ?? (() => new Date());
  }

  async submit(input: SubmitOrderInput): Promise<PaperFill> {
    if (input.mode !== 'paper') {
      throw new Error('PaperBroker refuses non-paper mode. Re-run with mode="paper".');
    }
    const plan = input.plan;
    const firstLeg = plan.legs[0];
    if (!firstLeg) throw new Error('Trade plan has no legs.');
    const symbol = Ticker.parse(firstLeg.contract.underlying);
    const quote = await this.market.quote(symbol);
    const at = this.now().toISOString();
    const orderId = `po_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const legFills = plan.legs.map((leg) => {
      const mark = pickMark(leg.contract.bid, leg.contract.ask, leg.contract.last);
      return {
        contractSymbol: leg.contract.symbol,
        action: leg.action,
        qty: leg.qty,
        mark,
      };
    });

    const netPremiumUsd = round2(plan.legs.reduce((acc, leg) => {
      const mark = pickMark(leg.contract.bid, leg.contract.ask, leg.contract.last);
      const signed = leg.action === 'buy' ? mark : -mark;
      return acc + signed * leg.qty * 100;
    }, 0));

    const order = PaperOrderSchema.parse({
      id: orderId,
      planId: input.planId,
      symbol,
      mode: 'paper',
      submittedAt: at,
      plan,
      notes: 'PAPER — simulated, no real orders.',
    } satisfies PaperOrder);

    const fill = PaperFillSchema.parse({
      id: `pf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      orderId,
      planId: input.planId,
      symbol,
      filledAt: at,
      underlyingPrice: quote.price,
      legFills,
      netPremiumUsd,
      estimatedMaxLossUsd: plan.maxLoss,
      estimatedMaxGainUsd: plan.maxGain,
      notes: 'PAPER — simulated fill only.',
    } satisfies PaperFill);

    const position = PaperPositionSchema.parse({
      id: `pp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      planId: input.planId,
      symbol,
      openedAt: at,
      netPremiumUsd,
      maxLossUsd: plan.maxLoss,
      maxGainUsd: plan.maxGain,
      status: 'open',
      notes: 'PAPER position (simulated).',
    } satisfies PaperPosition);

    await this.store.append(order, position);
    return fill;
  }
}

function pickMark(
  bid: number | null | undefined,
  ask: number | null | undefined,
  last: number | null | undefined,
): number {
  if (typeof bid === 'number' && typeof ask === 'number') return (bid + ask) / 2;
  if (typeof last === 'number') return last;
  if (typeof bid === 'number') return bid;
  if (typeof ask === 'number') return ask;
  return 0;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
