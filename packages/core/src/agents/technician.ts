import type { LLM } from './llm.js';
import { DISCLAIMER } from './llm.js';
import type { MarketDataClient } from '../clients/index.js';
import { computeIndicators } from '../indicators/index.js';
import {
  BriefingTechnical,
  type BriefingTechnical as BriefingTechnicalT,
  type Indicators,
  type OHLCV,
  type Quote,
} from '../schemas/index.js';

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

const SYSTEM = `You are a technical analyst. You read price/indicator data and
produce a concise, plain-English chart read. You ONLY use the numbers the user
provides — never invent price levels, news, or earnings dates. You never
recommend specific trades. Output strict JSON matching the schema requested.`;

interface LLMReply {
  trend?: unknown;
  momentum?: unknown;
  volatility?: unknown;
  keyLevels?: unknown;
  commentary?: unknown;
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
    const { symbol, quote, indicators } = input;
    const user = `Produce a JSON object with keys:
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

    const raw = await this.llm.complete({ system: SYSTEM, user, json: true });
    const parsed = safeParse(raw);

    const candidate: BriefingTechnicalT = {
      trend: stringOrFallback(parsed.trend, fallbackTrend(indicators)),
      momentum: stringOrFallback(parsed.momentum, fallbackMomentum(indicators)),
      volatility: stringOrFallback(parsed.volatility, fallbackVolatility(indicators)),
      keyLevels: numericArray(parsed.keyLevels),
      commentary: stringOrFallback(
        parsed.commentary,
        `Technical read for ${symbol} based on provided indicators. ${DISCLAIMER}`,
      ),
      sourcesUsed: ['indicators', 'quote'],
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

function safeParse(raw: string): LLMReply {
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as LLMReply) : {};
  } catch {
    return {};
  }
}

function stringOrFallback(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback;
}

function numericArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
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
