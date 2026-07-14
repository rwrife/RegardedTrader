/**
 * CNN Business mentions poller (#35, parent #30).
 *
 * Collects ticker mentions from two public CNN surfaces:
 *
 *  1. RSS feeds (broad, symbol-agnostic):
 *     - `https://rss.cnn.com/rss/money_topstories.rss`
 *     - `https://rss.cnn.com/rss/money_markets.rss`
 *     Items whose title or description contain the symbol (as `$SYM`,
 *     `(SYM)`, or a standalone all-caps token) or the company name are
 *     kept and mapped to `MentionItem`s with `source: 'cnn'`.
 *
 *  2. Per-symbol depth (best-effort, once per cycle):
 *     - `https://www.cnn.com/markets/stocks/$SYMBOL`
 *     A single blurb / headline is extracted from the returned HTML using
 *     conservative regexes (title, `<meta name="description">`, first
 *     `<h1>`, first `<p>`). If the page shape changes or the request
 *     fails, the depth fetch is *skipped* — the poller never throws.
 *
 * Privacy: authors, subreddits-as-handles, or any per-user metadata are
 * never persisted (the `MentionItem` schema has no field for them, and
 * the store's `appendMention` strips unknown keys).
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
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Default RSS feeds polled per cycle. */
export const CNN_DEFAULT_RSS_FEEDS: readonly string[] = [
  'https://rss.cnn.com/rss/money_topstories.rss',
  'https://rss.cnn.com/rss/money_markets.rss',
];

/** Base URL for the per-symbol depth page. */
export const CNN_STOCK_PAGE_BASE_URL = 'https://www.cnn.com/markets/stocks/';

/** Identified UA — be a good citizen. */
export const CNN_USER_AGENT =
  'RegardedTrader/0.1 (+local; sentiment poller)';

/** Default lookback for RSS items when their pubDate is present. */
export const CNN_DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* URL builders                                                                */
/* -------------------------------------------------------------------------- */

export function cnnStockPageUrl(symbol: string): string {
  return `${CNN_STOCK_PAGE_BASE_URL}${encodeURIComponent(symbol.toLowerCase())}`;
}

/* -------------------------------------------------------------------------- */
/* Helpers: hash, url-check, match                                             */
/* -------------------------------------------------------------------------- */

/** Small non-crypto hash used to derive stable per-source ids. */
export function cnnUrlHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function isHttpUrl(u: string | null | undefined): u is string {
  if (typeof u !== 'string') return false;
  return /^https?:\/\//i.test(u);
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripHtml(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, '')).trim();
}

function isoOrUndef(input: string | null | undefined): string | undefined {
  if (typeof input !== 'string') return undefined;
  const t = Date.parse(input);
  if (isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

/**
 * Return true when `haystack` mentions the ticker `symbol` or the company
 * `name`. Matches are word-bounded and case-insensitive; the symbol is
 * matched as `$SYM`, `(SYM)`, or as a standalone all-caps token so we
 * don't false-match on ordinary English words.
 */
export function cnnMatchesSymbol(
  haystack: string,
  symbol: string,
  name?: string,
): boolean {
  if (!haystack) return false;
  const sym = symbol.toUpperCase();
  const dollar = new RegExp(`\\$${sym}\\b`);
  if (dollar.test(haystack)) return true;
  const paren = new RegExp(`\\(\\s*${sym}\\s*\\)`);
  if (paren.test(haystack)) return true;
  // Standalone all-caps token: require ticker to appear with a non-word
  // boundary on both sides and not adjacent to other letters/digits.
  const bare = new RegExp(`(^|[^A-Za-z0-9])${sym}([^A-Za-z0-9]|$)`);
  if (bare.test(haystack)) return true;
  if (name && name.trim().length >= 2) {
    const escaped = name
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(haystack)) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* RSS parsing                                                                 */
/* -------------------------------------------------------------------------- */

const RssItemRaw = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  link: z.string().optional(),
  pubDate: z.string().optional(),
  guid: z.string().optional(),
});
type RssItemRaw = z.infer<typeof RssItemRaw>;

function extractTag(block: string, tag: string): string | undefined {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    'i',
  );
  const m = block.match(re);
  if (!m) return undefined;
  let inner = m[1] ?? '';
  const cdata = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) inner = cdata[1] ?? '';
  return decodeHtmlEntities(inner).trim();
}

/**
 * Parse a raw RSS feed body into a list of items. Tolerant of loose XML:
 * we scan for `<item>...</item>` blocks and extract known tags. Unknown
 * feed shapes yield an empty list rather than throwing.
 */
export function parseCnnRssItems(xml: string): RssItemRaw[] {
  if (typeof xml !== 'string' || xml.length === 0) return [];
  const out: RssItemRaw[] = [];
  const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1] ?? '';
    const candidate = {
      title: extractTag(block, 'title'),
      description: extractTag(block, 'description'),
      link: extractTag(block, 'link'),
      pubDate: extractTag(block, 'pubDate'),
      guid: extractTag(block, 'guid'),
    };
    const parsed = RssItemRaw.safeParse(candidate);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Convert matching RSS items into `MentionItem`s for `symbol`. Pure: no
 * I/O. Items without a usable title/description or a valid link are
 * dropped. `publishedAt` falls back to `now` when the feed omits or
 * mangles `pubDate` (RSS pubDates are frequently missing).
 */
export function parseCnnMentions(
  xml: string,
  symbol: string,
  name: string | undefined,
  now: Date = new Date(),
  lookbackMs: number = CNN_DEFAULT_LOOKBACK_MS,
): MentionItem[] {
  const sym = symbol.toUpperCase();
  const fetchedAt = now.toISOString();
  const cutoffMs = now.getTime() - Math.max(0, lookbackMs);
  const out: MentionItem[] = [];
  for (const raw of parseCnnRssItems(xml)) {
    const title = raw.title ? stripHtml(raw.title) : '';
    const desc = raw.description ? stripHtml(raw.description) : '';
    const text = [title, desc].filter(Boolean).join('\n\n').trim();
    if (!text) continue;
    if (!cnnMatchesSymbol(`${title}\n${desc}`, sym, name)) continue;
    const publishedIso = isoOrUndef(raw.pubDate) ?? fetchedAt;
    if (Date.parse(publishedIso) < cutoffMs) continue;
    const link = isHttpUrl(raw.link) ? raw.link : undefined;
    const guid = raw.guid && raw.guid.length > 0 ? raw.guid : undefined;
    const idBasis = guid ?? link ?? `${title}|${publishedIso}`;
    const candidate: MentionItem = {
      source: 'cnn',
      sourceId: `cnn_rss_${cnnUrlHash(idBasis)}`,
      symbol: sym,
      text,
      publishedAt: publishedIso,
      fetchedAt,
      ...(title ? { title } : {}),
      ...(link ? { url: link } : {}),
    };
    const safe = MentionItem.safeParse(candidate);
    if (safe.success) out.push(safe.data);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Per-symbol page extraction                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Extract a single blurb from a CNN stocks page HTML. Best-effort:
 * tries, in order, `<meta name="description">`, `<meta property=
 * "og:description">`, the first `<h1>`, then the first `<p>`. Returns
 * `undefined` when nothing plausible is found; callers should skip the
 * mention rather than crash.
 */
export function extractCnnStockPageBlurb(html: string): {
  title?: string;
  blurb?: string;
} {
  if (typeof html !== 'string' || html.length === 0) return {};
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripHtml(titleMatch[1] ?? '') : undefined;

  const metaDesc = html.match(
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i,
  );
  const ogDesc = html.match(
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i,
  );
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const p = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);

  const blurb =
    (metaDesc ? decodeHtmlEntities(metaDesc[1] ?? '').trim() : '') ||
    (ogDesc ? decodeHtmlEntities(ogDesc[1] ?? '').trim() : '') ||
    (h1 ? stripHtml(h1[1] ?? '') : '') ||
    (p ? stripHtml(p[1] ?? '') : '') ||
    '';

  return {
    ...(title ? { title } : {}),
    ...(blurb ? { blurb } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Poller                                                                      */
/* -------------------------------------------------------------------------- */

export interface MentionNewEvent {
  readonly type: 'mention.new';
  readonly symbol: string;
  readonly item: MentionItem;
}

export interface PollCnnOptions {
  readonly symbol: string;
  readonly store: MentionStore;
  /** Optional company name to broaden RSS matching. */
  readonly name?: string;
  /** Override list of RSS feeds. Defaults to {@link CNN_DEFAULT_RSS_FEEDS}. */
  readonly rssFeeds?: readonly string[];
  /** Override per-symbol page URL builder result (used by tests). */
  readonly stockPageUrl?: string;
  /** Skip the per-symbol HTML fetch. Defaults to `false`. */
  readonly skipStockPage?: boolean;
  /** Lookback window in ms for RSS items. Defaults to 24h. */
  readonly lookbackMs?: number;
  /** Injectable fetch (defaults to global `fetch`). */
  readonly fetchImpl?: typeof fetch;
  /** Optional event sink for `mention.new`. */
  readonly onEvent?: (e: MentionNewEvent) => void;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
  /** Error hook for diagnostics; never thrown. */
  readonly onError?: (err: unknown) => void;
}

export interface PollCnnResult {
  readonly fetched: number;
  readonly inserted: number;
  /** Per-source aggregated error string, if any leg failed. */
  readonly error?: string;
}

interface FetchOk {
  readonly ok: true;
  readonly body: string;
}
interface FetchErr {
  readonly ok: false;
  readonly error: string;
}

async function safeFetchText(
  fetchImpl: typeof fetch,
  url: string,
): Promise<FetchOk | FetchErr> {
  try {
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': CNN_USER_AGENT,
        Accept:
          'application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
      },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.text();
    return { ok: true, body };
  } catch (e) {
    return { ok: false, error: (e as Error).message ?? 'fetch failed' };
  }
}

/**
 * Poll CNN Business RSS feeds (and, best-effort, the per-symbol page) for
 * mentions of `symbol`. Persists freshly seen mentions via the injected
 * `MentionStore` and emits `mention.new` events for each insert. Dedup is
 * handled by the store on `(source, sourceId)`.
 *
 * Fetch / parse failures on any leg are captured and reported via
 * `onError` + the aggregated `error` field on the result. Individual leg
 * failures do NOT abort the other legs; the scheduler stays alive even
 * when one CNN surface breaks or changes shape.
 */
export async function pollCnnMentions(
  opts: PollCnnOptions,
): Promise<PollCnnResult> {
  const sym = Ticker.parse(opts.symbol.toUpperCase());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const lookbackMs = opts.lookbackMs ?? CNN_DEFAULT_LOOKBACK_MS;
  const feeds = opts.rssFeeds ?? CNN_DEFAULT_RSS_FEEDS;
  const runAt = now();
  const fetchedAt = runAt.toISOString();
  const errors: string[] = [];

  const collected: MentionItem[] = [];

  /* --- RSS feeds --------------------------------------------------------- */
  for (const feedUrl of feeds) {
    const r = await safeFetchText(fetchImpl, feedUrl);
    if (!r.ok) {
      errors.push(`rss ${feedUrl}: ${r.error}`);
      opts.onError?.(new Error(`rss ${feedUrl}: ${r.error}`));
      continue;
    }
    try {
      const items = parseCnnMentions(r.body, sym, opts.name, runAt, lookbackMs);
      collected.push(...items);
    } catch (e) {
      const msg = (e as Error).message ?? 'parse failed';
      errors.push(`rss ${feedUrl}: ${msg}`);
      opts.onError?.(e);
    }
  }

  /* --- Per-symbol depth page -------------------------------------------- */
  if (!opts.skipStockPage) {
    const pageUrl = opts.stockPageUrl ?? cnnStockPageUrl(sym);
    const r = await safeFetchText(fetchImpl, pageUrl);
    if (!r.ok) {
      // Degrade gracefully: log via onError, do not push an error since
      // depth is best-effort.
      opts.onError?.(new Error(`page ${pageUrl}: ${r.error}`));
    } else {
      try {
        const { title, blurb } = extractCnnStockPageBlurb(r.body);
        const text = [title, blurb].filter(Boolean).join('\n\n').trim();
        if (text) {
          const candidate: MentionItem = {
            source: 'cnn',
            sourceId: `cnn_page_${cnnUrlHash(pageUrl)}_${cnnUrlHash(text)}`,
            symbol: sym,
            text,
            publishedAt: fetchedAt,
            fetchedAt,
            url: pageUrl,
            ...(title ? { title } : {}),
          };
          const safe = MentionItem.safeParse(candidate);
          if (safe.success) collected.push(safe.data);
        }
        // else: page shape unrecognised — skip silently.
      } catch (e) {
        // HTML shape changed — log, skip, never crash the scheduler.
        opts.onError?.(e);
      }
    }
  }

  /* --- Persist ---------------------------------------------------------- */
  let inserted = 0;
  for (const item of collected) {
    try {
      const written = await opts.store.appendMention(item);
      if (written !== null) {
        inserted += 1;
        opts.onEvent?.({ type: 'mention.new', symbol: sym, item: written });
      }
    } catch (e) {
      errors.push(`store: ${(e as Error).message ?? 'append failed'}`);
      opts.onError?.(e);
    }
  }

  const result: PollCnnResult = {
    fetched: collected.length,
    inserted,
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  };
  return result;
}
