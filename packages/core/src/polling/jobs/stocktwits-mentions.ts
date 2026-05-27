/**
 * StockTwits mentions poller (#33, parent #30).
 *
 * For a given symbol, fetches the latest messages from the public
 * StockTwits "stream by symbol" endpoint:
 *
 *   https://api.stocktwits.com/api/2/streams/symbol/$SYMBOL.json?limit=30
 *
 * Each message is mapped onto a `MentionItem`:
 *  - `source`        — always `'stocktwits'`.
 *  - `sourceId`      — the StockTwits message id (stringified).
 *  - `text`          — the message body, trimmed.
 *  - `publishedAt`   — `created_at` from the API.
 *  - `fetchedAt`     — wall-clock when the poll ran.
 *  - `meta.sentimentLabel` — populated when the message has a self-declared
 *    `entities.sentiment.basic` of `Bullish` or `Bearish` (mapped to the
 *    `bullish` / `bearish` `SentimentLabel`). The AI scorer can use this
 *    as a prior.
 *
 * **Privacy**: authors / usernames are never persisted (the `MentionItem`
 * schema has no field for them, and the store's `appendMention` strips
 * unknown keys).
 *
 * The poller is intentionally framework-free: callers inject a `fetch`
 * implementation, a clock, and the `MentionStore`. No network, no disk,
 * and no logger lives inside this module — mirroring the other jobs in
 * `core/src/polling/jobs/`.
 */

import { z } from 'zod';
import { Ticker } from '../../schemas/index.js';
import { MentionItem, SentimentLabel } from '../../schemas/sentiment.js';
import type { MentionStore } from '../mention-store.js';

/* -------------------------------------------------------------------------- */
/* URL builder                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Default page size matches the issue spec (#33). StockTwits caps `limit`
 * at 30 for the unauthenticated streams endpoint.
 */
export const STOCKTWITS_DEFAULT_LIMIT = 30;

export function stocktwitsStreamUrl(
  symbol: string,
  limit: number = STOCKTWITS_DEFAULT_LIMIT,
): string {
  const sym = encodeURIComponent(symbol.toUpperCase());
  return `https://api.stocktwits.com/api/2/streams/symbol/${sym}.json?limit=${limit}`;
}

/* -------------------------------------------------------------------------- */
/* Response shape                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Subset of the StockTwits `streams/symbol/$SYM` response we read. Unknown
 * fields are tolerated; only the documented shape is validated.
 */
const StocktwitsMessage = z.object({
  id: z.union([z.number(), z.string()]),
  body: z.string().optional(),
  created_at: z.string().optional(),
  entities: z
    .object({
      sentiment: z
        .object({
          basic: z.string().optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
});
type StocktwitsMessage = z.infer<typeof StocktwitsMessage>;

const StocktwitsResponse = z.object({
  messages: z.array(StocktwitsMessage).default([]),
});

/* -------------------------------------------------------------------------- */
/* Parser                                                                      */
/* -------------------------------------------------------------------------- */

/** Map the StockTwits self-declared label to our `SentimentLabel` enum. */
function mapBasicLabel(raw: string | undefined): SentimentLabel | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'bullish') return 'bullish';
  if (v === 'bearish') return 'bearish';
  return undefined;
}

function toIso(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  if (isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

/**
 * Parse a raw StockTwits response into validated `MentionItem`s for `symbol`.
 * Drops messages without a non-empty body or without a valid timestamp.
 * Pure: no I/O, safe to unit-test against recorded fixtures.
 */
export function parseStocktwitsMentions(
  raw: unknown,
  symbol: string,
  now: Date = new Date(),
): MentionItem[] {
  const parsed = StocktwitsResponse.safeParse(raw);
  if (!parsed.success) return [];
  const sym = symbol.toUpperCase();
  const fetchedAt = now.toISOString();
  const out: MentionItem[] = [];
  for (const m of parsed.data.messages) {
    const body = m.body?.trim();
    if (!body) continue;
    const publishedAt = toIso(m.created_at);
    if (!publishedAt) continue;
    const sentimentLabel = mapBasicLabel(m.entities?.sentiment?.basic);
    const candidate: MentionItem = {
      source: 'stocktwits',
      sourceId: String(m.id),
      symbol: sym,
      text: body,
      publishedAt,
      fetchedAt,
      ...(sentimentLabel !== undefined ? { meta: { sentimentLabel } } : {}),
    };
    const safe = MentionItem.safeParse(candidate);
    if (safe.success) out.push(safe.data);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Poller                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Event payload emitted via `onEvent` for each newly persisted mention.
 * Mirrors the channel name documented in the parent epic (#19, #30).
 */
export interface MentionNewEvent {
  readonly type: 'mention.new';
  readonly symbol: string;
  readonly item: MentionItem;
}

export interface PollStocktwitsOptions {
  readonly symbol: string;
  readonly store: MentionStore;
  /** Injectable fetch (defaults to global `fetch`). */
  readonly fetchImpl?: typeof fetch;
  /** Optional event sink for `mention.new`. */
  readonly onEvent?: (e: MentionNewEvent) => void;
  /** Injectable clock for `fetchedAt` in tests. */
  readonly now?: () => Date;
  /** Error hook for diagnostics; never thrown. */
  readonly onError?: (err: unknown) => void;
  /** Override page size (capped at 30 by the upstream API). */
  readonly limit?: number;
}

export interface PollStocktwitsResult {
  readonly fetched: number;
  readonly inserted: number;
  readonly error?: string;
}

async function safeFetchJson(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(url, {
      headers: {
        // StockTwits accepts the default UA but some upstream caches reject
        // generic ones — mirror the news poller's identification line.
        'User-Agent': 'RegardedTrader/0.1 (+local)',
        Accept: 'application/json',
      },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: (e as Error).message ?? 'invalid json' };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message ?? 'fetch failed' };
  }
}

/**
 * Poll StockTwits for `symbol`, persist freshly seen mentions via the
 * injected `MentionStore`, and emit `mention.new` events for each insert.
 * Dedup is handled by the store on `(source, sourceId)`.
 *
 * Fetch / parse failures are reported via `onError` and surfaced on the
 * returned result; they never throw.
 */
export async function pollStocktwitsMentions(
  opts: PollStocktwitsOptions,
): Promise<PollStocktwitsResult> {
  const sym = Ticker.parse(opts.symbol.toUpperCase());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const limit = opts.limit ?? STOCKTWITS_DEFAULT_LIMIT;

  const url = stocktwitsStreamUrl(sym, limit);
  const r = await safeFetchJson(fetchImpl, url);
  if (!r.ok) {
    opts.onError?.(new Error(r.error));
    return { fetched: 0, inserted: 0, error: r.error };
  }

  let items: MentionItem[];
  try {
    items = parseStocktwitsMentions(r.body, sym, now());
  } catch (e) {
    const msg = (e as Error).message ?? 'parse failed';
    opts.onError?.(e);
    return { fetched: 0, inserted: 0, error: msg };
  }

  let inserted = 0;
  for (const item of items) {
    const written = await opts.store.appendMention(item);
    if (written !== null) {
      inserted += 1;
      opts.onEvent?.({ type: 'mention.new', symbol: sym, item: written });
    }
  }
  return { fetched: items.length, inserted };
}
