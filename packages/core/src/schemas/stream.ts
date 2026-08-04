import { z } from 'zod';

const Ticker = z.string().regex(/^[A-Z.\-]{1,10}$/);

export const StreamChannel = z.enum(['quote', 'chain', 'news']);
export type StreamChannel = z.infer<typeof StreamChannel>;

export const StreamSubscribeMessage = z.object({
  type: z.literal('sub'),
  channel: StreamChannel,
  symbol: Ticker,
});
export type StreamSubscribeMessage = z.infer<typeof StreamSubscribeMessage>;

export const StreamUnsubscribeMessage = z.object({
  type: z.literal('unsub'),
  channel: StreamChannel,
  symbol: Ticker,
});
export type StreamUnsubscribeMessage = z.infer<typeof StreamUnsubscribeMessage>;

export const StreamClientMessage = z.discriminatedUnion('type', [
  StreamSubscribeMessage,
  StreamUnsubscribeMessage,
]);
export type StreamClientMessage = z.infer<typeof StreamClientMessage>;

export const StreamReadyMessage = z.object({
  type: z.literal('ready'),
  channels: z.array(StreamChannel),
});
export type StreamReadyMessage = z.infer<typeof StreamReadyMessage>;

export const StreamAckMessage = z.object({
  type: z.enum(['subscribed', 'unsubscribed']),
  channel: StreamChannel,
  symbol: Ticker,
});
export type StreamAckMessage = z.infer<typeof StreamAckMessage>;

export const StreamErrorMessage = z.object({
  type: z.literal('error'),
  error: z.string().min(1),
});
export type StreamErrorMessage = z.infer<typeof StreamErrorMessage>;

export const StreamQuotePayload = z.object({
  symbol: Ticker,
  price: z.number(),
  change: z.number(),
  changePercent: z.number(),
  rsi: z.number().nullable(),
  asOf: z.string(),
});
export type StreamQuotePayload = z.infer<typeof StreamQuotePayload>;

export const StreamNewsPayload = z.object({
  symbol: Ticker,
  title: z.string(),
  url: z.string().url(),
  source: z.string(),
  publishedAt: z.string(),
});
export type StreamNewsPayload = z.infer<typeof StreamNewsPayload>;

export const StreamChainContract = z.object({
  symbol: z.string().min(1),
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
export type StreamChainContract = z.infer<typeof StreamChainContract>;

export const StreamChainPayload = z.object({
  symbol: Ticker,
  asOf: z.string(),
  contracts: z.array(StreamChainContract),
});
export type StreamChainPayload = z.infer<typeof StreamChainPayload>;

export const StreamQuoteMessage = z.object({
  type: z.literal('quote'),
  channel: z.literal('quote'),
  symbol: Ticker,
  data: StreamQuotePayload,
});
export type StreamQuoteMessage = z.infer<typeof StreamQuoteMessage>;

export const StreamNewsMessage = z.object({
  type: z.literal('news'),
  channel: z.literal('news'),
  symbol: Ticker,
  data: StreamNewsPayload,
});
export type StreamNewsMessage = z.infer<typeof StreamNewsMessage>;

export const StreamChainMessage = z.object({
  type: z.literal('chain'),
  channel: z.literal('chain'),
  symbol: Ticker,
  data: StreamChainPayload,
});
export type StreamChainMessage = z.infer<typeof StreamChainMessage>;

export const StreamServerMessage = z.discriminatedUnion('type', [
  StreamReadyMessage,
  StreamAckMessage,
  StreamErrorMessage,
  StreamQuoteMessage,
  StreamNewsMessage,
  StreamChainMessage,
]);
export type StreamServerMessage = z.infer<typeof StreamServerMessage>;
