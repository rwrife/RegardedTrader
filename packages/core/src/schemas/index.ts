import { z } from 'zod';

export const Ticker = z.string().regex(/^[A-Z.\-]{1,10}$/);
export type Ticker = z.infer<typeof Ticker>;

export const Quote = z.object({
  symbol: Ticker,
  price: z.number(),
  change: z.number(),
  changePercent: z.number(),
  volume: z.number().int().nonnegative(),
  marketCap: z.number().optional(),
  asOf: z.string(), // ISO
});
export type Quote = z.infer<typeof Quote>;

/**
 * Live ticker quote (issue #81). Distinct from the heavier `Quote` schema
 * above: this is the minimal payload used by the `/api/tickers/:symbol/quote`
 * endpoint and the `useLiveQuote` web hook. `marketState` mirrors
 * yahoo-finance2's upstream values (`REGULAR`, `PRE`, `POST`, `CLOSED`,
 * `PREPRE`, `POSTPOST`).
 */
export const QuoteSchema = z.object({
  symbol: Ticker,
  price: z.number(),
  change: z.number(),
  changePercent: z.number(),
  currency: z.string().min(1),
  marketState: z.enum(['REGULAR', 'PRE', 'POST', 'CLOSED', 'PREPRE', 'POSTPOST']),
  asOf: z.string(), // ISO
  /**
   * Conviction rating (#82). Computed deterministically from the same quote
   * payload (`changePercent` + `volumeRatio` derived from
   * `regularMarketVolume / averageDailyVolume10Day`). Optional so the field
   * can be omitted when upstream data is too thin to be meaningful.
   */
  rating: z
    .object({
      symbol: Ticker,
      rating: z.enum(['SELL', 'HOLD', 'BUY', 'YOLO']),
      score: z.number().min(0).max(100),
      reasons: z.array(z.string()),
      asOf: z.string(),
    })
    .optional(),
});
export type LiveQuote = z.infer<typeof QuoteSchema>;

export const OHLCV = z.object({
  t: z.string(), // ISO date
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number().int().nonnegative(),
});
export type OHLCV = z.infer<typeof OHLCV>;

export const Indicators = z.object({
  rsi14: z.number().nullable(),
  sma20: z.number().nullable(),
  sma50: z.number().nullable(),
  ema12: z.number().nullable(),
  ema26: z.number().nullable(),
  macd: z.number().nullable(),
  macdSignal: z.number().nullable(),
  atr14: z.number().nullable(),
});
export type Indicators = z.infer<typeof Indicators>;

export const NewsItem = z.object({
  title: z.string(),
  url: z.string().url(),
  source: z.string(),
  publishedAt: z.string(),
  summary: z.string().optional(),
});
export type NewsItem = z.infer<typeof NewsItem>;

export const OptionContract = z.object({
  symbol: z.string(),
  underlying: Ticker,
  expiry: z.string(),
  strike: z.number(),
  type: z.enum(['call', 'put']),
  bid: z.number().nullable(),
  ask: z.number().nullable(),
  last: z.number().nullable(),
  volume: z.number().int().nonnegative().nullable(),
  openInterest: z.number().int().nonnegative().nullable(),
  iv: z.number().nullable(),
  delta: z.number().nullable().optional(),
  gamma: z.number().nullable().optional(),
  theta: z.number().nullable().optional(),
  vega: z.number().nullable().optional(),
});
export type OptionContract = z.infer<typeof OptionContract>;

export const TradePlanLeg = z.object({
  action: z.enum(['buy', 'sell']),
  qty: z.number().int().positive(),
  contract: OptionContract,
});
export const TradePlan = z.object({
  name: z.string(),
  thesis: z.string(),
  legs: z.array(TradePlanLeg),
  maxLoss: z.number(),
  maxGain: z.number().nullable(), // null = unbounded
  breakEvens: z.array(z.number()),
  notes: z.string().optional(),
});
export type TradePlan = z.infer<typeof TradePlan>;

export const TickerProfile = z.object({
  symbol: Ticker,
  name: z.string().min(1),
  exchange: z.string().min(1),
  sector: z.string().min(1),
  industry: z.string().min(1),
  description: z.string().min(1),
  sources: z.array(z.string().url()).min(1),
  validatedAt: z.string(), // ISO
});
export type TickerProfile = z.infer<typeof TickerProfile>;

/** What the LLM is asked to return; sources are added by the agent. */
export const TickerProfileExtraction = z.object({
  symbol: z.string().min(1).max(10),
  name: z.string().min(1),
  exchange: z.string().min(1),
  sector: z.string().min(1),
  industry: z.string().min(1),
  description: z.string().min(1),
});
export type TickerProfileExtraction = z.infer<typeof TickerProfileExtraction>;

export const TickerSuggestion = z.object({
  symbol: z.string(),
  name: z.string().optional(),
  reason: z.string().optional(),
});
export type TickerSuggestion = z.infer<typeof TickerSuggestion>;

export const WatchlistEntry = z.object({
  profile: TickerProfile,
  addedAt: z.string(), // ISO
});
export type WatchlistEntry = z.infer<typeof WatchlistEntry>;

export const ValidationOk = z.object({
  ok: z.literal(true),
  profile: TickerProfile,
  cached: z.boolean().default(false),
});
export const ValidationErr = z.object({
  ok: z.literal(false),
  symbol: z.string(),
  error: z.string(),
  suggestions: z.array(TickerSuggestion).default([]),
});
export const ValidationResult = z.discriminatedUnion('ok', [ValidationOk, ValidationErr]);
export type ValidationResult = z.infer<typeof ValidationResult>;

export const Briefing = z.object({
  symbol: Ticker,
  asOf: z.string(),
  quote: Quote,
  indicators: Indicators,
  bullCase: z.string(),
  bearCase: z.string(),
  catalysts: z.array(z.string()),
  risks: z.array(z.string()),
  news: z.array(NewsItem),
  disclaimer: z.string(),
});
export type Briefing = z.infer<typeof Briefing>;
