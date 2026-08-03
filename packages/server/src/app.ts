import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { logger } from './logging.js';
import {
  Orchestrator,
  Technician,
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
  MarketClock,
  type WebSearch,
  type LLM,
  type AppConfig as AppConfigT,
  type AiProvider as AiProviderT,
  type WatchlistEntry,
  type ValidationResult,
  type MarketDataClient,
  type LiveQuote,
  type BriefingStorePort,
} from '@regardedtrader/core';
import { liveQuote, type LiveQuoteSource, type YahooQuoteLike } from './liveQuote.js';
import { isLoopbackOrigin } from './bind-guard.js';
import { SERVER_VERSION } from './version.js';

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
}

export interface AppHandle {
  app: express.Express;
  /** Currently-active config (mutated by /config endpoints). Read for tests. */
  getConfig: () => AppConfigT;
}

/**
 * Build the Express app with injected dependencies. The production entrypoint
 * (`index.ts`) wires defaults; tests pass mocks.
 */
export function createApp(deps: AppDeps): AppHandle {
  let cfg: AppConfigT = deps.initialConfig;
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
      // Wire the Technician agent (issue #74) by default so /briefing
      // includes a TA section whenever an LLM is configured.
      { technician: new Technician(llm) },
      { briefings },
    );
  }

  let orchestrator = makeOrchestrator();

  function makeValidator(): TickerValidator | null {
    const llm = deps.llmFromConfig(cfg);
    if (!llm) return null;
    return new TickerValidator({ webSearch: deps.webSearch, llm });
  }

  // Process start timestamp for `GET /version` (issue #179). Captured once
  // at app creation so consumers can spot silent restarts.
  const startedAt = new Date().toISOString();

  const app = express();
  app.use(express.json({ limit: '1mb' }));
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
    cors({ origin: [/^http:\/\/127\.0\.0\.1:\d+$/, /^http:\/\/localhost:\d+$/, /^http:\/\/\[::1\]:\d+$/] }),
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
    });
  });

  // --- Market data ---

  app.get('/quote/:symbol', async (req, res, next) => {
    try {
      const symbol = Ticker.parse(req.params.symbol.toUpperCase());
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
        const symbol = Ticker.parse(req.params.symbol.toUpperCase());
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
      const symbol = Ticker.parse(req.params.symbol.toUpperCase());
      const days = Math.min(Number(req.query.days ?? 180), 365 * 5);
      res.json(await registry.client.history(symbol, days));
    } catch (e) {
      next(e);
    }
  });

  app.get('/options/:symbol', async (req, res, next) => {
    try {
      const symbol = Ticker.parse(req.params.symbol.toUpperCase());
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

  // --- Calendar ---

  // Returns real upcoming market holidays and early closes for the next N days
  // (default 14) derived from the bundled market-calendar.json. This replaces
  // the static SAMPLE_CALENDAR in the web CalendarStrip.
  app.get('/calendar/upcoming', (req, res) => {
    const days = Math.min(Number(req.query.days ?? 14), 90);
    const clock = new MarketClock();
    const cal = clock.getCalendar();

    // Build the set of dates to check (ET dates, YYYY-MM-DD).
    const etFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    const now = new Date();
    const todayEt = (() => {
      const p = etFormatter.formatToParts(now);
      const m: Record<string, string> = {};
      for (const part of p) m[part.type] = part.value;
      return `${m.year}-${m.month}-${m.day}`;
    })();

    const events: Array<{ dateOffset: number; kind: string; title: string }> = [];

    for (let i = 0; i <= days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      const p = etFormatter.formatToParts(d);
      const m: Record<string, string> = {};
      for (const part of p) m[part.type] = part.value;
      const date = `${m.year}-${m.month}-${m.day}`;

      const offset = i; // relative to today (today = 0)

      if (cal.holidays.has(date)) {
        events.push({ dateOffset: offset, kind: 'market_holiday', title: holidayName(date) });
      } else if (cal.earlyCloses.has(date)) {
        const closeTime = cal.earlyCloses.get(date)!;
        events.push({
          dateOffset: offset,
          kind: 'market_early_close',
          title: `Early close ${closeTime} ET`,
        });
      }
    }

    res.json({ today: todayEt, events });
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
      res.json(await o.briefing(symbol));
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
      res.json(await o.briefing(symbol, body));
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
      // Validate the wire payload before emitting (issue #77). Each plan's
      // `notes` carries the canonical disclaimer via `attachRiskGraph`; this
      // .parse() defends against future refactors that might drop it.
      res.json(PlansResponse.parse(out));
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
    const probeSymbol = typeof req.body?.symbol === 'string' ? req.body.symbol.toUpperCase() : 'AAPL';
    const source = resolveLiveQuoteSource();
    if (!source) {
      res.status(503).json({ ok: false, error: 'No market-data provider configured' });
      return;
    }
    try {
      const raw = (await source(probeSymbol)) as YahooQuoteLike;
      res.json({
        ok: true,
        provider: registry.activeId,
        symbol: probeSymbol,
        price: raw.regularMarketPrice ?? null,
      });
    } catch (e) {
      res.status(502).json({ ok: false, error: (e as Error).message });
    }
  });

  const ProviderUpsert = z.object({ id: z.string().min(1), provider: AiProvider });

  app.post('/config/providers', async (req, res, next) => {
    try {
      const { id, provider } = ProviderUpsert.parse(req.body);
      cfg.providers[id] = provider;
      if (!cfg.activeProvider) cfg.activeProvider = id;
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
    const TIMEOUT_MS = 10_000;
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

  return { app, getConfig: () => cfg };
}

/** Maps well-known NYSE holiday dates (YYYY-MM-DD) to human-readable names. */
function holidayName(date: string): string {
  // month-day suffix for recurring holidays
  const md = date.slice(5); // MM-DD
  // Fixed-date holidays
  const fixed: Record<string, string> = {
    '01-01': "New Year's Day — markets closed",
    '06-19': 'Juneteenth — markets closed',
    '12-25': 'Christmas Day — markets closed',
  };
  if (fixed[md]) return fixed[md];
  // Variable holidays — use a small lookup of known dates
  const known: Record<string, string> = {
    '2025-01-09': 'National Day of Mourning — markets closed',
    '2025-01-20': "Martin Luther King Jr. Day — markets closed",
    '2025-02-17': "Presidents' Day — markets closed",
    '2025-04-18': 'Good Friday — markets closed',
    '2025-05-26': 'Memorial Day — markets closed',
    '2025-09-01': 'Labor Day — markets closed',
    '2025-11-27': 'Thanksgiving Day — markets closed',
    '2026-01-19': "Martin Luther King Jr. Day — markets closed",
    '2026-02-16': "Presidents' Day — markets closed",
    '2026-04-03': 'Good Friday — markets closed',
    '2026-05-25': 'Memorial Day — markets closed',
    '2026-09-07': 'Labor Day — markets closed',
    '2026-11-26': 'Thanksgiving Day — markets closed',
    '2027-01-18': "Martin Luther King Jr. Day — markets closed",
    '2027-02-15': "Presidents' Day — markets closed",
    '2027-04-02': 'Good Friday — markets closed',
    '2027-05-31': 'Memorial Day — markets closed',
    '2027-09-06': 'Labor Day — markets closed',
    '2027-11-25': 'Thanksgiving Day — markets closed',
    '2027-12-24': 'Christmas Eve (observed) — markets closed',
    '2026-07-03': 'Independence Day (observed) — markets closed',
    '2027-07-05': 'Independence Day (observed) — markets closed',
  };
  return known[date] ?? `Market holiday — markets closed`;
}

/** Default factory used by the entrypoint. */
export function createDefaultApp(cfg: AppConfigT): AppHandle {
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
  });
}
