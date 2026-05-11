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
