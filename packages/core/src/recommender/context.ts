/**
 * Recommender ContextBuilder (#46).
 *
 * Pure function that assembles a {@link RecommendationContext} from the
 * on-disk snapshot stores ({@link SnapshotStore} #21, {@link MentionStore}
 * #31) — **no network**. The result is the strict-budget context object
 * the LLM-driven recommender prompt and the rule engine both read.
 *
 * Design notes:
 *   - The store interfaces are typed structurally (see {@link SnapshotReader}
 *     / {@link MentionReader}) so tests can inject lightweight fakes
 *     without spinning up a real `SnapshotStore`.
 *   - Every section carries its own ISO `asOf` and a boolean `stale` flag
 *     computed as "older than 2× the section's expected cadence" (the
 *     recommender epic's freshness rule).
 *   - Section payloads are size-budgeted: news/opinion text and history
 *     arrays are truncated so the rendered prompt fits in
 *     `~budgetChars` (default 4000, ≈ 4k tokens at 1 char/token rough
 *     conservative).
 */

import { computeIndicators } from '../indicators/index.js';
import type { Indicators, OHLCV } from '../schemas/index.js';
import {
  DEFAULT_CHARS_PER_TOKEN,
  type ContextBudgetTelemetry,
} from '../schemas/context-budget.js';
import type {
  ContextBudgetReport,
  ContextHeadline,
  ContextHistoryBar,
  ContextHistorySection,
  ContextIndicatorsSection,
  ContextNewsSection,
  ContextOpinionItem,
  ContextOpinionsSection,
  ContextOptionsExpiryDigest,
  ContextOptionsSection,
  ContextQuoteSection,
  ContextSentimentSection,
  ContextSentimentSparkPoint,
  RecommendationContext,
} from './rules/index.js';
import type {
  MentionItem,
  ScoredMention,
  SentimentSnapshot,
} from '../schemas/sentiment.js';

/* -------------------------------------------------------------------------- */
/* Cadences & defaults                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Expected cadences (ms) used to compute per-section `stale` flags. The
 * recommender epic defines staleness as "older than 2× the section's
 * cadence"; tweaking these here keeps the rule colocated with the rest
 * of the builder.
 *
 * Defaults are deliberately conservative — they match the polling job
 * cadences during regular hours. Callers can override via
 * {@link BuildContextOptions.cadences}.
 */
export const DEFAULT_CADENCES_MS = {
  quote: 60_000, //   1m  → stale after 2m
  options: 5 * 60_000, //   5m  → stale after 10m
  sentiment: 5 * 60_000, //   5m  → stale after 10m
  news: 15 * 60_000, //  15m  → stale after 30m
  /** Daily bars — we treat anything older than 2 trading days as stale. */
  history: 24 * 60 * 60_000,
} as const;

export type CadenceKey = keyof typeof DEFAULT_CADENCES_MS;

/** Default char budget per the issue spec (≈ 4k tokens). */
export const DEFAULT_CONTEXT_BUDGET_CHARS = 4000;

/** Default news / opinions item limits per the issue spec. */
export const DEFAULT_NEWS_LIMIT = 8;
export const DEFAULT_OPINIONS_LIMIT = 8;

/** Default lookback windows. */
export const DEFAULT_HISTORY_DAYS = 30;
export const DEFAULT_SENTIMENT_SPARK_HOURS = 24;
export const DEFAULT_NEWS_LOOKBACK_HOURS = 72;
export const DEFAULT_OPINIONS_LOOKBACK_HOURS = 48;

/* -------------------------------------------------------------------------- */
/* Reader interfaces                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Minimal structural shape of the persisted `latest.json` map. Mirrors
 * (but does not import) `LatestSnapshot` to keep this module decoupled
 * from the `polling` package — only the fields we read are declared.
 */
export interface ContextLatestSnapshot {
  readonly symbol: string;
  readonly updatedAt: string;
  readonly entries: Record<
    string,
    {
      readonly ts: string;
      readonly data: unknown;
    }
  >;
  readonly sentiment?: SentimentSnapshot;
}

/** Subset of `SnapshotStore` consumed by the builder. */
export interface SnapshotReader {
  readLatest(symbol: string): Promise<ContextLatestSnapshot>;
  readRange(
    symbol: string,
    kind: 'quote' | 'options' | 'news',
    since?: Date,
    until?: Date,
  ): AsyncIterable<{ readonly ts: string; readonly data: unknown }>;
}

/** Subset of `MentionStore` consumed by the builder. */
export interface MentionReader {
  readMentions(
    symbol: string,
    since?: Date,
    until?: Date,
  ): AsyncIterable<MentionItem | ScoredMention>;
  readSentiment(
    symbol: string,
    since?: Date,
    until?: Date,
  ): AsyncIterable<SentimentSnapshot>;
}

/* -------------------------------------------------------------------------- */
/* Public options                                                             */
/* -------------------------------------------------------------------------- */

export interface BuildContextOptions {
  readonly symbol: string;
  readonly snapshots: SnapshotReader;
  readonly mentions?: MentionReader;
  /** Mirrors `AppConfig.risk.forbidNakedShorts`. Default `false`. */
  readonly forbidNakedShorts?: boolean;
  /** Override "now" for tests. */
  readonly now?: () => Date;
  /** Override per-section cadences (ms). */
  readonly cadences?: Partial<Record<CadenceKey, number>>;
  /**
   * Override the prompt char budget. Legacy name; `maxChars` (issue
   * #125) is preferred. When both are supplied, the smaller (more
   * conservative) value wins.
   */
  readonly budgetChars?: number;
  /**
   * Preferred char cap for the assembled context (issue #125). Aliases
   * `budgetChars`. Values `<= 0` are ignored (fall back to default) so
   * misconfigured provider settings can't wipe out the whole context.
   */
  readonly maxChars?: number;
  /**
   * Approximate token cap (issue #125). Converted to chars via
   * `charsPerToken` (default {@link DEFAULT_CHARS_PER_TOKEN}). When
   * combined with `maxChars` / `budgetChars`, the smallest resolved
   * char budget wins. Values `<= 0` are ignored.
   */
  readonly maxTokens?: number;
  /**
   * Chars-per-token conversion factor for `maxTokens`. Defaults to
   * {@link DEFAULT_CHARS_PER_TOKEN}. Only consulted when `maxTokens` is
   * set. Values `<= 0` fall back to the default.
   */
  readonly charsPerToken?: number;
  /**
   * Optional telemetry hook (issue #125). Called once per build with
   * the resolved budget, per-section char counts, approximate token
   * count, and the truncated flag. Errors thrown by the hook are
   * swallowed so a broken debug sink never crashes context assembly.
   */
  readonly onTelemetry?: (event: ContextBudgetTelemetry) => void;
  /** Override news headline count. */
  readonly newsLimit?: number;
  /** Override opinion mention count. */
  readonly opinionsLimit?: number;
  /** Override OHLCV lookback (days). */
  readonly historyDays?: number;
}

/* -------------------------------------------------------------------------- */
/* Builder                                                                    */
/* -------------------------------------------------------------------------- */

export async function buildRecommendationContext(
  opts: BuildContextOptions,
): Promise<RecommendationContext> {
  const symbol = opts.symbol.toUpperCase();
  const now = (opts.now ?? (() => new Date()))();
  const cadences = { ...DEFAULT_CADENCES_MS, ...(opts.cadences ?? {}) };
  const budgetChars = resolveBudgetChars(opts);
  const newsLimit = opts.newsLimit ?? DEFAULT_NEWS_LIMIT;
  const opinionsLimit = opts.opinionsLimit ?? DEFAULT_OPINIONS_LIMIT;
  const historyDays = opts.historyDays ?? DEFAULT_HISTORY_DAYS;

  const latest = await opts.snapshots.readLatest(symbol);
  const quote = buildQuoteSection(latest, now, cadences.quote);
  const options = buildOptionsSection(latest, now, cadences.options);

  // Daily history & indicators come from the quote stream.
  const history = await buildHistorySection(
    opts.snapshots,
    symbol,
    now,
    historyDays,
    cadences.history,
  );
  const indicators = buildIndicatorsSection(history, now, cadences.quote);

  // News headlines from the news stream.
  const news = await buildNewsSection(
    opts.snapshots,
    symbol,
    now,
    newsLimit,
    DEFAULT_NEWS_LOOKBACK_HOURS,
    cadences.news,
  );

  // Sentiment + opinions from the mention store, when supplied.
  const sentiment = opts.mentions
    ? await buildSentimentSection(
        opts.mentions,
        symbol,
        latest,
        now,
        DEFAULT_SENTIMENT_SPARK_HOURS,
        cadences.sentiment,
      )
    : null;

  const opinions = opts.mentions
    ? await buildOpinionsSection(
        opts.mentions,
        symbol,
        now,
        opinionsLimit,
        DEFAULT_OPINIONS_LOOKBACK_HOURS,
        cadences.sentiment,
      )
    : null;

  const budgetReport = applyCharBudget({
    history,
    indicators,
    options,
    sentiment,
    news,
    opinions,
    budgetChars,
  });

  const truncated = budgetReport.report.truncated.length > 0;

  // Fire telemetry after the budget has been applied. Errors are
  // swallowed: a broken debug sink must never take out a recommender
  // build. See ContextBudgetTelemetrySchema for the wire contract.
  if (opts.onTelemetry) {
    const charsPerToken = resolveCharsPerToken(opts.charsPerToken);
    const approxTokens = Math.ceil(budgetReport.report.chars.total / charsPerToken);
    try {
      opts.onTelemetry({
        symbol,
        builtAt: now.toISOString(),
        budgetChars,
        chars: budgetReport.report.chars,
        approxTokens,
        charsPerToken,
        truncated,
        truncatedSections: [...budgetReport.report.truncated],
      });
    } catch {
      // intentional: telemetry sinks are best-effort.
    }
  }

  return {
    symbol,
    risk: { forbidNakedShorts: opts.forbidNakedShorts ?? false },
    quote,
    options,
    history: budgetReport.history,
    indicators,
    sentiment: budgetReport.sentiment,
    news: budgetReport.news,
    opinions: budgetReport.opinions,
    budget: budgetReport.report,
    truncated,
  };
}

/**
 * Reconcile the several ways a caller can express a char budget
 * (issue #125). `maxChars` and `budgetChars` are direct char caps;
 * `maxTokens` is converted via `charsPerToken`. When more than one is
 * supplied, the smallest positive value wins so the tightest cap holds.
 * Non-positive values are ignored — they'd degenerate to "drop
 * everything" and are almost certainly a caller bug.
 */
function resolveBudgetChars(opts: BuildContextOptions): number {
  const candidates: number[] = [];
  if (typeof opts.maxChars === 'number' && opts.maxChars > 0) {
    candidates.push(Math.floor(opts.maxChars));
  }
  if (typeof opts.budgetChars === 'number' && opts.budgetChars > 0) {
    candidates.push(Math.floor(opts.budgetChars));
  }
  if (typeof opts.maxTokens === 'number' && opts.maxTokens > 0) {
    const cpt = resolveCharsPerToken(opts.charsPerToken);
    candidates.push(Math.max(1, Math.floor(opts.maxTokens * cpt)));
  }
  if (candidates.length === 0) return DEFAULT_CONTEXT_BUDGET_CHARS;
  return Math.min(...candidates);
}

function resolveCharsPerToken(v: number | undefined): number {
  if (typeof v === 'number' && v > 0) return v;
  return DEFAULT_CHARS_PER_TOKEN;
}

/* -------------------------------------------------------------------------- */
/* Section builders                                                           */
/* -------------------------------------------------------------------------- */

interface LatestQuotePayload {
  symbol?: string;
  price?: number;
  change?: number;
  changePercent?: number;
  volume?: number;
  asOf?: string;
  // Daily bar shape (issued by quote-yahoo daily history poll):
  t?: string;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function buildQuoteSection(
  latest: ContextLatestSnapshot,
  now: Date,
  cadenceMs: number,
): ContextQuoteSection {
  const entry = latest.entries.quote;
  if (!entry) {
    return { stale: true, asOf: new Date(0).toISOString(), last: null };
  }
  const data = asObject(entry.data) as LatestQuotePayload | null;
  const stale = isStale(entry.ts, now, cadenceMs);
  if (!data || typeof data.price !== 'number') {
    // Daily OHLCV bar can land in `latest.entries.quote` instead of a
    // realtime quote — in that case we still know freshness but have no
    // realtime price field to surface.
    if (data && typeof data.c === 'number') {
      return {
        stale,
        asOf: entry.ts,
        last: {
          price: data.c,
          change: 0,
          changePercent: 0,
          volume: typeof data.v === 'number' ? data.v : 0,
        },
      };
    }
    return { stale, asOf: entry.ts, last: null };
  }
  return {
    stale,
    asOf: entry.ts,
    last: {
      price: data.price,
      change: typeof data.change === 'number' ? data.change : 0,
      changePercent: typeof data.changePercent === 'number' ? data.changePercent : 0,
      volume: typeof data.volume === 'number' ? data.volume : 0,
    },
  };
}

interface LatestOptionsPayload {
  metrics?: {
    symbol?: string;
    expiry?: string;
    underlyingPrice?: number | null;
    atmIv?: number | null;
    ivSkew25d?: number | null;
    openInterest?: { call: number; put: number; total: number };
    volume?: { call: number; put: number; total: number };
    putCallRatio?: number | null;
    contractCount?: number;
  };
  contracts?: unknown[];
}

function buildOptionsSection(
  latest: ContextLatestSnapshot,
  now: Date,
  cadenceMs: number,
): ContextOptionsSection | null {
  const entry = latest.entries.options;
  if (!entry) return null;
  const data = asObject(entry.data) as LatestOptionsPayload | null;
  const metrics = data?.metrics;
  const stale = isStale(entry.ts, now, cadenceMs);
  if (!metrics || typeof metrics.contractCount !== 'number') {
    return { hasChain: false, asOf: entry.ts, stale, expiries: [] };
  }
  const digest: ContextOptionsExpiryDigest = {
    expiry: metrics.expiry ?? '',
    asOf: entry.ts,
    atmIv: metrics.atmIv ?? null,
    ivSkew25d: metrics.ivSkew25d ?? null,
    openInterest: {
      call: metrics.openInterest?.call ?? 0,
      put: metrics.openInterest?.put ?? 0,
      total: metrics.openInterest?.total ?? 0,
    },
    volume: {
      call: metrics.volume?.call ?? 0,
      put: metrics.volume?.put ?? 0,
      total: metrics.volume?.total ?? 0,
    },
    putCallRatio: metrics.putCallRatio ?? null,
    contractCount: metrics.contractCount,
    underlyingPrice: metrics.underlyingPrice ?? null,
  };
  return {
    hasChain: metrics.contractCount > 0,
    asOf: entry.ts,
    stale,
    expiries: [digest],
  };
}

async function buildHistorySection(
  store: SnapshotReader,
  symbol: string,
  now: Date,
  days: number,
  cadenceMs: number,
): Promise<ContextHistorySection | null> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60_000);
  const bars: ContextHistoryBar[] = [];
  for await (const entry of store.readRange(symbol, 'quote', since, now)) {
    const data = asObject(entry.data);
    if (!data) continue;
    if (
      typeof data.t === 'string' &&
      typeof data.o === 'number' &&
      typeof data.h === 'number' &&
      typeof data.l === 'number' &&
      typeof data.c === 'number' &&
      typeof data.v === 'number'
    ) {
      bars.push({
        t: data.t,
        o: data.o,
        h: data.h,
        l: data.l,
        c: data.c,
        v: data.v,
      });
    }
  }
  if (bars.length === 0) return null;
  // Newest-first dedup by date keeps things deterministic if the stream
  // contains repeats from a re-poll.
  const byDate = new Map<string, ContextHistoryBar>();
  for (const b of bars) byDate.set(b.t, b);
  const dedup = Array.from(byDate.values()).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const last = dedup[dedup.length - 1]!;
  return {
    asOf: last.t,
    stale: isStale(last.t, now, cadenceMs * 2),
    bars: dedup,
  };
}

function buildIndicatorsSection(
  history: ContextHistorySection | null,
  now: Date,
  cadenceMs: number,
): ContextIndicatorsSection | null {
  if (!history || history.bars.length === 0) return null;
  const ohlcv: OHLCV[] = history.bars.map((b) => ({ ...b }));
  const ind: Indicators = computeIndicators(ohlcv);
  return {
    asOf: history.asOf,
    stale: isStale(history.asOf, now, cadenceMs * 2),
    rsi14: ind.rsi14,
    sma20: ind.sma20,
    sma50: ind.sma50,
    ema12: ind.ema12,
    ema26: ind.ema26,
    macd: ind.macd,
    macdSignal: ind.macdSignal,
    atr14: ind.atr14,
  };
}

async function buildNewsSection(
  store: SnapshotReader,
  symbol: string,
  now: Date,
  limit: number,
  lookbackHours: number,
  cadenceMs: number,
): Promise<ContextNewsSection | null> {
  const since = new Date(now.getTime() - lookbackHours * 60 * 60_000);
  const collected: Array<{ ts: string; item: ContextHeadline }> = [];
  for await (const entry of store.readRange(symbol, 'news', since, now)) {
    const data = asObject(entry.data);
    if (!data) continue;
    if (
      typeof data.title !== 'string' ||
      typeof data.url !== 'string' ||
      typeof data.source !== 'string' ||
      typeof data.publishedAt !== 'string'
    ) {
      continue;
    }
    const item: ContextHeadline = {
      title: data.title,
      url: data.url,
      source: data.source,
      publishedAt: data.publishedAt,
      ...(typeof data.summary === 'string' ? { summary: data.summary } : {}),
    };
    collected.push({ ts: entry.ts, item });
  }
  if (collected.length === 0) return null;
  // Dedup by URL — keep newest by `publishedAt`.
  const byUrl = new Map<string, ContextHeadline>();
  for (const c of collected) {
    const existing = byUrl.get(c.item.url);
    if (!existing || c.item.publishedAt > existing.publishedAt) {
      byUrl.set(c.item.url, c.item);
    }
  }
  const items = Array.from(byUrl.values())
    .sort((a, b) => (a.publishedAt > b.publishedAt ? -1 : a.publishedAt < b.publishedAt ? 1 : 0))
    .slice(0, limit);
  const asOf = items[0]!.publishedAt;
  return {
    asOf,
    stale: isStale(asOf, now, cadenceMs * 2),
    items,
  };
}

async function buildSentimentSection(
  store: MentionReader,
  symbol: string,
  latest: ContextLatestSnapshot,
  now: Date,
  sparkHours: number,
  cadenceMs: number,
): Promise<ContextSentimentSection | null> {
  const since = new Date(now.getTime() - sparkHours * 60 * 60_000);
  const snapshots: SentimentSnapshot[] = [];
  for await (const s of store.readSentiment(symbol, since, now)) snapshots.push(s);

  // Prefer the explicit `latest.sentiment` block (writer keeps it in sync)
  // but fall back to the newest streamed snapshot.
  const latestSentiment =
    latest.sentiment ??
    (snapshots.length > 0
      ? snapshots.reduce((a, b) => (a.asOf > b.asOf ? a : b))
      : null);
  if (!latestSentiment) return null;

  const spark: ContextSentimentSparkPoint[] = snapshots
    .sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0))
    .map((s) => ({ t: s.asOf, score: s.score }));

  return {
    asOf: latestSentiment.asOf,
    stale: isStale(latestSentiment.asOf, now, cadenceMs * 2),
    score: latestSentiment.score,
    confidence: latestSentiment.confidence,
    volume: latestSentiment.volume,
    spark24h: spark,
  };
}

async function buildOpinionsSection(
  store: MentionReader,
  symbol: string,
  now: Date,
  limit: number,
  lookbackHours: number,
  cadenceMs: number,
): Promise<ContextOpinionsSection | null> {
  const since = new Date(now.getTime() - lookbackHours * 60 * 60_000);
  const all: Array<MentionItem | ScoredMention> = [];
  for await (const m of store.readMentions(symbol, since, now)) all.push(m);
  if (all.length === 0) return null;

  // Dedup by URL when present, else by (source, sourceId).
  const seen = new Map<string, MentionItem | ScoredMention>();
  for (const m of all) {
    const key = m.url ?? `${m.source}\u0000${m.sourceId}`;
    const prev = seen.get(key);
    if (!prev || m.publishedAt > prev.publishedAt) seen.set(key, m);
  }
  const sorted = Array.from(seen.values()).sort((a, b) =>
    a.publishedAt > b.publishedAt ? -1 : a.publishedAt < b.publishedAt ? 1 : 0,
  );
  const top = sorted.slice(0, limit);

  const items: ContextOpinionItem[] = top.map((m) => {
    const scored = 'sentiment' in m ? m : null;
    return {
      source: m.source,
      ...(m.url ? { url: m.url } : {}),
      ...(m.title ? { title: m.title } : {}),
      text: m.text,
      publishedAt: m.publishedAt,
      ...(scored
        ? {
            score: scored.sentiment.score,
            confidence: scored.sentiment.confidence,
            label: scored.sentiment.label,
          }
        : {}),
    };
  });

  const asOf = items[0]!.publishedAt;
  return {
    asOf,
    stale: isStale(asOf, now, cadenceMs * 2),
    items,
  };
}

/* -------------------------------------------------------------------------- */
/* Budget                                                                     */
/* -------------------------------------------------------------------------- */

interface BudgetInputs {
  history: ContextHistorySection | null;
  indicators: ContextIndicatorsSection | null;
  options: ContextOptionsSection | null;
  sentiment: ContextSentimentSection | null;
  news: ContextNewsSection | null;
  opinions: ContextOpinionsSection | null;
  budgetChars: number;
}

interface BudgetOutputs {
  history: ContextHistorySection | null;
  sentiment: ContextSentimentSection | null;
  news: ContextNewsSection | null;
  opinions: ContextOpinionsSection | null;
  report: ContextBudgetReport;
}

/**
 * Apply a soft char budget to the variable-length sections. Fixed-size
 * sections (indicators, options digest) are not trimmed; only history,
 * news, opinions, and the sentiment sparkline shed entries when needed.
 *
 * Strategy: estimate each section's char cost via {@link approxChars} and,
 * while the total exceeds the budget, drop the oldest entry from the
 * largest variable-length section. This converges in O(n) total drops.
 */
function applyCharBudget(inp: BudgetInputs): BudgetOutputs {
  let history = inp.history;
  let news = inp.news;
  let opinions = inp.opinions;
  let sentiment = inp.sentiment;
  const truncated = new Set<string>();

  const optionsChars = approxOptionsChars(inp.options);
  const indicatorsChars = approxIndicatorsChars(inp.indicators);

  // Fail-safe guard against runaway loops on pathological inputs.
  const MAX_ITERATIONS = 100_000;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const counts = {
      history: approxHistoryChars(history),
      news: approxNewsChars(news),
      opinions: approxOpinionsChars(opinions),
      sentiment: approxSentimentChars(sentiment),
    };
    const total =
      optionsChars + indicatorsChars + counts.history + counts.news + counts.opinions + counts.sentiment;
    if (total <= inp.budgetChars) break;

    // Drop from the largest variable section first.
    const ranked: Array<{ name: 'history' | 'news' | 'opinions' | 'sentiment'; size: number }> = (
      [
        { name: 'history' as const, size: counts.history },
        { name: 'news' as const, size: counts.news },
        { name: 'opinions' as const, size: counts.opinions },
        { name: 'sentiment' as const, size: counts.sentiment },
      ]
    ).sort((a, b) => b.size - a.size);

    let dropped = false;
    for (const target of ranked) {
      if (target.size === 0) continue;
      switch (target.name) {
        case 'history':
          if (history && history.bars.length > 1) {
            history = {
              ...history,
              bars: history.bars.slice(1),
            };
            truncated.add('history');
            dropped = true;
          }
          break;
        case 'news':
          if (news && news.items.length > 1) {
            news = { ...news, items: news.items.slice(0, news.items.length - 1) };
            truncated.add('news');
            dropped = true;
          }
          break;
        case 'opinions':
          if (opinions && opinions.items.length > 1) {
            opinions = { ...opinions, items: opinions.items.slice(0, opinions.items.length - 1) };
            truncated.add('opinions');
            dropped = true;
          }
          break;
        case 'sentiment':
          if (sentiment && sentiment.spark24h.length > 1) {
            sentiment = { ...sentiment, spark24h: sentiment.spark24h.slice(1) };
            truncated.add('sentiment');
            dropped = true;
          }
          break;
      }
      if (dropped) break;
    }
    if (!dropped) break; // Can't shrink any further.
  }

  const finalCounts = {
    history: approxHistoryChars(history),
    indicators: indicatorsChars,
    options: optionsChars,
    sentiment: approxSentimentChars(sentiment),
    news: approxNewsChars(news),
    opinions: approxOpinionsChars(opinions),
  };
  const total =
    finalCounts.history +
    finalCounts.indicators +
    finalCounts.options +
    finalCounts.sentiment +
    finalCounts.news +
    finalCounts.opinions;

  return {
    history,
    sentiment,
    news,
    opinions,
    report: {
      chars: { ...finalCounts, total },
      truncated: Array.from(truncated),
      budgetChars: inp.budgetChars,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isStale(asOf: string, now: Date, twoCadenceMs: number): boolean {
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t > twoCadenceMs;
}

/**
 * Rough char-size estimators. Intentionally simple and deterministic —
 * the LLM tokenizer is not available here, and we only need a stable
 * proxy to drive the budgeter.
 */
function approxHistoryChars(s: ContextHistorySection | null): number {
  if (!s) return 0;
  // ~45 chars per OHLCV row in compact JSON.
  return 16 + s.bars.length * 45;
}

function approxIndicatorsChars(s: ContextIndicatorsSection | null): number {
  return s ? 160 : 0;
}

function approxOptionsChars(s: ContextOptionsSection | null): number {
  if (!s) return 0;
  return 80 + (s.expiries?.length ?? 0) * 180;
}

function approxSentimentChars(s: ContextSentimentSection | null): number {
  if (!s) return 0;
  return 80 + s.spark24h.length * 30;
}

function approxNewsChars(s: ContextNewsSection | null): number {
  if (!s) return 0;
  let n = 16;
  for (const it of s.items) {
    n += (it.title?.length ?? 0) + (it.url?.length ?? 0) + (it.summary?.length ?? 0) + 40;
  }
  return n;
}

function approxOpinionsChars(s: ContextOpinionsSection | null): number {
  if (!s) return 0;
  let n = 16;
  for (const it of s.items) {
    n += (it.text?.length ?? 0) + (it.url?.length ?? 0) + (it.title?.length ?? 0) + 40;
  }
  return n;
}
