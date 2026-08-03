import express from 'express';
import cors from 'cors';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { logger } from './logging.js';
import {
  Orchestrator,
  Technician,
  NewsScout,
  YahooClient,
  Ticker,
  QuoteSchema,
  loadConfig,
  saveConfig,
  redactConfig,
  activeLLM,
  AppConfig,
  AiProvider,
  RiskConfig,
  BriefingRequest,
  PlansResponse,
  ConfigTestResult,
  CORE_VERSION,
  ServerVersion,
  SERVER_API_VERSION,
  buildLLM,
  type ConfigTestResult as ConfigTestResultT,
  MarketDataProviderConfig,
  createMarketDataRegistry,
  TickerValidator,
  WatchlistStore,
  BriefingStore,
  looksLikeBriefingId,
  DuckDuckGoSearch,
  computeIndicators,
  MentionStore,
  SentimentSource,
  SentimentSnapshot,
  type MentionItem,
  type ScoredMention,
  type WebSearch,
  type LLM,
  type AppConfig as AppConfigT,
  type AiProvider as AiProviderT,
  type WatchlistEntry,
  type ValidationResult,
  type MarketDataClient,
  type LiveQuote,
  PaperBroker,
  PaperStore,
  TradePlan,
  type BriefingStorePort,
  type OHLCV,
} from '@regardedtrader/core';
import { liveQuote, type LiveQuoteSource, type YahooQuoteLike } from './liveQuote.js';
import { isLoopbackOrigin } from './bind-guard.js';
import { SERVER_VERSION } from './version.js';
import { CalendarService, todayEt, toEtDateKey } from './calendarService.js';
import { PollingCoordinator } from './polling.js';

export interface AppDeps {
  /**
   * Fallback market-data client used when the user hasn't configured a
   * provider. Production wires `YahooClient`; tests inject mocks.
   */
  market: MarketDataClient;
  webSearch: WebSearch;
  /** Build an LLM from current config; returns null if not configured. */
  llmFromConfig: (cfg: AppConfigT) => LLM | null;
  /**
   * Build an LLM for a specific provider config — used by the
   * `POST /config/test` smoke-test endpoint so it can probe any configured
   * provider, not just the active one. Defaults to `buildLLM` from core.
   */
  buildLLMForProvider?: (provider: AiProviderT) => LLM;
  watchlist: WatchlistStore;
  mentions?: MentionStore;
  briefings?: BriefingStorePort;
  initialConfig: AppConfigT;
  /**
   * Built-in live-quote source used when no provider is configured (or when
   * the configured provider is `yahoo`). Production wires the lazy
   * `yahoo-finance2.quoteCombine` adapter; tests inject a mock.
   */
  liveQuoteSource?: LiveQuoteSource;
  /** Optional clock override for testing the live-quote cache. */
  now?: () => number;
  /** Optional paper-trading store override for tests. */
  paperStore?: PaperStore;
  /** Optional injectable calendar service (tests). */
  calendar?: CalendarService;
  /** Optional polling cadence overrides (tests). */
  polling?: {
    quoteEveryMs?: number;
    newsEveryMs?: number;
  };
  /**
   * Optional runtime auth gate for dashboard sessions (#18). Tests and
   * internal dev mode can omit this to keep the app unauthenticated.
   */
  auth?:
    | {
        mode: 'required';
        token: string;
        dashboardOrigin: string;
      }
    | {
        mode: 'allow-no-auth';
      };
}

export interface AppHandle {
  app: express.Express;
  /** Currently-active config (mutated by /config endpoints). Read for tests. */
  getConfig: () => AppConfigT;
  emitSentimentUpdate: (symbol: string, snapshot: SentimentSnapshot | null) => void;
}

/**
 * Build the Express app with injected dependencies. The production entrypoint
 * (`index.ts`) wires defaults; tests pass mocks.
 */
export function createApp(deps: AppDeps): AppHandle {
  const BRIEFING_SENTIMENT_MAX_AGE_MS = 60 * 60 * 1000;
  let cfg: AppConfigT = AppConfig.parse(deps.initialConfig);
  const mentionStore = deps.mentions ?? new MentionStore();
  const authToken = process.env.REGARDEDTRADER_AUTH_TOKEN?.trim() || null;
  const briefings = deps.briefings ?? new BriefingStore();

  // --- Market data registry (#91) ---
  // Rebuilt whenever the marketData config changes so route handlers always
  // see the active provider without restarting the server.
  let registry = createMarketDataRegistry(cfg.marketData, { fallback: deps.market });
  function rebuildRegistry(): void {
    registry = createMarketDataRegistry(cfg.marketData, { fallback: deps.market });
  }
  /** Resolve the live-quote source for the active provider, or fall back. */
  function resolveLiveQuoteSource(): LiveQuoteSource | null {
    if (registry.liveQuoteSource) {
      // Providers other than Yahoo return their own native shape; cast at
      // the boundary so `liveQuote.ts`'s `YahooQuoteLike` projector can
      // chew it. Each provider client is responsible for emitting a
      // structurally-compatible payload.
      return registry.liveQuoteSource as unknown as LiveQuoteSource;
    }
    return deps.liveQuoteSource ?? null;
  }

  function makeOrchestrator(): Orchestrator | null {
    const llm = deps.llmFromConfig(cfg);
    if (!llm) return null;
    return new Orchestrator(
      registry.client,
      llm,
      {
        maxLossUsd: cfg.risk.maxLossUsd,
        maxLegs: cfg.risk.maxLegs,
        forbidNakedShorts: cfg.risk.forbidNakedShorts,
        maxDte: cfg.risk.maxDte,
        accountSizeUsd: cfg.risk.accountSizeUsd,
        maxPctOfAccount: cfg.risk.maxPctOfAccount,
      },
      // Wire optional agents by default so /briefing includes TA + ranked
      // headline context whenever an LLM is configured.
      { technician: new Technician(llm), newsScout: new NewsScout(llm) },
      { briefings },
    );
  }

  let orchestrator = makeOrchestrator();
  const polling = new PollingCoordinator(
    deps.watchlist,
    () => registry.client,
    {
      quoteEveryMs: deps.polling?.quoteEveryMs,
      newsEveryMs: deps.polling?.newsEveryMs,
    },
  );
  polling.start();
  const paperStore = deps.paperStore ?? new PaperStore();
  function makePaperBroker(): PaperBroker {
    return new PaperBroker({ market: registry.client, store: paperStore });
  }

  type SentimentHealth = {
    lastSuccess: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
  };
  const sentimentHealth: Record<z.infer<typeof SentimentSource>, SentimentHealth> = {
    reddit: { lastSuccess: null, lastError: null, lastErrorAt: null },
    stocktwits: { lastSuccess: null, lastError: null, lastErrorAt: null },
    hn: { lastSuccess: null, lastError: null, lastErrorAt: null },
    cnn: { lastSuccess: null, lastError: null, lastErrorAt: null },
    'google-news': { lastSuccess: null, lastError: null, lastErrorAt: null },
    googleNewsOpinion: { lastSuccess: null, lastError: null, lastErrorAt: null },
  };

  function setSentimentSuccess(source: z.infer<typeof SentimentSource>, at: string): void {
    const cur = sentimentHealth[source];
    cur.lastSuccess = at;
    cur.lastError = null;
    cur.lastErrorAt = null;
  }

  function setSentimentError(source: z.infer<typeof SentimentSource>, err: unknown): void {
    const cur = sentimentHealth[source];
    cur.lastError = err instanceof Error ? err.message : String(err);
    cur.lastErrorAt = new Date().toISOString();
  }

  function tokenMatches(candidate: string | null | undefined): boolean {
    if (!authToken) return true;
    if (!candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(authToken);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  function authTokenFrom(req: express.Request): string | null {
    const header = req.header('authorization');
    if (header) {
      const v = header.trim();
      if (v.toLowerCase().startsWith('bearer ')) return v.slice(7).trim();
      return v;
    }
    const query = req.query.t;
    return typeof query === 'string' ? query : null;
  }

  function requireDashboardToken(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void {
    if (!authToken) {
      next();
      return;
    }
    if (!tokenMatches(authTokenFrom(req))) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }

  type SentimentSsePayload = {
    type: 'sentiment.update';
    symbol: string;
    snapshot: SentimentSnapshot | null;
    id: string;
    at: string;
  };
  const sseClients = new Set<express.Response>();

  function emitSentimentUpdate(symbol: string, snapshot: SentimentSnapshot | null): void {
    const payload: SentimentSsePayload = {
      type: 'sentiment.update',
      symbol,
      snapshot,
      id: randomUUID(),
      at: new Date().toISOString(),
    };
    const frame = `event: sentiment.update\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) client.write(frame);
  }

  async function readRecentSentimentSnapshot(
    symbol: string,
  ): Promise<SentimentSnapshot | undefined> {
    const latest = await mentionStore.readLatest(symbol);
    const snapshot = latest.sentiment;
    if (!snapshot) return undefined;
    const asOfMs = Date.parse(snapshot.asOf);
    if (!Number.isFinite(asOfMs)) return undefined;
    if (Date.now() - asOfMs > BRIEFING_SENTIMENT_MAX_AGE_MS) return undefined;
    return snapshot;
  }

  function makeValidator(): TickerValidator | null {
    const llm = deps.llmFromConfig(cfg);
    if (!llm) return null;
    return new TickerValidator({ webSearch: deps.webSearch, llm });
  }
  const calendar =
    deps.calendar ??
    new CalendarService({
      now: deps.now ? () => new Date(deps.now!()) : undefined,
    });

  async function tapePointForSymbol(symbol: string) {
    const [quote, history, news] = await Promise.all([
      registry.client.quote(symbol),
      registry.client.history(symbol, 60),
      registry.client.news(symbol),
    ]);
    const indicators = computeIndicators(history as OHLCV[]);
    const top = [...news].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0];
    return {
      symbol,
      last: quote.price,
      change: quote.change,
      changePercent: quote.changePercent,
      rsi: indicators.rsi14 ?? null,
      lastHeadline: top?.title ?? null,
      asOf: quote.asOf,
    };
  }

  // Process start timestamp for `GET /version` (issue #179). Captured once
  // at app creation so consumers can spot silent restarts.
  const startedAt = new Date().toISOString();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Runtime auth gate for dashboard-launched sessions (#18). All endpoints
  // except GET /health require the launch token.
  if (deps.auth?.mode === 'required') {
    const token = Buffer.from(deps.auth.token, 'utf8');
    const failWindowMs = 60_000;
    const maxFailsPerWindow = 20;
    const authFails = new Map<string, { count: number; resetAt: number }>();
    const now = deps.now ?? Date.now;

    function safeTokenEquals(candidate: string): boolean {
      const c = Buffer.from(candidate, 'utf8');
      return c.length === token.length && timingSafeEqual(c, token);
    }

    function isRateLimited(ip: string): boolean {
      const t = now();
      const cur = authFails.get(ip);
      if (!cur || t > cur.resetAt) {
        authFails.set(ip, { count: 0, resetAt: t + failWindowMs });
        return false;
      }
      return cur.count >= maxFailsPerWindow;
    }

    function markFailed(ip: string): void {
      const t = now();
      const cur = authFails.get(ip);
      if (!cur || t > cur.resetAt) {
        authFails.set(ip, { count: 1, resetAt: t + failWindowMs });
        return;
      }
      cur.count += 1;
      authFails.set(ip, cur);
    }

    app.use((req, res, next) => {
      if (req.method === 'GET' && req.path === '/health') {
        next();
        return;
      }

      const ip = req.socket.remoteAddress ?? req.ip ?? 'unknown';
      if (isRateLimited(ip)) {
        logger.warn(`[auth] rate-limited failed auth attempts from ${ip}`);
        res.status(429).json({ error: 'Too many failed auth attempts. Try again shortly.' });
        return;
      }

      const authHeader = req.headers.authorization;
      const bearer =
        typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice('Bearer '.length).trim()
          : '';
      const queryToken = typeof req.query.t === 'string' ? req.query.t : '';
      const candidate = bearer || queryToken;
      if (candidate && safeTokenEquals(candidate)) {
        next();
        return;
      }

      markFailed(ip);
      logger.warn(`[auth] unauthorized request from ${ip} to ${req.method} ${req.path}`);
      res.status(401).json({ error: 'Unauthorized dashboard session token.' });
    });
  }

  // Defence-in-depth Origin guard (AGENTS.md rule #1, issue #128):
  // hard-reject any cross-origin request whose `Origin` header is not a
  // loopback URL. Runs BEFORE the `cors` middleware so a non-loopback caller
  // never sees a permissive preflight reply. Same-origin requests (no
  // `Origin` header) and tooling like curl are unaffected.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && !isLoopbackOrigin(origin)) {
      res.status(403).json({
        error: 'Non-loopback Origin rejected. RegardedTrader is local-only.',
        hint: 'Open the dashboard via http://127.0.0.1 or http://localhost.',
      });
      return;
    }
    next();
  });
  app.use(
    cors(
      deps.auth?.mode === 'required'
        ? { origin: [deps.auth.dashboardOrigin] }
        : {
            origin: [
              /^http:\/\/127\.0\.0\.1:\d+$/,
              /^http:\/\/localhost:\d+$/,
              /^http:\/\/\[::1\]:\d+$/,
            ],
          },
    ),
  );

  // Dedicated version endpoint (issue #179). Deliberately separate from
  // `/health` so monitors, the web TopBar chip, and the CLI `regard
  // dashboard` connect-line can render a stable "srv X.Y.Z · core X.Y.Z"
  // string without touching AI-config state. The payload is validated
  // against the shared `ServerVersion` Zod schema so any drift between the
  // server and the CLI/web consumers surfaces immediately.
  app.get('/version', (_req, res) => {
    const payload: import('@regardedtrader/core').ServerVersion = {
      server: SERVER_VERSION,
      core: CORE_VERSION,
      node: process.versions.node,
      api: SERVER_API_VERSION,
      startedAt,
    };
    res.json(ServerVersion.parse(payload));
  });

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      name: 'regardedtrader-server',
      // Sourced from packages/server/package.json at module load (issue
      // #180). Do NOT hardcode a literal here — use SERVER_VERSION so a
      // future package.json bump stays in sync automatically.
      version: SERVER_VERSION,
      aiConfigured: orchestrator !== null,
      activeProvider: cfg.activeProvider,
      sentimentSources: sentimentHealth,
    });
  });

  // --- Market data ---

  app.get('/quote/:symbol', async (req, res, next) => {
    try {
      const symbol = Ticker.parse(String(req.params.symbol).toUpperCase());
      res.json(await registry.client.quote(symbol));
    } catch (e) {
      next(e);
    }
  });

  // --- Live quote (#81, made provider-aware in #91) ---
  // Tiny in-memory cache to coalesce bursts from multiple clients, plus an
  // in-flight dedupe map so N concurrent requests for the same symbol only
  // produce one upstream call. On upstream failure (e.g. Yahoo HTTP 429 /
  // "Too Many Requests"), we fall back to a recent cached value if we have
  // one — better to serve a slightly-stale quote than to surface a noisy
  // error to every poller in the UI.
  //
  // The actual upstream is resolved per-request from the market-data
  // registry so swapping providers in Settings takes effect immediately
  // without restarting the server.
  {
    const cache = new Map<string, { at: number; value: LiveQuote }>();
    const inflight = new Map<string, Promise<LiveQuote>>();
    const CACHE_TTL_MS = 5_000;
    const STALE_FALLBACK_MS = 5 * 60_000;
    const now = deps.now ?? Date.now;

    app.get('/tickers/:symbol/quote', async (req, res, next) => {
      try {
        const symbol = Ticker.parse(String(req.params.symbol).toUpperCase());
        const source = resolveLiveQuoteSource();
        if (!source) {
          res.status(503).json({
            error: 'No market-data provider configured',
            hint: 'Open Settings → Market Data and add a provider (Finnhub recommended).',
          });
          return;
        }
        const cached = cache.get(symbol);
        const t = now();
        if (cached && t - cached.at < CACHE_TTL_MS) {
          res.json(cached.value);
          return;
        }
        let pending = inflight.get(symbol);
        if (!pending) {
          pending = (async () => {
            const fresh = await liveQuote(source, symbol);
            return QuoteSchema.parse(fresh);
          })();
          inflight.set(symbol, pending);
          // Always clear the in-flight slot so a future failure doesn't
          // permanently poison the symbol.
          pending.finally(() => {
            if (inflight.get(symbol) === pending) inflight.delete(symbol);
          }).catch(() => {
            // The actual rejection is observed below via `await pending`;
            // swallow it on this side-chain to avoid an unhandled rejection.
          });
        }
        try {
          const parsed = await pending;
          cache.set(symbol, { at: now(), value: parsed });
          res.json(parsed);
        } catch (e) {
          // Upstream fetch failed (commonly Yahoo 429). Serve the last good
          // value if we have one and it's not absurdly old.
          const fallback = cache.get(symbol);
          if (fallback && now() - fallback.at < STALE_FALLBACK_MS) {
            res.setHeader('X-Quote-Stale', '1');
            res.json(fallback.value);
            return;
          }
          throw e;
        }
      } catch (e) {
        next(e);
      }
    });
  }

  app.get('/history/:symbol', async (req, res, next) => {
    try {
      const symbol = Ticker.parse(String(req.params.symbol).toUpperCase());
      const days = Math.min(Number(req.query.days ?? 180), 365 * 5);
      res.json(await registry.client.history(symbol, days));
    } catch (e) {
      next(e);
    }
  });

  app.get('/options/:symbol', async (req, res, next) => {
    try {
      const symbol = Ticker.parse(String(req.params.symbol).toUpperCase());
      const expiry = typeof req.query.expiry === 'string' ? req.query.expiry : undefined;
      res.json(await registry.client.optionsChain(symbol, expiry));
    } catch (e) {
      next(e);
    }
  });

  // --- Tickers (M1) ---

  const ValidateBody = z.object({
    symbols: z.array(z.string().min(1)).min(1).max(20),
    refresh: z.boolean().optional().default(false),
  });

  const ResolveQuery = z.object({
    q: z.string().min(1),
    refresh: z.coerce.boolean().optional().default(false),
  });

  const AddTickerBody = z
    .object({
      symbol: z.string().min(1).optional(),
      query: z.string().min(1).optional(),
      refresh: z.boolean().optional().default(false),
    })
    .refine((v) => Boolean(v.symbol?.trim() || v.query?.trim()), {
      message: 'Provide either `symbol` or `query`.',
      path: ['symbol'],
    });

  async function getFreshCachedProfile(raw: string, refresh: boolean) {
    if (refresh) return null;
    const candidate = raw.trim().toUpperCase();
    try {
      const symbol = Ticker.parse(candidate);
      const cached = await deps.watchlist.get(symbol);
      if (cached && !deps.watchlist.isStale(cached)) return cached.profile;
      return null;
    } catch {
      // Non-ticker query (e.g. company name). Skip direct watchlist hit.
      return null;
    }
  }

  type ResolveMode = 'symbol' | 'query' | 'auto';
  type SearchHit = Awaited<ReturnType<WebSearch['search']>>[number];
  const SYMBOL_SHAPE = /^[A-Z.\-]{1,10}$/;

  function pickLikelySymbol(hit: SearchHit): string | null {
    const title = hit.title.toUpperCase();
    const snippet = hit.snippet.toUpperCase();
    const text = `${title} ${snippet}`;

    const paren = text.match(/\(([A-Z.\-]{1,10})\)/);
    if (paren?.[1] && SYMBOL_SHAPE.test(paren[1])) return paren[1];

    const exchange = text.match(/\b(?:NASDAQ|NYSE|AMEX|ARCA)\s*[:\-]\s*([A-Z.\-]{1,10})\b/);
    if (exchange?.[1] && SYMBOL_SHAPE.test(exchange[1])) return exchange[1];

    const stop = new Set([
      'STOCK',
      'SHARES',
      'PRICE',
      'QUOTE',
      'INC',
      'CORP',
      'ETF',
      'NYSE',
      'NASDAQ',
      'COMPANY',
      'HOLDINGS',
    ]);
    const words = text.match(/\b[A-Z]{1,5}\b/g) ?? [];
    for (const w of words) {
      if (!stop.has(w) && SYMBOL_SHAPE.test(w)) return w;
    }
    return null;
  }

  async function normalizeResolveInput(raw: string, mode: ResolveMode): Promise<string> {
    const trimmed = raw.trim();
    const upper = trimmed.toUpperCase();
    if (trimmed.length === 0) return upper;

    if (mode === 'symbol') return upper;
    if (mode === 'auto' && SYMBOL_SHAPE.test(upper) && trimmed === upper) return upper;

    try {
      const hits = await deps.webSearch.search(`${trimmed} stock ticker symbol`, { limit: 5 });
      for (const hit of hits) {
        const picked = pickLikelySymbol(hit);
        if (picked) return picked;
      }
    } catch {
      // Fall back to the raw uppercased input.
    }
    return upper;
  }

  app.post('/tickers/validate', async (req, res, next) => {
    try {
      const body = ValidateBody.parse(req.body);
      const validator = makeValidator();
      const results: ValidationResult[] = [];

      for (const raw of body.symbols) {
        const cached = await getFreshCachedProfile(raw, body.refresh);
        if (cached) {
          results.push({ ok: true, profile: cached, cached: true });
          continue;
        }
        if (!validator) {
          res.status(503).json({
            error: 'AI provider not configured',
            hint: 'Run `regard config` (CLI) or open Settings in the dashboard.',
          });
          return;
        }
        const r = await validator.validate(raw.trim());
        if (r.ok) await deps.watchlist.upsert(r.profile);
        results.push(r);
      }
      res.json({ results });
    } catch (e) {
      next(e);
    }
  });

  // Fast ticker add: shape-check + yahoo-finance2 (crumb-aware), no LLM or web search.
  // Returns the same ValidationResult wire shape as /tickers/validate so the
  // web TickerIntake can use it as a drop-in.
  app.post('/tickers/quick-add', async (req, res, next) => {
    try {
      const body = ValidateBody.parse(req.body);
      const results: ValidationResult[] = [];

      for (const raw of body.symbols) {
        const symbol = raw.trim().toUpperCase();

        // 1. Check cache first (same TTL as full validate)
        const cached = await getFreshCachedProfile(symbol, body.refresh);
        if (cached) {
          results.push({ ok: true, profile: cached, cached: true });
          continue;
        }

        // 2. Shape check
        if (!/^[A-Z.\-]{1,10}$/.test(symbol)) {
          results.push({
            ok: false,
            symbol,
            error: `"${raw}" is not a valid ticker shape (1-10 chars, A-Z . - only).`,
            suggestions: [],
          });
          continue;
        }

        // 3. yahoo-finance2 quote — crumb-aware, lightweight, no LLM
        let name = symbol;
        let exchange = 'Unknown';
        let sector = 'Unknown';
        let industry = 'Unknown';
        let description = '';

        try {
          const yf = await import('yahoo-finance2');
          const q = await yf.default.quote(symbol);

          if (!q || q.quoteType !== 'EQUITY') {
            results.push({
              ok: false,
              symbol,
              error: q
                ? `"${symbol}" is not a US equity (type: ${q.quoteType ?? 'unknown'}).`
                : `"${symbol}" was not found on Yahoo Finance. Check the ticker and try again.`,
              suggestions: [],
            });
            continue;
          }

          name = q.longName ?? q.shortName ?? symbol;
          exchange = q.fullExchangeName ?? q.exchangeName ?? 'Unknown';
          // sector/industry not available from quote endpoint; filled in on briefing
          description = `${name} — see briefing for full profile.`;
        } catch {
          results.push({
            ok: false,
            symbol,
            error: `"${symbol}" was not found on Yahoo Finance. Check the ticker and try again.`,
            suggestions: [],
          });
          continue;
        }

        const now = new Date().toISOString();
        const fullProfile = {
          symbol,
          name: name || symbol,
          exchange: exchange || 'Unknown',
          sector: sector || 'Unknown',
          industry: industry || 'Unknown',
          description: (description as string) || `${name} (${symbol})`,
          sources: [`https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`],
          validatedAt: now,
        };

        await deps.watchlist.upsert(fullProfile);
        results.push({ ok: true, profile: fullProfile, cached: false });
      }

      res.json({ results });
    } catch (e) {
      next(e);
    }
  });

  // Compatibility endpoint for issue #16 clients that want a one-shot
  // resolve preview without mutating the stored watchlist.
  app.get('/tickers/resolve', async (req, res, next) => {
    try {
      const { q, refresh } = ResolveQuery.parse(req.query);
      const candidate = await normalizeResolveInput(q, 'auto');
      const cached = await getFreshCachedProfile(candidate, refresh);
      if (cached) {
        res.json(cached);
        return;
      }
      const validator = makeValidator();
      if (!validator) {
        res.status(503).json({
          error: 'AI provider not configured',
          hint: 'Run `regard config` (CLI) or open Settings in the dashboard.',
        });
        return;
      }
      const result = await validator.validate(candidate);
      if (!result.ok) {
        res.status(404).json({
          error: result.error,
          symbol: result.symbol,
          suggestions: result.suggestions,
        });
        return;
      }
      res.json(result.profile);
    } catch (e) {
      next(e);
    }
  });

  // Compatibility alias for issue #16 clients. Mirrors POST /tickers/validate
  // for a single symbol/query and persists successful resolutions.
  app.post('/tickers', async (req, res, next) => {
    try {
      const body = AddTickerBody.parse(req.body);
      const raw = (body.symbol ?? body.query ?? '').trim();
      const mode: ResolveMode = body.symbol ? 'symbol' : 'query';
      const candidate = await normalizeResolveInput(raw, mode);
      const cached = await getFreshCachedProfile(candidate, body.refresh);
      if (cached) {
        res.json({ ok: true, profile: cached, cached: true });
        return;
      }
      const validator = makeValidator();
      if (!validator) {
        res.status(503).json({
          error: 'AI provider not configured',
          hint: 'Run `regard config` (CLI) or open Settings in the dashboard.',
        });
        return;
      }
      const result = await validator.validate(candidate);
      if (!result.ok) {
        res.status(404).json(result);
        return;
      }
      await deps.watchlist.upsert(result.profile);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  app.get('/tickers', async (_req, res, next) => {
    try {
      const list: WatchlistEntry[] = await deps.watchlist.list();
      res.json({ entries: list });
    } catch (e) {
      next(e);
    }
  });

  app.delete('/tickers/:sym', async (req, res, next) => {
    try {
      const sym = Ticker.parse(req.params.sym.toUpperCase());
      const removed = await deps.watchlist.remove(sym);
      res.json({ ok: true, removed });
    } catch (e) {
      next(e);
    }
  });

  // --- Polling subsystem (issue #27 parity) ---
  app.get('/polling/status', (_req, res) => {
    res.json({
      paused: polling.status().every((j) => j.state === 'paused'),
      jobs: polling.status(),
    });
  });

  app.post('/polling/pause', (_req, res) => {
    polling.pause();
    res.json({ ok: true, paused: true, jobs: polling.status() });
  });

  app.post('/polling/resume', (_req, res) => {
    polling.resume();
    res.json({ ok: true, paused: false, jobs: polling.status() });
  });

  app.get('/polling/watch', async (req, res, next) => {
    try {
      const rawSymbols =
        typeof req.query.symbols === 'string' && req.query.symbols.trim().length > 0
          ? req.query.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
          : (await deps.watchlist.list()).map((e) => e.profile.symbol.toUpperCase());

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      send('ready', { symbols: rawSymbols });
      const sendCurrent = async () => {
        if (polling.isPaused) return;
        await Promise.all(
          rawSymbols.map(async (symbol) => {
            const point = await tapePointForSymbol(symbol);
            send('tape', point);
          }),
        );
      };
      await sendCurrent();

      const unsubscribe = polling.subscribe((evt) => {
        if (evt.type !== 'tape') return;
        if (!rawSymbols.includes(evt.data.symbol)) return;
        send('tape', evt.data);
      });
      const directRefresh = setInterval(() => {
        void sendCurrent();
      }, 15_000);
      const keepAlive = setInterval(() => {
        res.write(': ping\n\n');
      }, 20_000);
      req.on('close', () => {
        clearInterval(directRefresh);
        clearInterval(keepAlive);
        unsubscribe();
      });
    } catch (e) {
      next(e);
    }
  });

  app.get('/polling/tail/:symbol', async (req, res, next) => {
    try {
      const symbol = Ticker.parse(req.params.symbol.toUpperCase());
      const includeQuotes = String(req.query.quotes ?? 'false').toLowerCase() === 'true';
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      send('ready', { symbol, includeQuotes });
      const seen = new Set<string>();
      const pollTail = async () => {
        if (polling.isPaused) return;
        const [news, quote, history] = await Promise.all([
          registry.client.news(symbol),
          includeQuotes ? registry.client.quote(symbol) : Promise.resolve(null),
          includeQuotes ? registry.client.history(symbol, 60) : Promise.resolve([]),
        ]);
        for (const item of [...news]
          .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))
          .slice(-10)) {
          const key = `${item.url}`;
          if (seen.has(key)) continue;
          seen.add(key);
          send('news', {
            symbol,
            title: item.title,
            url: item.url,
            source: item.source,
            publishedAt: item.publishedAt,
          });
        }
        if (quote) {
          const indicators = computeIndicators(history as OHLCV[]);
          send('quote', {
            symbol,
            price: quote.price,
            change: quote.change,
            changePercent: quote.changePercent,
            rsi: indicators.rsi14 ?? null,
            asOf: quote.asOf,
          });
        }
      };
      await pollTail();

      const latest = polling.getTape([symbol])[0];
      if (latest) send('tape', latest);

      const unsubscribe = polling.subscribe((evt) => {
        if (evt.type === 'news' && evt.data.symbol === symbol) {
          send('news', evt.data);
        }
        if (includeQuotes && evt.type === 'quote' && evt.data.symbol === symbol) {
          send('quote', evt.data);
        }
      });
      const keepAlive = setInterval(() => {
        res.write(': ping\n\n');
      }, 20_000);
      const directRefresh = setInterval(() => {
        void pollTail();
      }, includeQuotes ? 15_000 : 30_000);
      req.on('close', () => {
        clearInterval(directRefresh);
        clearInterval(keepAlive);
        unsubscribe();
      });
    } catch (e) {
      next(e);
    }
  });

  // --- Sentiment / mentions (#39) ---
  const DateParam = z
    .string()
    .min(1)
    .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Expected an ISO-8601 datetime.' });
  const SentimentRangeQuery = z.object({
    since: DateParam.optional(),
    until: DateParam.optional(),
  });
  const MentionsQuery = z.object({
    source: SentimentSource.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional().default(100),
    since: DateParam.optional(),
  });

  app.get('/events', requireDashboardToken, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    sseClients.add(res);
    const keepAlive = setInterval(() => {
      res.write(`: keepalive ${Date.now()}\n\n`);
    }, 20_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
  });

  app.get('/sentiment/:symbol/latest', requireDashboardToken, async (req, res, next) => {
    try {
      const symbol = Ticker.parse(String(req.params.symbol).toUpperCase());
      const latest = await mentionStore.readLatest(symbol);
      const snapshot = latest.sentiment ?? null;
      if (!snapshot) {
        res.status(404).json({ error: `No sentiment snapshot found for ${symbol}.` });
        return;
      }
      res.json(snapshot);
    } catch (e) {
      next(e);
    }
  });

  app.get('/sentiment/:symbol', requireDashboardToken, async (req, res, next) => {
    try {
      const symbol = Ticker.parse(String(req.params.symbol).toUpperCase());
      const q = SentimentRangeQuery.parse(req.query);
      const since = q.since ? new Date(q.since) : undefined;
      const until = q.until ? new Date(q.until) : undefined;
      const items: SentimentSnapshot[] = [];
      for await (const snap of mentionStore.readSentiment(symbol, since, until)) {
        items.push(snap);
      }
      items.sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
      res.json({ symbol, items });
    } catch (e) {
      next(e);
    }
  });

  app.get('/mentions/:symbol', requireDashboardToken, async (req, res, next) => {
    try {
      const symbol = Ticker.parse(String(req.params.symbol).toUpperCase());
      const q = MentionsQuery.parse(req.query);
      const since = q.since ? new Date(q.since) : undefined;
      const items: Array<MentionItem | ScoredMention> = [];
      for await (const item of mentionStore.readMentions(symbol, since, undefined)) {
        if (q.source && item.source !== q.source) continue;
        items.push(item);
      }
      items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
      const limited = items.slice(0, q.limit);
      for (const source of SentimentSource.options) {
        try {
          const latest = limited
            .filter((row) => row.source === source)
            .reduce<string | null>((acc, row) => {
              const ts = row.fetchedAt || row.publishedAt;
              if (!acc) return ts;
              return Date.parse(ts) > Date.parse(acc) ? ts : acc;
            }, null);
          if (latest) setSentimentSuccess(source, latest);
        } catch (e) {
          setSentimentError(source, e);
        }
      }
      res.json({ symbol, items: limited });
    } catch (e) {
      next(e);
    }
  });

  // --- Calendar ---
  const CalendarWindowQuery = z.object({
    from: z.string().optional(),
    days: z.coerce.number().int().min(1).max(90).optional().default(14),
  });
  const CalendarEarningsQuery = z.object({
    past: z.coerce.boolean().optional().default(false),
    upcoming: z.coerce.boolean().optional().default(true),
  });
  const CalendarRefreshBody = z.object({
    holidays: z.boolean().optional().default(false),
    earnings: z.boolean().optional().default(false),
  });

  app.get('/calendar/events', async (req, res, next) => {
    try {
      const q = CalendarWindowQuery.parse(req.query);
      const fromEt =
        q.from && q.from !== 'today'
          ? z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(q.from)
          : todayEt();
      const watch = await deps.watchlist.list();
      const symbols = watch.map((w) => w.profile.symbol);
      await calendar.maybeRefreshForRead(symbols);
      const window = await calendar.getWindow({
        fromEt,
        days: q.days,
        symbols,
      });
      res.json(window);
    } catch (e) {
      next(e);
    }
  });

  app.get('/calendar/earnings/:symbol', async (req, res, next) => {
    try {
      const symbol = Ticker.parse(req.params.symbol.toUpperCase());
      const known = await deps.watchlist.get(symbol);
      if (!known) {
        res.status(422).json({
          error: `Unknown ticker "${symbol}". Add it first with \`regard add ${symbol}\`.`,
          hint: 'POST /tickers/validate or `regard add <SYM>`',
        });
        return;
      }
      const q = CalendarEarningsQuery.parse(req.query);
      const includePast = q.past;
      const includeUpcoming = q.upcoming || !q.past;
      await calendar.maybeRefreshForRead([symbol]);
      const events = await calendar.getSymbolEarnings({
        symbol,
        includePast,
        includeUpcoming,
      });
      res.json({ symbol, events });
    } catch (e) {
      next(e);
    }
  });

  app.post('/calendar/refresh', async (req, res, next) => {
    try {
      const body = CalendarRefreshBody.parse(req.body ?? {});
      const watch = await deps.watchlist.list();
      const out = await calendar.refreshManually({
        holidays: body.holidays,
        earnings: body.earnings,
        symbols: watch.map((w) => w.profile.symbol),
      });
      if (out.skipped && out.skipped.length > 0 && !out.holidays && !out.earnings) {
        const retryAfterMs = Math.max(...out.skipped.map((s) => s.retryAfterMs));
        res.setHeader('Retry-After', Math.max(1, Math.ceil(retryAfterMs / 1000)).toString());
        res.status(429).json(out);
        return;
      }
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  app.get('/calendar/status', (_req, res) => {
    res.json(calendar.status());
  });

  // Compatibility endpoint used by the web CalendarStrip. Market-only list.
  app.get('/calendar/upcoming', async (req, res, next) => {
    try {
      const q = CalendarWindowQuery.parse(req.query);
      const fromEt = todayEt();
      await calendar.maybeRefreshForRead([]);
      const window = await calendar.getWindow({ fromEt, days: q.days, symbols: [] });
      const events = window.events
        .filter((ev) => ev.kind === 'market_holiday' || ev.kind === 'market_early_close')
        .map((ev) => ({
          dateOffset: Math.max(
            0,
            Math.floor(
              (new Date(`${toEtDateKey(ev.startUtc)}T00:00:00.000Z`).getTime() -
                new Date(`${fromEt}T00:00:00.000Z`).getTime()) /
                (24 * 60 * 60 * 1000),
            ),
          ),
          kind: ev.kind,
          title: ev.title,
        }));
      res.json({ today: fromEt, events });
    } catch (e) {
      next(e);
    }
  });

  // --- AI ---

  function requireOrchestrator(res: express.Response): Orchestrator | null {
    if (!orchestrator) {
      res.status(503).json({
        error: 'AI provider not configured',
        hint: 'Run `regard config` (CLI) or open Settings in the dashboard.',
      });
      return null;
    }
    return orchestrator;
  }

  async function requireKnownSymbol(
    res: express.Response,
    symbol: string,
  ): Promise<WatchlistEntry | null> {
    const entry = await deps.watchlist.get(symbol);
    if (!entry) {
      res.status(422).json({
        error: `Unknown ticker "${symbol}". Add it first with \`regard add ${symbol}\` or via the home screen.`,
        hint: 'POST /tickers/validate or `regard add <SYM>`',
      });
      return null;
    }
    return entry;
  }

  // Technician agent surface (issue #74). Standalone endpoint so the CLI
  // `regard tech <SYM>` and the web `Chart` tab can render TA commentary
  // without rerunning the full briefing pipeline.
  app.get('/technician/:symbol', async (req, res, next) => {
    try {
      const llm = deps.llmFromConfig(cfg);
      if (!llm) {
        res.status(503).json({ error: 'AI provider not configured' });
        return;
      }
      const symbol = Ticker.parse(req.params.symbol.toUpperCase());
      const known = await requireKnownSymbol(res, symbol);
      if (!known) return;
      res.json(await Technician.fromMarket(llm, registry.client, symbol));
    } catch (e) {
      next(e);
    }
  });

  const BriefingHistoryQuery = z.object({
    limit: z.coerce.number().int().positive().max(200).optional().default(20),
  });

  app.get('/briefing/:symbol/history', async (req, res, next) => {
    try {
      const symbol = Ticker.parse(req.params.symbol.toUpperCase());
      const { limit } = BriefingHistoryQuery.parse(req.query);
      res.json({
        symbol,
        items: await briefings.listBriefings(symbol, limit),
      });
    } catch (e) {
      next(e);
    }
  });

  // NewsScout endpoint (issue #75). Returns ranked traditional headlines with
  // model-assigned relevance/materiality scores, shared by CLI + web.
  app.get('/news/:symbol', async (req, res, next) => {
    try {
      const llm = deps.llmFromConfig(cfg);
      if (!llm) {
        res.status(503).json({ error: 'AI provider not configured' });
        return;
      }
      const symbol = Ticker.parse(req.params.symbol.toUpperCase());
      const known = await requireKnownSymbol(res, symbol);
      if (!known) return;
      const news = await registry.client.news(symbol).catch(() => []);
      const scout = new NewsScout(llm);
      res.json(await scout.bundle({ symbol, news }));
    } catch (e) {
      next(e);
    }
  });

  app.get('/briefing/:symbol', async (req, res, next) => {
    try {
      const candidate = req.params.symbol;
      if (looksLikeBriefingId(candidate)) {
        const stored = await briefings.getBriefing(candidate);
        if (!stored) {
          res.status(404).json({ error: `briefing "${candidate}" not found` });
          return;
        }
        res.json(stored.briefing);
        return;
      }
      const o = requireOrchestrator(res);
      if (!o) return;
      const symbol = Ticker.parse(candidate.toUpperCase());
      const known = await requireKnownSymbol(res, symbol);
      if (!known) return;
      const sentimentSnapshot = await readRecentSentimentSnapshot(symbol);
      let nextEarnings:
        | { date: string; daysUntil: number; title: string; startUtc: string }
        | undefined;
      try {
        const upcoming = await calendar.getSymbolEarnings({
          symbol,
          includePast: false,
          includeUpcoming: true,
        });
        const next = upcoming[0];
        if (next) {
          const startMs = Date.parse(next.startUtc);
          if (Number.isFinite(startMs)) {
            const nowMs = deps.now ? deps.now() : Date.now();
            const daysUntil = Math.floor((startMs - nowMs) / (24 * 60 * 60 * 1000));
            if (daysUntil >= 0 && daysUntil <= 14) {
              nextEarnings = {
                date: next.startUtc.slice(0, 10),
                startUtc: next.startUtc,
                title: next.title,
                daysUntil,
              };
            }
          }
        }
      } catch {
        // Best-effort enrichment: briefing should still render if calendar refresh fails.
      }
      res.json(
        await o.briefing(symbol, {
          sentimentSnapshot,
          ...(nextEarnings ? { nextEarnings } : {}),
        }),
      );
    } catch (e) {
      next(e);
    }
  });

  // POST variant (#138): allow the strategist pipeline (#126) to be invoked
  // from the HTTP surface. Body is Zod-validated and rejects unknown fields
  // so clients can't smuggle in extra params. With an empty body this
  // collapses to the same behaviour as GET (analyst-only).
  app.post('/briefing/:symbol', async (req, res, next) => {
    try {
      const o = requireOrchestrator(res);
      if (!o) return;
      const symbol = Ticker.parse(req.params.symbol.toUpperCase());
      const known = await requireKnownSymbol(res, symbol);
      if (!known) return;
      const body = BriefingRequest.parse(req.body ?? {});
      const sentimentSnapshot = await readRecentSentimentSnapshot(symbol);
      const nowMs = deps.now ? deps.now() : Date.now();
      let nextEarnings:
        | { date: string; daysUntil: number; title: string; startUtc: string }
        | undefined;
      try {
        const upcoming = await calendar.getSymbolEarnings({
          symbol,
          includePast: false,
          includeUpcoming: true,
        });
        const next = upcoming[0];
        if (next) {
          const startMs = Date.parse(next.startUtc);
          if (Number.isFinite(startMs)) {
            const daysUntil = Math.floor((startMs - nowMs) / (24 * 60 * 60 * 1000));
            if (daysUntil >= 0 && daysUntil <= 14) {
              nextEarnings = {
                date: next.startUtc.slice(0, 10),
                startUtc: next.startUtc,
                title: next.title,
                daysUntil,
              };
            }
          }
        }
      } catch {
        // Best-effort enrichment: briefing should still render if calendar refresh fails.
      }
      res.json(
        await o.briefing(symbol, {
          ...body,
          sentimentSnapshot,
          ...(nextEarnings ? { nextEarnings } : {}),
        }),
      );
    } catch (e) {
      next(e);
    }
  });

  const PlansReq = z.object({
    symbol: Ticker,
    thesis: z.string().min(3),
    maxLossUsd: z.number().positive().max(100_000),
    expiry: z.string().optional(),
  });

  app.post('/plans', async (req, res, next) => {
    try {
      const o = requireOrchestrator(res);
      if (!o) return;
      const body = PlansReq.parse({ ...req.body, symbol: String(req.body.symbol).toUpperCase() });
      const known = await requireKnownSymbol(res, body.symbol);
      if (!known) return;
      const out = await o.proposePlans(body);
      const stamped = out.plans.map((candidate, i) => ({
        ...candidate,
        id: makePlanId(body.symbol, i),
      }));
      await paperStore.cachePlans(
        body.symbol,
        stamped.map((c) => ({ id: c.id!, plan: c.plan })),
      );
      // Validate the wire payload before emitting (issue #77). Each plan's
      // `notes` carries the canonical disclaimer via `attachRiskGraph`; this
      // .parse() defends against future refactors that might drop it.
      res.json(PlansResponse.parse({ ...out, plans: stamped }));
    } catch (e) {
      next(e);
    }
  });

  // --- Paper trading (simulated only) ---
  const PaperSubmitBody = z.object({
    paper: z.boolean(),
    planId: z.string().min(1),
    plan: TradePlan.optional(),
  });

  app.post('/paper/orders', async (req, res, next) => {
    try {
      const body = PaperSubmitBody.parse(req.body ?? {});
      if (body.paper !== true) {
        res.status(400).json({ error: 'Paper mode must be explicitly enabled (paper=true).' });
        return;
      }
      const plan = body.plan ?? (await paperStore.findPlan(body.planId));
      if (!plan) {
        res.status(404).json({
          error: `Unknown planId "${body.planId}".`,
          hint: 'Generate plans first via `regard plan <SYM>` or POST /plans.',
        });
        return;
      }
      const fill = await makePaperBroker().submit({
        mode: 'paper',
        planId: body.planId,
        plan,
      });
      res.json(fill);
    } catch (e) {
      next(e);
    }
  });

  app.get('/paper/orders', async (_req, res, next) => {
    try {
      const orders = await paperStore.listOrders();
      res.json({ orders });
    } catch (e) {
      next(e);
    }
  });

  app.get('/paper/positions', async (_req, res, next) => {
    try {
      const positions = await paperStore.listPositions();
      res.json({ positions });
    } catch (e) {
      next(e);
    }
  });

  app.get('/paper/plans', async (_req, res, next) => {
    try {
      const plans = await paperStore.listPlans();
      res.json({ plans });
    } catch (e) {
      next(e);
    }
  });

  // --- Config (local-only; safe surface) ---

  app.get('/config', async (_req, res) => {
    res.json(redactConfig(cfg));
  });

  app.put('/config', async (req, res, next) => {
    try {
      const next = AppConfig.parse(req.body);
      await saveConfig(next);
      cfg = next;
      orchestrator = makeOrchestrator();
      rebuildRegistry();
      res.json({ ok: true, aiConfigured: orchestrator !== null, config: redactConfig(cfg) });
    } catch (e) {
      next(e);
    }
  });

  // --- Risk caps editor (#152, CLI/web parity) ---
  // Accepts the same Zod shape as `AppConfig.risk` and hot-applies the new
  // caps to the in-process Orchestrator by rebuilding it. No restart needed;
  // `RiskOfficer` is constructed inside `makeOrchestrator()` from `cfg.risk`.
  app.post('/config/risk', async (req, res, next) => {
    try {
      const risk = RiskConfig.parse(req.body);
      cfg.risk = risk;
      await saveConfig(cfg);
      orchestrator = makeOrchestrator();
      res.json({ ok: true, aiConfigured: orchestrator !== null, config: redactConfig(cfg) });
    } catch (e) {
      next(e);
    }
  });

  // --- Market-data providers (#91) ---

  const MarketProviderUpsert = z.object({
    id: z.string().min(1),
    provider: MarketDataProviderConfig,
  });

  app.post('/config/market-data/providers', async (req, res, next) => {
    try {
      const { id, provider } = MarketProviderUpsert.parse(req.body);
      cfg.marketData.providers[id] = provider;
      cfg.marketData.activeProvider = id; // always activate the newly configured provider
      await saveConfig(cfg);
      rebuildRegistry();
      res.json({
        ok: true,
        activeMarketProvider: cfg.marketData.activeProvider,
        config: redactConfig(cfg),
      });
    } catch (e) {
      next(e);
    }
  });

  app.delete('/config/market-data/providers/:id', async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!cfg.marketData.providers[id]) {
        res.status(404).json({ error: `market-data provider "${id}" not found` });
        return;
      }
      delete cfg.marketData.providers[id];
      if (cfg.marketData.activeProvider === id) cfg.marketData.activeProvider = null;
      await saveConfig(cfg);
      rebuildRegistry();
      res.json({
        ok: true,
        activeMarketProvider: cfg.marketData.activeProvider,
        config: redactConfig(cfg),
      });
    } catch (e) {
      next(e);
    }
  });

  app.post('/config/market-data/activate', async (req, res, next) => {
    try {
      const { id } = z.object({ id: z.string().min(1).nullable() }).parse(req.body);
      if (id !== null && !cfg.marketData.providers[id]) {
        res.status(404).json({ error: `market-data provider "${id}" not found` });
        return;
      }
      cfg.marketData.activeProvider = id;
      await saveConfig(cfg);
      rebuildRegistry();
      res.json({
        ok: true,
        activeMarketProvider: cfg.marketData.activeProvider,
        config: redactConfig(cfg),
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Probe the active market-data provider: fetches a quote for AAPL and
   * reports success/failure. Used by the Settings panel to give the user
   * feedback that their key works.
   */
  app.post('/config/market-data/test', async (req, res) => {
    const bodyParsed = z.object({
      symbol: z.string().optional(),
      providerId: z.string().optional(),
    }).safeParse(req.body);
    const probeSymbol = (bodyParsed.success && bodyParsed.data.symbol)
      ? bodyParsed.data.symbol.toUpperCase()
      : 'AAPL';
    const testProviderId = bodyParsed.success ? bodyParsed.data.providerId : undefined;

    let source: LiveQuoteSource | null;
    let resolvedId: string | null;

    if (testProviderId) {
      const testProvCfg = cfg.marketData.providers[testProviderId];
      if (!testProvCfg) {
        res.json({ ok: false, error: `Market-data provider "${testProviderId}" not found` });
        return;
      }
      const testReg = createMarketDataRegistry(
        { providers: { [testProviderId]: testProvCfg }, activeProvider: testProviderId },
        { fallback: deps.market },
      );
      source = testReg.liveQuoteSource != null
        ? (testReg.liveQuoteSource as unknown as LiveQuoteSource)
        : (deps.liveQuoteSource ?? null);
      resolvedId = testProviderId;
    } else {
      source = resolveLiveQuoteSource();
      resolvedId = registry.activeId;
    }

    if (!source) {
      res.json({ ok: false, error: 'No market-data provider configured. Add one in Settings → Market Data.' });
      return;
    }
    try {
      const raw = (await source(probeSymbol)) as YahooQuoteLike;
      res.json({
        ok: true,
        provider: resolvedId,
        symbol: probeSymbol,
        price: raw.regularMarketPrice ?? null,
      });
    } catch (e) {
      const rawMsg = (e as Error).message;
      let friendly = rawMsg;
      if (/too many requests|429|rate[\s-]?limit/i.test(rawMsg)) {
        friendly =
          'Yahoo Finance is rate-limited (HTTP 429). This unofficial API throttles heavy usage. ' +
          'Switch to Finnhub for reliable real-time data.';
      }
      // Always return 200 — success/failure is in the `ok` field, not the HTTP status.
      res.json({ ok: false, error: friendly });
    }
  });

  const ProviderUpsert = z.object({ id: z.string().min(1), provider: AiProvider });

  app.post('/config/providers', async (req, res, next) => {
    try {
      const { id, provider } = ProviderUpsert.parse(req.body);
      cfg.providers[id] = provider;
      cfg.activeProvider = id;
      await saveConfig(cfg);
      orchestrator = makeOrchestrator();
      res.json({ ok: true, aiConfigured: orchestrator !== null, config: redactConfig(cfg) });
    } catch (e) {
      next(e);
    }
  });

  app.delete('/config/providers/:id', async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!cfg.providers[id]) {
        res.status(404).json({ error: `provider "${id}" not found` });
        return;
      }
      delete cfg.providers[id];
      if (cfg.activeProvider === id) cfg.activeProvider = null;
      await saveConfig(cfg);
      orchestrator = makeOrchestrator();
      res.json({ ok: true, aiConfigured: orchestrator !== null, config: redactConfig(cfg) });
    } catch (e) {
      next(e);
    }
  });

  const Activate = z.object({ id: z.string().min(1) });

  app.post('/config/activate', async (req, res, next) => {
    try {
      const { id } = Activate.parse(req.body);
      if (!cfg.providers[id]) {
        res.status(404).json({ error: `provider "${id}" not found` });
        return;
      }
      cfg.activeProvider = id;
      await saveConfig(cfg);
      orchestrator = makeOrchestrator();
      res.json({ ok: true, aiConfigured: orchestrator !== null, config: redactConfig(cfg) });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Provider smoke test (AGENTS.md requirement). Sends a one-token "ping" prompt
   * to the named provider — or the active one if `providerId` is omitted — and
   * reports `{ ok, latencyMs, model }` or a structured `{ ok:false, error }`.
   *
   * Notes:
   *  - Always responds 200 with a Zod-validated `ConfigTestResult`. The HTTP
   *    status mirrors HTTP success; failure is reported in the body so the UI
   *    can render a toast without dealing with two separate error channels.
   *  - Never echoes the API key. The `provider` config object never leaves
   *    this handler.
   *  - 10s timeout per provider call. CLI backends spawn a subprocess that
   *    can hang on auth flows; the timeout keeps the UI snappy.
   */
  app.post('/config/test', async (req, res) => {
    const body = z
      .object({ providerId: z.string().min(1).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) {
      const result: ConfigTestResultT = {
        ok: false,
        error: {
          code: 'provider_error',
          message: 'Invalid request body',
          hint: 'Send `{}` or `{ providerId: "<id>" }`.',
        },
      };
      res.json(ConfigTestResult.parse(result));
      return;
    }

    const providerId = body.data.providerId ?? cfg.activeProvider ?? undefined;
    if (!providerId) {
      const result: ConfigTestResultT = {
        ok: false,
        error: {
          code: 'no_provider',
          message: 'No provider id given and no active provider configured.',
          hint: 'Add a provider with `regard config` or in Settings, then try again.',
        },
      };
      res.json(ConfigTestResult.parse(result));
      return;
    }

    const provider = cfg.providers[providerId];
    if (!provider) {
      const result: ConfigTestResultT = {
        ok: false,
        providerId,
        error: {
          code: 'unknown_provider',
          message: `Provider "${providerId}" is not configured.`,
          hint: 'Pick a provider that exists in Settings / `regard config show`.',
        },
      };
      res.json(ConfigTestResult.parse(result));
      return;
    }

    const model = provider.kind === 'openai-compatible' ? provider.model : provider.model;
    const TIMEOUT_MS = provider.kind === 'cli' ? 90_000 : 10_000;
    const started = Date.now();
    try {
      const llm = (deps.buildLLMForProvider ?? buildLLM)(provider);
      const out = await Promise.race<string>([
        llm.complete({
          system: 'You are a probe. Reply with the single word OK.',
          user: 'ping',
        }),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT')), TIMEOUT_MS),
        ),
      ]);
      const latencyMs = Date.now() - started;
      if (!out || !out.trim()) {
        const result: ConfigTestResultT = {
          ok: false,
          providerId,
          error: {
            code: 'empty_response',
            message: 'Provider returned an empty response.',
            hint: 'Check that the configured model exists and your key has access to it.',
          },
        };
        res.json(ConfigTestResult.parse(result));
        return;
      }
      const result: ConfigTestResultT = {
        ok: true,
        latencyMs,
        ...(model ? { model } : {}),
        providerId,
      };
      res.json(ConfigTestResult.parse(result));
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const code = raw === 'TIMEOUT' ? 'timeout' : 'provider_error';
      // Defensive scrub: in case a provider stuffs the API key into its error
      // message (some SDKs do), strip anything that looks like a stored key.
      let message = raw === 'TIMEOUT' ? `Provider did not respond within ${TIMEOUT_MS}ms.` : raw;
      if (provider.kind === 'openai-compatible' && provider.apiKey) {
        message = message.split(provider.apiKey).join('***');
      }
      const result: ConfigTestResultT = {
        ok: false,
        providerId,
        error: {
          code,
          message: message.slice(0, 500),
          hint:
            code === 'timeout'
              ? 'Try again, or check your network / provider status.'
              : 'Verify the base URL, model id, and API key in Settings.',
        },
      };
      res.json(ConfigTestResult.parse(result));
    }
  });

  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.error('error:', message);
      res.status(400).json({ error: message });
    },
  );

  return { app, getConfig: () => cfg, emitSentimentUpdate };
}

function makePlanId(symbol: string, index: number): string {
  return `${symbol.toUpperCase()}-${Date.now().toString(36)}-${index + 1}`;
}

/** Default factory used by the entrypoint. */
export function createDefaultApp(
  cfg: AppConfigT,
  auth?: AppDeps['auth'],
): AppHandle {
  return createApp({
    market: new YahooClient(),
    webSearch: new DuckDuckGoSearch(),
    watchlist: new WatchlistStore(),
    briefings: new BriefingStore(),
    initialConfig: cfg,
    liveQuoteSource: async (symbol) => {
      // yahoo-finance2 is a direct server dep; import dynamically so test
      // suites that don't exercise the live-quote endpoint don't pay the
      // module-load cost.
      //
      // We use `quoteCombine` instead of `quote` so that bursts of
      // per-symbol requests (every visible ticker in the dashboard polls
      // independently) get batched into a single upstream call. That's the
      // root cause of the Yahoo `HTTP 429 / Too Many Requests` errors we
      // were seeing — each visible row was firing its own
      // `https://query2.finance.yahoo.com/v7/finance/quote?symbols=<SYM>`
      // request, and Yahoo throttles aggressively per client.
      const mod = await import('yahoo-finance2');
      return (await mod.default.quoteCombine(symbol)) as Awaited<
        ReturnType<LiveQuoteSource>
      >;
    },
    llmFromConfig: (c) => {
      try {
        return activeLLM(c);
      } catch (e) {
        logger.warn((e as Error).message);
        return null;
      }
    },
    auth,
  });
}
