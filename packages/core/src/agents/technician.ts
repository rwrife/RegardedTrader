import type { LLM } from './llm.js';
import { DISCLAIMER } from './llm.js';
import type { MarketDataClient } from '../clients/index.js';
import { computeIndicators } from '../indicators/index.js';
import {
  BriefingTechnical,
  TechnicianOutputSchema,
  type BriefingTechnical as BriefingTechnicalT,
  type Indicators,
  type OHLCV,
  type Quote,
  type TechnicianOutput,
} from '../schemas/index.js';
import { TechnicianPrompts } from '../prompts/index.js';

/**
 * Input shape for the orchestrator-facing `analyze` call (issue #74).
 *
 * The orchestrator already has quote + indicators in hand by the time it
 * calls the Technician, so we accept them directly to avoid duplicate I/O.
 * The standalone CLI / server entry points use `Technician.fromMarket`
 * instead, which fetches via the injected `MarketDataClient`.
 */
export interface TechnicianInput {
  symbol: string;
  quote: Quote;
  indicators: Indicators;
}

/**
 * `Technician` — TA-driven chart/indicator commentary agent (issue #74).
 *
 * Pure function over `quote + indicators`. Owns no I/O. The orchestrator
 * (or `Technician.fromMarket`) is responsible for fetching OHLCV history and
 * computing indicators via the existing `indicators` module — same pattern
 * as `Analyst`.
 */
export class Technician {
  constructor(private readonly llm: LLM) {}

  async analyze(input: TechnicianInput): Promise<BriefingTechnicalT> {
    const { symbol, indicators } = input;
    const user = TechnicianPrompts.buildUserPrompt(input);

    const raw = await this.llm.complete({
      system: TechnicianPrompts.SYSTEM_PROMPT,
      user,
      json: true,
    });
    const parsed = safeParse(raw);

    const candidate: BriefingTechnicalT = {
      trend: stringOrFallback(parsed.trend, fallbackTrend(indicators)),
      momentum: stringOrFallback(parsed.momentum, fallbackMomentum(indicators)),
      volatility: stringOrFallback(parsed.volatility, fallbackVolatility(indicators)),
      keyLevels: parsed.keyLevels ?? [],
      commentary: stringOrFallback(
        parsed.commentary,
        `Technical read for ${symbol} based on provided indicators. ${DISCLAIMER}`,
      ),
      sourcesUsed: ['indicators', 'quote'],
      disclaimer: DISCLAIMER,
    };

    // Validate at the seam. If the LLM produced something nonsensical the
    // fallbacks above ensure schema-required fields stay non-empty.
    return BriefingTechnical.parse(candidate);
  }

  /**
   * Convenience entry point for surfaces that only have a symbol (CLI `regard
   * tech`, server `GET /technician/:symbol`). Fetches OHLCV history via the
   * injected client, computes indicators, then delegates to `analyze`.
   */
  static async fromMarket(
    llm: LLM,
    market: MarketDataClient,
    symbol: string,
  ): Promise<BriefingTechnicalT> {
    const [quote, history] = await Promise.all([
      market.quote(symbol),
      market.history(symbol, 180),
    ]);
    const indicators = computeIndicators(history as OHLCV[]);
    return new Technician(llm).analyze({ symbol, quote, indicators });
  }
}

/**
 * Parse + Zod-validate the LLM JSON reply (issue #165). Malformed JSON,
 * wrong-typed fields, or non-object bodies collapse to an empty output
 * so the deterministic fallbacks below take over. Numeric filtering on
 * `keyLevels` happens inside the schema (only finite numbers survive).
 */
function safeParse(raw: string): TechnicianOutput {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  const result = TechnicianOutputSchema.safeParse(v);
  return result.success ? result.data : {};
}

function stringOrFallback(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback;
}

function fallbackTrend(i: Indicators): string {
  if (i.sma20 === null || i.sma50 === null) return 'Trend unavailable (insufficient history).';
  if (i.sma20 > i.sma50) return 'Short-term SMA above long-term SMA — bias upward.';
  if (i.sma20 < i.sma50) return 'Short-term SMA below long-term SMA — bias downward.';
  return 'Short and long SMAs converging — rangebound.';
}

function fallbackMomentum(i: Indicators): string {
  if (i.rsi14 === null) return 'Momentum unavailable (RSI not computed).';
  if (i.rsi14 >= 70) return `RSI ${i.rsi14.toFixed(1)} — overbought.`;
  if (i.rsi14 <= 30) return `RSI ${i.rsi14.toFixed(1)} — oversold.`;
  return `RSI ${i.rsi14.toFixed(1)} — neutral.`;
}

function fallbackVolatility(i: Indicators): string {
  if (i.atr14 === null) return 'Volatility unavailable (ATR not computed).';
  return `ATR(14) ≈ ${i.atr14.toFixed(2)}.`;
}
