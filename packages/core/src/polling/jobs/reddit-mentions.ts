/**
 * Reddit mentions poller (#32, parent #30).
 *
 * For a given symbol, polls a curated list of subreddits via the public
 * `search.json` endpoint:
 *
 *   https://www.reddit.com/r/<sub>/search.json
 *     ?q=$SYMBOL&restrict_sr=1&sort=new&limit=50
 *
 * For each returned post we additionally fetch up to `commentLimit`
 * depth-1 (top-level) comments via the `/comments/<id>.json` endpoint and
 * map both posts and comments onto `MentionItem`. Authors and usernames
 * are *never* persisted — the `MentionItem` schema has no field for them
 * and the store strips unknown keys (see `core/src/schemas/sentiment.ts`).
 *
 * On top of the curated sub list the poller also probes whether an
 * `r/$SYMBOL` subreddit exists (e.g. `r/NVDA`). The probe result is
 * cached in-process for 7 days to avoid hammering the about endpoint.
 *
 * **Politeness**:
 *  - Identified `User-Agent` (Reddit rejects generic ones).
 *  - A 1 req / 2s / IP floor enforced across every request issued by the
 *    poller instance (shared rate limiter, injectable for tests).
 *  - Honours `Retry-After` on `HTTP 429` via the shared `BackoffPolicy`.
 *  - Single-flight per `(symbol, sub)`: concurrent calls with the same
 *    pair are coalesced so we never issue duplicate requests in flight.
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
import { BackoffPolicy, type BackoffOptions } from '../backoff.js';

/* -------------------------------------------------------------------------- */
/* Constants & URL builders                                                    */
/* -------------------------------------------------------------------------- */

export const REDDIT_DEFAULT_LIMIT = 50;
export const REDDIT_DEFAULT_COMMENT_LIMIT = 5;
export const REDDIT_USER_AGENT = 'RegardedTrader/0.1 (+local; sentiment poller)';

/** Minimum gap (ms) between consecutive requests from one poller instance. */
export const REDDIT_MIN_REQUEST_GAP_MS = 2_000;

/** TTL (ms) for the `r/$SYMBOL` existence probe cache. 7 days, per spec. */
export const REDDIT_SUBREDDIT_PROBE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Curated list of subs to poll for every watchlist symbol. Order matters
 * only for determinism in tests; the poller treats them as a set.
 */
export const REDDIT_DEFAULT_SUBREDDITS: readonly string[] = Object.freeze([
  'wallstreetbets',
  'stocks',
  'options',
  'investing',
  'StockMarket',
  'Daytrading',
]);

export function redditSearchUrl(
  sub: string,
  symbol: string,
  limit: number = REDDIT_DEFAULT_LIMIT,
): string {
  const cleanSub = sub.replace(/^\/?r\//i, '').replace(/^\/+|\/+$/g, '');
  const sym = symbol.toUpperCase();
  const params = new URLSearchParams({
    q: `$${sym}`,
    restrict_sr: '1',
    sort: 'new',
    limit: String(limit),
  });
  return `https://www.reddit.com/r/${cleanSub}/search.json?${params.toString()}`;
}

export function redditCommentsUrl(sub: string, postId: string): string {
  const cleanSub = sub.replace(/^\/?r\//i, '').replace(/^\/+|\/+$/g, '');
  return `https://www.reddit.com/r/${cleanSub}/comments/${postId}.json`;
}

export function redditSubredditAboutUrl(sub: string): string {
  const cleanSub = sub.replace(/^\/?r\//i, '').replace(/^\/+|\/+$/g, '');
  return `https://www.reddit.com/r/${cleanSub}/about.json`;
}

/* -------------------------------------------------------------------------- */
/* Response shapes                                                             */
/* -------------------------------------------------------------------------- */

const RedditListingChild = z.object({
  kind: z.string().optional(),
  data: z
    .object({
      id: z.string().optional(),
      title: z.string().optional(),
      selftext: z.string().optional(),
      body: z.string().optional(),
      permalink: z.string().optional(),
      url: z.string().optional(),
      created_utc: z.number().optional(),
      subreddit: z.string().optional(),
    })
    .partial(),
});
type RedditListingChild = z.infer<typeof RedditListingChild>;

const RedditListing = z.object({
  kind: z.literal('Listing').optional(),
  data: z.object({
    children: z.array(RedditListingChild).default([]),
  }),
});

/** `/comments/<id>.json` returns `[postListing, commentListing]`. */
const RedditCommentsResponse = z.tuple([RedditListing, RedditListing]);

const RedditAboutResponse = z.object({
  kind: z.string().optional(),
  data: z
    .object({
      display_name: z.string().optional(),
      subscribers: z.number().optional(),
    })
    .partial()
    .optional(),
});

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

function redditUrl(permalink: string | undefined): string | undefined {
  if (!permalink) return undefined;
  const p = permalink.startsWith('/') ? permalink : `/${permalink}`;
  return `https://www.reddit.com${p}`;
}

function epochToIso(epoch: number | undefined): string | undefined {
  if (typeof epoch !== 'number' || !isFinite(epoch) || epoch <= 0) return undefined;
  return new Date(epoch * 1000).toISOString();
}

/**
 * Parse a Reddit `search.json` response into validated `MentionItem`s.
 * Drops entries without a usable text body or timestamp. Pure: no I/O.
 */
export function parseRedditPostListing(
  raw: unknown,
  symbol: string,
  now: Date = new Date(),
): MentionItem[] {
  const parsed = RedditListing.safeParse(raw);
  if (!parsed.success) return [];
  const sym = symbol.toUpperCase();
  const fetchedAt = now.toISOString();
  const out: MentionItem[] = [];
  for (const child of parsed.data.data.children) {
    const d = child.data;
    if (!d.id) continue;
    const title = d.title?.trim();
    const body = d.selftext?.trim();
    const text = [title, body].filter(Boolean).join('\n\n').trim();
    if (!text) continue;
    const publishedAt = epochToIso(d.created_utc);
    if (!publishedAt) continue;
    const url = redditUrl(d.permalink);
    const candidate: MentionItem = {
      source: 'reddit',
      sourceId: `t3_${d.id}`,
      symbol: sym,
      text,
      publishedAt,
      fetchedAt,
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
    };
    const safe = MentionItem.safeParse(candidate);
    if (safe.success) out.push(safe.data);
  }
  return out;
}

/**
 * Parse the comment side of `/comments/<id>.json` (tuple element 1) into
 * `MentionItem`s. Only depth-1 (top-level) comments are considered;
 * Reddit's nested `replies` field is ignored by design. Pure: no I/O.
 */
export function parseRedditCommentsListing(
  raw: unknown,
  symbol: string,
  now: Date = new Date(),
  limit: number = REDDIT_DEFAULT_COMMENT_LIMIT,
): MentionItem[] {
  // Accept either the full tuple or just the comments listing.
  let listing: unknown = raw;
  const tuple = RedditCommentsResponse.safeParse(raw);
  if (tuple.success) listing = tuple.data[1];

  const parsed = RedditListing.safeParse(listing);
  if (!parsed.success) return [];
  const sym = symbol.toUpperCase();
  const fetchedAt = now.toISOString();
  const out: MentionItem[] = [];
  for (const child of parsed.data.data.children) {
    if (out.length >= limit) break;
    if (child.kind && child.kind !== 't1') continue;
    const d = child.data;
    if (!d.id) continue;
    const body = d.body?.trim();
    if (!body) continue;
    // Reddit posts "more" placeholders with no body — those are filtered above.
    const publishedAt = epochToIso(d.created_utc);
    if (!publishedAt) continue;
    const url = redditUrl(d.permalink);
    const candidate: MentionItem = {
      source: 'reddit',
      sourceId: `t1_${d.id}`,
      symbol: sym,
      text: body,
      publishedAt,
      fetchedAt,
      ...(url ? { url } : {}),
    };
    const safe = MentionItem.safeParse(candidate);
    if (safe.success) out.push(safe.data);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Rate limiter (1 req / 2s, shared per poller instance)                       */
/* -------------------------------------------------------------------------- */

export interface RateLimiter {
  /** Resolves once the caller is permitted to issue its request. */
  acquire(): Promise<void>;
}

export function createRedditRateLimiter(
  minGapMs: number = REDDIT_MIN_REQUEST_GAP_MS,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): RateLimiter {
  let nextSlot = 0;
  return {
    async acquire(): Promise<void> {
      const t = now();
      const wait = nextSlot - t;
      if (wait > 0) {
        await sleep(wait);
        nextSlot = nextSlot + minGapMs;
      } else {
        nextSlot = t + minGapMs;
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Subreddit probe cache                                                       */
/* -------------------------------------------------------------------------- */

export interface SubredditProbeCache {
  get(sub: string): boolean | undefined;
  set(sub: string, exists: boolean): void;
}

export function createSubredditProbeCache(
  ttlMs: number = REDDIT_SUBREDDIT_PROBE_TTL_MS,
  now: () => number = Date.now,
): SubredditProbeCache {
  const entries = new Map<string, { exists: boolean; expiresAt: number }>();
  return {
    get(sub) {
      const key = sub.toLowerCase();
      const e = entries.get(key);
      if (!e) return undefined;
      if (e.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return e.exists;
    },
    set(sub, exists) {
      entries.set(sub.toLowerCase(), { exists, expiresAt: now() + ttlMs });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers (rate-limited, backoff-aware)                                  */
/* -------------------------------------------------------------------------- */

type FetchResult<T> =
  | { ok: true; body: T }
  | { ok: false; status?: number; error: string };

/** Hard cap on retries per request so a hostile remote can't pin us. */
export const REDDIT_MAX_RETRIES = 3;

async function rateLimitedFetch(
  fetchImpl: typeof fetch,
  limiter: RateLimiter,
  backoff: BackoffPolicy,
  url: string,
  sleep: (ms: number) => Promise<void>,
  maxRetries: number = REDDIT_MAX_RETRIES,
): Promise<FetchResult<string>> {
  let attempt = 0;
  for (;;) {
    await limiter.acquire();
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: {
          'User-Agent': REDDIT_USER_AGENT,
          Accept: 'application/json',
        },
      });
    } catch (e) {
      const msg = (e as Error).message ?? 'fetch failed';
      if (attempt >= maxRetries) return { ok: false, error: msg };
      const delay = backoff.nextDelay();
      await sleep(delay);
      attempt += 1;
      continue;
    }
    if (res.status === 429) {
      if (attempt >= maxRetries) return { ok: false, status: 429, error: 'HTTP 429' };
      const ra = res.headers.get('retry-after');
      const hint = ra !== null ? { retryAfter: ra } : undefined;
      const delay = backoff.nextDelay(hint);
      await sleep(delay);
      attempt += 1;
      continue;
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    try {
      const text = await res.text();
      return { ok: true, body: text };
    } catch (e) {
      return { ok: false, error: (e as Error).message ?? 'read failed' };
    }
  }
}

function parseJsonSafe(body: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (e) {
    return { ok: false, error: (e as Error).message ?? 'invalid json' };
  }
}

/* -------------------------------------------------------------------------- */
/* Single-flight registry                                                       */
/* -------------------------------------------------------------------------- */

function singleFlight<TKey, TValue>() {
  const inflight = new Map<TKey, Promise<TValue>>();
  return {
    run(key: TKey, factory: () => Promise<TValue>): Promise<TValue> {
      const existing = inflight.get(key);
      if (existing) return existing;
      const p = factory().finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, p);
      return p;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Poller types & entry points                                                 */
/* -------------------------------------------------------------------------- */

export interface MentionNewEvent {
  readonly type: 'mention.new';
  readonly symbol: string;
  readonly item: MentionItem;
}

export interface PollRedditOptions {
  readonly symbol: string;
  readonly store: MentionStore;
  /** Subreddit list to poll. Defaults to {@link REDDIT_DEFAULT_SUBREDDITS}. */
  readonly subreddits?: readonly string[];
  /**
   * Whether to also probe & poll `r/$SYMBOL`. Defaults to `true`.
   * The probe result is cached for 7 days.
   */
  readonly probeSymbolSubreddit?: boolean;
  /** Override page size (capped at 100 by the upstream API). */
  readonly limit?: number;
  /** Max depth-1 comments to pull per post. */
  readonly commentLimit?: number;
  /** Injectable fetch (defaults to global `fetch`). */
  readonly fetchImpl?: typeof fetch;
  /** Shared rate limiter (1 req / 2s by default). One per poller instance. */
  readonly limiter?: RateLimiter;
  /** Shared subreddit-existence probe cache. */
  readonly probeCache?: SubredditProbeCache;
  /** Optional backoff config for `HTTP 429` retries. */
  readonly backoff?: BackoffOptions;
  /** Sleep impl (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Optional event sink for `mention.new`. */
  readonly onEvent?: (e: MentionNewEvent) => void;
  /** Injectable clock for `fetchedAt`. */
  readonly now?: () => Date;
  /** Error hook for diagnostics; never thrown. Receives the sub being polled. */
  readonly onError?: (sub: string, err: unknown) => void;
}

export interface PollRedditResult {
  readonly fetched: number;
  readonly inserted: number;
  readonly bySub: Record<
    string,
    { fetched: number; inserted: number; posts: number; comments: number; error?: string }
  >;
}

/**
 * Shared single-flight registry for `(symbol, sub)` pairs. Hoisted to
 * module scope so multiple `pollRedditMentions` calls coalesce naturally;
 * callers do not need to thread a registry through.
 */
const subFlights = singleFlight<string, SubResult>();

interface SubResult {
  readonly fetched: number;
  readonly inserted: number;
  readonly posts: number;
  readonly comments: number;
  readonly items: MentionItem[];
  readonly error?: string;
}

async function pollOneSubreddit(
  sub: string,
  symbol: string,
  opts: {
    fetchImpl: typeof fetch;
    limiter: RateLimiter;
    backoff: BackoffPolicy;
    sleep: (ms: number) => Promise<void>;
    now: () => Date;
    limit: number;
    commentLimit: number;
  },
): Promise<SubResult> {
  const searchUrl = redditSearchUrl(sub, symbol, opts.limit);
  const r = await rateLimitedFetch(opts.fetchImpl, opts.limiter, opts.backoff, searchUrl, opts.sleep);
  if (!r.ok) {
    return { fetched: 0, inserted: 0, posts: 0, comments: 0, items: [], error: r.error };
  }
  const parsed = parseJsonSafe(r.body);
  if (!parsed.ok) {
    return { fetched: 0, inserted: 0, posts: 0, comments: 0, items: [], error: parsed.error };
  }

  const posts = parseRedditPostListing(parsed.value, symbol, opts.now());
  const items: MentionItem[] = [...posts];

  if (opts.commentLimit > 0) {
    const listing = RedditListing.safeParse(parsed.value);
    const children = listing.success ? listing.data.data.children : [];
    for (const child of children) {
      const postId = child.data.id;
      if (!postId) continue;
      const commentsUrl = redditCommentsUrl(sub, postId);
      const cr = await rateLimitedFetch(
        opts.fetchImpl,
        opts.limiter,
        opts.backoff,
        commentsUrl,
        opts.sleep,
      );
      if (!cr.ok) continue;
      const cparsed = parseJsonSafe(cr.body);
      if (!cparsed.ok) continue;
      const comments = parseRedditCommentsListing(
        cparsed.value,
        symbol,
        opts.now(),
        opts.commentLimit,
      );
      items.push(...comments);
    }
  }

  const postsCount = posts.length;
  const commentsCount = items.length - postsCount;
  return {
    fetched: items.length,
    inserted: 0,
    posts: postsCount,
    comments: commentsCount,
    items,
  };
}

async function probeSubreddit(
  sub: string,
  opts: {
    fetchImpl: typeof fetch;
    limiter: RateLimiter;
    backoff: BackoffPolicy;
    sleep: (ms: number) => Promise<void>;
    cache: SubredditProbeCache;
  },
): Promise<boolean> {
  const cached = opts.cache.get(sub);
  if (cached !== undefined) return cached;
  const r = await rateLimitedFetch(
    opts.fetchImpl,
    opts.limiter,
    opts.backoff,
    redditSubredditAboutUrl(sub),
    opts.sleep,
  );
  if (!r.ok) {
    // Treat hard failures (404, private/banned) as "does not exist".
    const exists = false;
    opts.cache.set(sub, exists);
    return exists;
  }
  const parsed = parseJsonSafe(r.body);
  if (!parsed.ok) {
    opts.cache.set(sub, false);
    return false;
  }
  const about = RedditAboutResponse.safeParse(parsed.value);
  const exists = about.success && !!about.data.data?.display_name;
  opts.cache.set(sub, exists);
  return exists;
}

/**
 * Poll Reddit for `symbol` across the curated sub list (and `r/$SYMBOL`
 * when it exists). Persists freshly seen mentions via the injected
 * `MentionStore` and emits `mention.new` events for each insert. Dedup is
 * handled by the store on `(source, sourceId)`.
 *
 * Fetch / parse failures are reported via `onError` and surfaced on the
 * returned per-sub breakdown; they never throw.
 */
export async function pollRedditMentions(
  opts: PollRedditOptions,
): Promise<PollRedditResult> {
  const sym = Ticker.parse(opts.symbol.toUpperCase());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limiter = opts.limiter ?? createRedditRateLimiter();
  const probeCache = opts.probeCache ?? createSubredditProbeCache();
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => new Date());
  const limit = opts.limit ?? REDDIT_DEFAULT_LIMIT;
  const commentLimit = opts.commentLimit ?? REDDIT_DEFAULT_COMMENT_LIMIT;
  const backoff = new BackoffPolicy(opts.backoff);

  const baseSubs = opts.subreddits ?? REDDIT_DEFAULT_SUBREDDITS;
  const probeSymbol = opts.probeSymbolSubreddit ?? true;

  const subs: string[] = [];
  const seen = new Set<string>();
  for (const s of baseSubs) {
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    subs.push(s);
  }
  if (probeSymbol) {
    const symbolSub = sym;
    const key = symbolSub.toLowerCase();
    if (!seen.has(key)) {
      const exists = await probeSubreddit(symbolSub, {
        fetchImpl,
        limiter,
        backoff,
        sleep,
        cache: probeCache,
      });
      if (exists) subs.push(symbolSub);
    }
  }

  const bySub: PollRedditResult['bySub'] = {};
  let totalFetched = 0;
  let totalInserted = 0;

  for (const sub of subs) {
    const flightKey = `${sym}\u0000${sub.toLowerCase()}`;
    let result: SubResult;
    try {
      result = await subFlights.run(flightKey, () =>
        pollOneSubreddit(sub, sym, {
          fetchImpl,
          limiter,
          backoff,
          sleep,
          now,
          limit,
          commentLimit,
        }),
      );
    } catch (e) {
      const msg = (e as Error).message ?? 'poll failed';
      opts.onError?.(sub, e);
      bySub[sub] = { fetched: 0, inserted: 0, posts: 0, comments: 0, error: msg };
      continue;
    }

    if (result.error) {
      opts.onError?.(sub, new Error(result.error));
    }

    let inserted = 0;
    for (const item of result.items) {
      const written = await opts.store.appendMention(item);
      if (written !== null) {
        inserted += 1;
        opts.onEvent?.({ type: 'mention.new', symbol: sym, item: written });
      }
    }

    totalFetched += result.fetched;
    totalInserted += inserted;
    const entry: { fetched: number; inserted: number; posts: number; comments: number; error?: string } = {
      fetched: result.fetched,
      inserted,
      posts: result.posts,
      comments: result.comments,
    };
    if (result.error) entry.error = result.error;
    bySub[sub] = entry;
  }

  return { fetched: totalFetched, inserted: totalInserted, bySub };
}
