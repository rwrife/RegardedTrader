/**
 * Hacker News (Algolia) mentions poller (#34, parent #30).
 *
 * For a given symbol, queries the public HN Algolia search endpoint:
 *
 *   https://hn.algolia.com/api/v1/search
 *     ?query=$SYMBOL OR "NAME"
 *     &tags=story
 *     &numericFilters=created_at_i>{cutoff}
 *
 * Each returned story is mapped onto a `MentionItem`:
 *  - `source`      — always `'hn'`.
 *  - `sourceId`    — the HN story id (`objectID`, prefixed with `hn_` for
 *    symmetry with the reddit poller's `t3_`/`t1_` prefixes).
 *  - `text`        — the story title concatenated with `story_text` (when
 *    the poster included a self-text body).
 *  - `title`       — the story title (kept separately so scorers can weight
 *    it independently of the body).
 *  - `url`         — the story `url` if present, else the HN item URL.
 *  - `publishedAt` — derived from `created_at_i` (unix seconds).
 *  - `fetchedAt`   — wall-clock when the poll ran.
 *
 * **Privacy**: authors / usernames are never persisted (the `MentionItem`
 * schema has no field for them, and the store's `appendMention` strips
 * unknown keys).
 *
 * On each tick the poller looks back 24h by default. Duplicate stories
 * across ticks are handled by the store's `(source, sourceId)` dedup, so
 * this poller does not maintain its own in-process cursor.
 *
 * The poller is intentionally framework-free: callers inject a `fetch`
 * implementation, a clock, and the `MentionStore`. No network, no disk,
 * and no logger lives inside this module — mirroring the other jobs in
 * `core/src/polling/jobs/`.
 */

import { z } from 'zod';
import { Ticker } from '../../schemas/index.js';
import { MentionItem } from '../../schemas/sentiment.js';
import type { MentionStore } from '../mention-store.js';

/* -------------------------------------------------------------------------- */
/* Constants & URL builder                                                     */
/* -------------------------------------------------------------------------- */

/** Default lookback window when building the `numericFilters` cutoff. */
export const HN_DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Default `hitsPerPage` requested from Algolia. Their hard cap is 1000. */
export const HN_DEFAULT_HITS_PER_PAGE = 50;

/** Identified UA — Algolia's frontends are tolerant but be a good citizen. */
export const HN_USER_AGENT = 'RegardedTrader/0.1 (+local; sentiment poller)';

/** Base Algolia HN search endpoint. */
export const HN_SEARCH_BASE_URL = 'https://hn.algolia.com/api/v1/search';

/** Base URL for building an item permalink when a story has no external url. */
export const HN_ITEM_BASE_URL = 'https://news.ycombinator.com/item?id=';

/**
 * Build the HN Algolia search URL for a ticker.
 *
 * The `query` uses HN Algolia's `A OR B` operator: `$SYMBOL OR "NAME"`.
 * The company name is quoted so multi-word names are treated as a phrase.
 * When no name is supplied only the `$SYMBOL` clause is used.
 *
 * `cutoffEpochSeconds` is emitted as `numericFilters=created_at_i>{n}` so
 * only stories newer than the cutoff come back.
 */
export function hnSearchUrl(
  symbol: string,
  name: string | undefined,
  cutoffEpochSeconds: number,
  hitsPerPage: number = HN_DEFAULT_HITS_PER_PAGE,
): string {
  const sym = symbol.toUpperCase();
  const trimmedName = name?.trim();
  const query = trimmedName
    ? `$${sym} OR "${trimmedName.replace(/"/g, '')}"`
    : `$${sym}`;
  const cutoff = Math.max(0, Math.floor(cutoffEpochSeconds));
  const params = new URLSearchParams({
    query,
    tags: 'story',
    numericFilters: `created_at_i>${cutoff}`,
    hitsPerPage: String(hitsPerPage),
  });
  return `${HN_SEARCH_BASE_URL}?${params.toString()}`;
}

/** Convenience: build a permalink to an HN story from its `objectID`. */
export function hnItemUrl(objectId: string): string {
  return `${HN_ITEM_BASE_URL}${encodeURIComponent(objectId)}`;
}

/* -------------------------------------------------------------------------- */
/* Response shape                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Subset of an HN Algolia hit we read. Unknown fields are tolerated; only
 * the documented shape is validated.
 */
const HnAlgoliaHit = z.object({
  objectID: z.string().min(1),
  title: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  story_text: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  created_at_i: z.number().nullable().optional(),
});
type HnAlgoliaHit = z.infer<typeof HnAlgoliaHit>;

const HnAlgoliaResponse = z.object({
  hits: z.array(z.unknown()).default([]),
});

/* -------------------------------------------------------------------------- */
/* Parser                                                                      */
/* -------------------------------------------------------------------------- */

function epochToIso(epoch: number | null | undefined): string | undefined {
  if (typeof epoch !== 'number' || !isFinite(epoch) || epoch <= 0) return undefined;
  return new Date(epoch * 1000).toISOString();
}

function isoOrEpoch(
  createdAt: string | null | undefined,
  createdAtI: number | null | undefined,
): string | undefined {
  if (typeof createdAt === 'string') {
    const t = Date.parse(createdAt);
    if (!isNaN(t)) return new Date(t).toISOString();
  }
  return epochToIso(createdAtI);
}

function isHttpUrl(u: string | null | undefined): u is string {
  if (typeof u !== 'string') return false;
  return /^https?:\/\//i.test(u);
}

/**
 * Parse a raw HN Algolia response into validated `MentionItem`s for
 * `symbol`. Drops hits without a usable text body (no title AND no
 * `story_text`) or without a valid timestamp. Pure: no I/O, safe to
 * unit-test against recorded fixtures.
 */
export function parseHnMentions(
  raw: unknown,
  symbol: string,
  now: Date = new Date(),
): MentionItem[] {
  const parsed = HnAlgoliaResponse.safeParse(raw);
  if (!parsed.success) return [];
  const sym = symbol.toUpperCase();
  const fetchedAt = now.toISOString();
  const out: MentionItem[] = [];
  for (const rawHit of parsed.data.hits) {
    const hitParsed = HnAlgoliaHit.safeParse(rawHit);
    if (!hitParsed.success) continue;
    const hit = hitParsed.data;
    const title = hit.title?.trim() ?? '';
    const body = hit.story_text?.trim() ?? '';
    const text = [title, body].filter(Boolean).join('\n\n').trim();
    if (!text) continue;
    const publishedAt = isoOrEpoch(hit.created_at, hit.created_at_i);
    if (!publishedAt) continue;
    const url = isHttpUrl(hit.url) ? hit.url : hnItemUrl(hit.objectID);
    const candidate: MentionItem = {
      source: 'hn',
      sourceId: `hn_${hit.objectID}`,
      symbol: sym,
      text,
      publishedAt,
      fetchedAt,
      ...(title ? { title } : {}),
      url,
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

export interface PollHnOptions {
  readonly symbol: string;
  readonly store: MentionStore;
  /**
   * Optional company name to add to the OR clause of the search query.
   * Callers typically pass the `TickerProfile.name`.
   */
  readonly name?: string;
  /** Lookback window in ms. Defaults to {@link HN_DEFAULT_LOOKBACK_MS}. */
  readonly lookbackMs?: number;
  /** Override `hitsPerPage`. Algolia hard-caps at 1000. */
  readonly hitsPerPage?: number;
  /** Injectable fetch (defaults to global `fetch`). */
  readonly fetchImpl?: typeof fetch;
  /** Optional event sink for `mention.new`. */
  readonly onEvent?: (e: MentionNewEvent) => void;
  /** Injectable clock for `fetchedAt` + cutoff derivation (tests). */
  readonly now?: () => Date;
  /** Error hook for diagnostics; never thrown. */
  readonly onError?: (err: unknown) => void;
}

export interface PollHnResult {
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
        'User-Agent': HN_USER_AGENT,
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
 * Poll Hacker News (Algolia) for stories mentioning `symbol` (and
 * optionally the company `name`) in the last {@link HN_DEFAULT_LOOKBACK_MS}
 * window. Persists freshly seen mentions via the injected `MentionStore`
 * and emits `mention.new` events for each insert. Dedup is handled by the
 * store on `(source, sourceId)`.
 *
 * Fetch / parse failures are reported via `onError` and surfaced on the
 * returned result; they never throw.
 */
export async function pollHnMentions(opts: PollHnOptions): Promise<PollHnResult> {
  const sym = Ticker.parse(opts.symbol.toUpperCase());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const lookbackMs = opts.lookbackMs ?? HN_DEFAULT_LOOKBACK_MS;
  const hitsPerPage = opts.hitsPerPage ?? HN_DEFAULT_HITS_PER_PAGE;

  const runAt = now();
  const cutoffEpoch = Math.floor((runAt.getTime() - lookbackMs) / 1000);
  const url = hnSearchUrl(sym, opts.name, cutoffEpoch, hitsPerPage);

  const r = await safeFetchJson(fetchImpl, url);
  if (!r.ok) {
    opts.onError?.(new Error(r.error));
    return { fetched: 0, inserted: 0, error: r.error };
  }

  let items: MentionItem[];
  try {
    items = parseHnMentions(r.body, sym, runAt);
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
