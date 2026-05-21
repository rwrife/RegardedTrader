/**
 * Company news poller (#24, parent #19).
 *
 * For a given symbol, fetches headlines from up to three RSS / JSON feeds:
 *
 *  - **Yahoo Finance**  — `query2.finance.yahoo.com/v1/finance/search?q=SYM&newsCount=20`
 *    (JSON, the `news` array on the response).
 *  - **Nasdaq**         — `https://www.nasdaq.com/feed/rssoutbound?symbol=SYM`
 *    (RSS).
 *  - **Google News**    — `https://news.google.com/rss/search?q=SYM+stock`
 *    (RSS).
 *
 * HTML scraping is explicitly out of scope (per the issue spec); only the
 * documented RSS / JSON endpoints are touched.
 *
 * Each item is validated with Zod, deduped via the `SnapshotStore`'s news
 * url-hash window (14 days), and persisted to `news.jsonl`. For each *newly
 * inserted* item the poller emits a `news.new` event through the optional
 * `onEvent` callback so the in-process event bus / SSE bridge (parent #19,
 * #25) can fan it out to the dashboard.
 *
 * The poller is intentionally framework-free: callers inject a `fetch`
 * implementation, a clock, and the store. No network, no disk, no logger
 * lives inside this module.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Ticker } from '../../schemas/index.js';
import type { SnapshotStore } from '../store.js';

/**
 * Source identifiers for the news poller. Kept distinct from the sentiment
 * poller's `SentimentSource` (in `schemas/sentiment.ts`) because the news
 * poller's surface is narrower (no Reddit / StockTwits / HN / CNN).
 */
export const NewsSource = z.enum(['yahoo', 'nasdaq', 'google-news']);
export type NewsSource = z.infer<typeof NewsSource>;

/**
 * Per-source on/off toggles. All sources are enabled by default; users can
 * disable any subset via `AppConfig.polling.news.sources` once wired through.
 */
export const NewsSourceToggles = z.object({
  yahoo: z.boolean().default(true),
  nasdaq: z.boolean().default(true),
  'google-news': z.boolean().default(true),
});
export type NewsSourceToggles = z.infer<typeof NewsSourceToggles>;

export const DEFAULT_NEWS_SOURCES: NewsSourceToggles = NewsSourceToggles.parse({});

/**
 * A single news item persisted to `news.jsonl` (under the `data` field of a
 * `SnapshotEntry`). Shape per the issue spec:
 *   { title, url, source, publishedAt, summary?, tickers: [SYMBOL] }
 */
export const NewsPollerItem = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  source: NewsSource,
  /** ISO-8601 timestamp from the upstream feed. */
  publishedAt: z.string(),
  summary: z.string().optional(),
  /** Tickers this article was fetched for. v1 only ever contains the polled symbol. */
  tickers: z.array(Ticker).min(1),
});
export type NewsPollerItem = z.infer<typeof NewsPollerItem>;

/**
 * Event payload emitted via `onEvent` for each newly persisted item.
 * `news.new` mirrors the channel name documented in the parent epic (#19).
 */
export interface NewsNewEvent {
  readonly type: 'news.new';
  readonly symbol: string;
  readonly item: NewsPollerItem;
}

export interface PollNewsOptions {
  readonly symbol: string;
  readonly store: SnapshotStore;
  /** Injectable fetch (defaults to global `fetch`). */
  readonly fetchImpl?: typeof fetch;
  /** Subset of sources to poll. Defaults to all enabled. */
  readonly sources?: Partial<NewsSourceToggles>;
  /** Optional event sink for `news.new`. */
  readonly onEvent?: (e: NewsNewEvent) => void;
  /** Injectable clock for `fetchedAt`-style stamps in tests. */
  readonly now?: () => Date;
  /** Per-source error hook for diagnostics; never thrown. */
  readonly onError?: (source: NewsSource, err: unknown) => void;
}

export interface PollNewsResult {
  readonly fetched: number;
  readonly inserted: number;
  readonly bySource: Record<NewsSource, { fetched: number; inserted: number; error?: string }>;
}

/* -------------------------------------------------------------------------- */
/* URL builders                                                                */
/* -------------------------------------------------------------------------- */

export function yahooNewsUrl(symbol: string): string {
  const q = encodeURIComponent(symbol.toUpperCase());
  return `https://query2.finance.yahoo.com/v1/finance/search?q=${q}&newsCount=20&quotesCount=0`;
}

export function nasdaqNewsUrl(symbol: string): string {
  // Note: Nasdaq's RSS endpoint accepts a symbol query param. Category is
  // optional and we don't constrain it — press releases + news + analyst
  // notes all flow through `rssoutbound`.
  const q = encodeURIComponent(symbol.toUpperCase());
  return `https://www.nasdaq.com/feed/rssoutbound?symbol=${q}`;
}

export function googleNewsUrl(symbol: string): string {
  const q = encodeURIComponent(`${symbol.toUpperCase()} stock`);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

/* -------------------------------------------------------------------------- */
/* Parsers                                                                     */
/* -------------------------------------------------------------------------- */

/** Yahoo `/v1/finance/search` response shape we care about. */
const YahooSearchResponse = z.object({
  news: z
    .array(
      z.object({
        title: z.string(),
        link: z.string().url().optional(),
        publisher: z.string().optional(),
        providerPublishTime: z.number().optional(),
        summary: z.string().optional(),
      }),
    )
    .default([]),
});

export function parseYahooNews(raw: unknown, symbol: string): NewsPollerItem[] {
  const parsed = YahooSearchResponse.safeParse(raw);
  if (!parsed.success) return [];
  const out: NewsPollerItem[] = [];
  for (const n of parsed.data.news) {
    if (!n.link) continue;
    const ts =
      typeof n.providerPublishTime === 'number'
        ? new Date(n.providerPublishTime * 1000).toISOString()
        : new Date(0).toISOString();
    const candidate = {
      title: n.title.trim(),
      url: n.link,
      source: 'yahoo' as const,
      publishedAt: ts,
      summary: n.summary?.trim() || undefined,
      tickers: [symbol.toUpperCase()],
    };
    const safe = NewsPollerItem.safeParse(candidate);
    if (safe.success) out.push(safe.data);
  }
  return out;
}

/* ---- RSS ----------------------------------------------------------------- */

/** Strip leading/trailing `<![CDATA[ ... ]]>` wrapper if present. */
function stripCdata(s: string): string {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m && m[1] !== undefined ? m[1] : s;
}

/** Decode the small set of HTML entities that appear in RSS text fields. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function pickTag(block: string, tag: string): string | undefined {
  // Non-greedy match; case-insensitive; tolerates attributes on the open tag.
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(block);
  if (!m || m[1] === undefined) return undefined;
  const v = decodeEntities(stripCdata(m[1])).trim();
  return v.length > 0 ? v : undefined;
}

/** Extract the `<link>` URL, handling both `<link>URL</link>` and atom-style `<link href="URL"/>`. */
function pickLink(block: string): string | undefined {
  const plain = pickTag(block, 'link');
  if (plain && /^https?:\/\//.test(plain)) return plain;
  const atom = /<link\b[^>]*\shref=["']([^"']+)["'][^>]*\/?>/i.exec(block);
  if (atom && atom[1] !== undefined) return decodeEntities(atom[1]);
  return undefined;
}

/** Best-effort ISO conversion of an RSS pubDate / Atom updated. */
function toIso(raw: string | undefined): string {
  if (!raw) return new Date(0).toISOString();
  const t = Date.parse(raw);
  return isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
}

/**
 * Minimal RSS / Atom item extractor. Sufficient for the small set of fields
 * we read (title, link, pubDate / published / updated, description).
 *
 * Avoids bringing in a full XML parser dependency — RSS endpoints we target
 * are well-formed enough for a tag-scoped regex pass, and we never need to
 * round-trip XML.
 */
export function parseRssItems(xml: string): Array<{
  title?: string;
  link?: string;
  pubDate?: string;
  description?: string;
}> {
  const items: Array<{ title?: string; link?: string; pubDate?: string; description?: string }> =
    [];
  const re = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  for (const m of xml.matchAll(re)) {
    const block = m[0];
    items.push({
      title: pickTag(block, 'title'),
      link: pickLink(block),
      pubDate:
        pickTag(block, 'pubDate') ?? pickTag(block, 'published') ?? pickTag(block, 'updated'),
      description: pickTag(block, 'description') ?? pickTag(block, 'summary'),
    });
  }
  return items;
}

export function parseNasdaqNews(xml: string, symbol: string): NewsPollerItem[] {
  const out: NewsPollerItem[] = [];
  for (const it of parseRssItems(xml)) {
    if (!it.title || !it.link) continue;
    const candidate = {
      title: it.title,
      url: it.link,
      source: 'nasdaq' as const,
      publishedAt: toIso(it.pubDate),
      summary: it.description,
      tickers: [symbol.toUpperCase()],
    };
    const safe = NewsPollerItem.safeParse(candidate);
    if (safe.success) out.push(safe.data);
  }
  return out;
}

export function parseGoogleNews(xml: string, symbol: string): NewsPollerItem[] {
  const out: NewsPollerItem[] = [];
  for (const it of parseRssItems(xml)) {
    if (!it.title || !it.link) continue;
    const candidate = {
      title: it.title,
      url: it.link,
      source: 'google-news' as const,
      publishedAt: toIso(it.pubDate),
      summary: it.description,
      tickers: [symbol.toUpperCase()],
    };
    const safe = NewsPollerItem.safeParse(candidate);
    if (safe.success) out.push(safe.data);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Poller                                                                      */
/* -------------------------------------------------------------------------- */

async function safeFetchText(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(url, {
      headers: {
        // Some feeds (notably Nasdaq) reject default fetch UAs.
        'User-Agent': 'RegardedTrader/0.1 (+local)',
        Accept: 'application/rss+xml, application/atom+xml, application/json;q=0.9, */*;q=0.1',
      },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: (e as Error).message ?? 'fetch failed' };
  }
}

/** Stable per-url hash used for dedup. Mirrors `SnapshotStore` (sha1 hex). */
export function urlHash(url: string): string {
  return createHash('sha1').update(url).digest('hex');
}

/**
 * Poll all enabled sources for `symbol`, dedup, persist, and emit
 * `news.new` for each freshly inserted item.
 *
 * Fetch failures from any single source are reported via `onError` and do
 * not stop the others — the poller is best-effort across providers.
 */
export async function pollNews(opts: PollNewsOptions): Promise<PollNewsResult> {
  const sym = Ticker.parse(opts.symbol.toUpperCase());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const toggles: NewsSourceToggles = NewsSourceToggles.parse({
    ...DEFAULT_NEWS_SOURCES,
    ...opts.sources,
  });

  const bySource: Record<NewsSource, { fetched: number; inserted: number; error?: string }> = {
    yahoo: { fetched: 0, inserted: 0 },
    nasdaq: { fetched: 0, inserted: 0 },
    'google-news': { fetched: 0, inserted: 0 },
  };

  const items: NewsPollerItem[] = [];

  if (toggles.yahoo) {
    const r = await safeFetchText(fetchImpl, yahooNewsUrl(sym));
    if (!r.ok) {
      bySource.yahoo.error = r.error;
      opts.onError?.('yahoo', new Error(r.error));
    } else {
      try {
        const parsed = parseYahooNews(JSON.parse(r.text), sym);
        bySource.yahoo.fetched = parsed.length;
        items.push(...parsed);
      } catch (e) {
        bySource.yahoo.error = (e as Error).message ?? 'parse failed';
        opts.onError?.('yahoo', e);
      }
    }
  }

  if (toggles.nasdaq) {
    const r = await safeFetchText(fetchImpl, nasdaqNewsUrl(sym));
    if (!r.ok) {
      bySource.nasdaq.error = r.error;
      opts.onError?.('nasdaq', new Error(r.error));
    } else {
      const parsed = parseNasdaqNews(r.text, sym);
      bySource.nasdaq.fetched = parsed.length;
      items.push(...parsed);
    }
  }

  if (toggles['google-news']) {
    const r = await safeFetchText(fetchImpl, googleNewsUrl(sym));
    if (!r.ok) {
      bySource['google-news'].error = r.error;
      opts.onError?.('google-news', new Error(r.error));
    } else {
      const parsed = parseGoogleNews(r.text, sym);
      bySource['google-news'].fetched = parsed.length;
      items.push(...parsed);
    }
  }

  // In-batch dedup by URL before hitting the store: two sources sometimes
  // republish the exact same article URL.
  const seen = new Set<string>();
  const unique: NewsPollerItem[] = [];
  for (const it of items) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    unique.push(it);
  }

  let inserted = 0;
  for (const item of unique) {
    const ts = item.publishedAt && item.publishedAt !== new Date(0).toISOString()
      ? item.publishedAt
      : now().toISOString();
    const written = await opts.store.appendSnapshot(
      sym,
      'news',
      { ts, data: item },
      { url: item.url },
    );
    if (written !== null) {
      inserted += 1;
      bySource[item.source].inserted += 1;
      opts.onEvent?.({ type: 'news.new', symbol: sym, item });
    }
  }

  return { fetched: unique.length, inserted, bySource };
}
