import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import {
  Orchestrator,
  YahooClient,
  Ticker,
  QuoteSchema,
  loadConfig,
  saveConfig,
  redactConfig,
  activeLLM,
  AppConfig,
  AiProvider,
  MarketDataProviderConfig,
  createMarketDataRegistry,
  TickerValidator,
  WatchlistStore,
  DuckDuckGoSearch,
  type WebSearch,
  type LLM,
  type AppConfig as AppConfigT,
  type WatchlistEntry,
  type ValidationResult,
  type MarketDataClient,
  type LiveQuote,
} from '@regardedtrader/core';
import { liveQuote, type LiveQuoteSource, type YahooQuoteLike } from './liveQuote.js';

export interface AppDeps {
  /**
   * Fallback market-data client used when the user hasn't configured a
   * provider. Production wires `YahooClient`; tests inject mocks.
   */
  market: MarketDataClient;
  webSearch: WebSearch;
  /** Build an LLM from current config; returns null if not configured. */
  llmFromConfig: (cfg: AppConfigT) => LLM | null;
  watchlist: WatchlistStore;
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
    return new Orchestrator(registry.client, llm, {
      maxLossUsd: cfg.risk.maxLossUsd,
      maxLegs: cfg.risk.maxLegs,
      forbidNakedShorts: cfg.risk.forbidNakedShorts,
    });
  }

  let orchestrator = makeOrchestrator();

  function makeValidator(): TickerValidator | null {
    const llm = deps.llmFromConfig(cfg);
    if (!llm) return null;
    return new TickerValidator({ webSearch: deps.webSearch, llm });
  }

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    cors({ origin: [/^http:\/\/127\.0\.0\.1:\d+$/, /^http:\/\/localhost:\d+$/] }),
  );

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      name: 'regardedtrader-server',
      version: '0.1.0',
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

  app.post('/tickers/validate', async (req, res, next) => {
    try {
      const body = ValidateBody.parse(req.body);
      const validator = makeValidator();
      const results: ValidationResult[] = [];

      for (const raw of body.symbols) {
        const symbol = raw.trim().toUpperCase();
        if (!body.refresh) {
          const cached = await deps.watchlist.get(symbol);
          if (cached && !deps.watchlist.isStale(cached)) {
            results.push({ ok: true, profile: cached.profile, cached: true });
            continue;
          }
        }
        if (!validator) {
          res.status(503).json({
            error: 'AI provider not configured',
            hint: 'Run `regard config` (CLI) or open Settings in the dashboard.',
          });
          return;
        }
        const r = await validator.validate(symbol);
        if (r.ok) await deps.watchlist.upsert(r.profile);
        results.push(r);
      }
      res.json({ results });
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

  app.get('/briefing/:symbol', async (req, res, next) => {
    try {
      const o = requireOrchestrator(res);
      if (!o) return;
      const symbol = Ticker.parse(req.params.symbol.toUpperCase());
      const known = await requireKnownSymbol(res, symbol);
      if (!known) return;
      res.json(await o.briefing(symbol));
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
      res.json(await o.proposePlans(body));
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

  // --- Market-data providers (#91) ---

  const MarketProviderUpsert = z.object({
    id: z.string().min(1),
    provider: MarketDataProviderConfig,
  });

  app.post('/config/market-data/providers', async (req, res, next) => {
    try {
      const { id, provider } = MarketProviderUpsert.parse(req.body);
      cfg.marketData.providers[id] = provider;
      if (!cfg.marketData.activeProvider) cfg.marketData.activeProvider = id;
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

  app.post('/config/test', async (_req, res) => {
    if (!orchestrator) {
      res.status(503).json({ ok: false, error: 'No active provider' });
      return;
    }
    try {
      const llm = activeLLM(cfg);
      const out = await llm.complete({
        system: 'You are a probe. Reply with the single word OK.',
        user: 'ping',
      });
      res.json({ ok: true, sample: out.slice(0, 200) });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error('[server] error:', message);
      res.status(400).json({ error: message });
    },
  );

  return { app, getConfig: () => cfg };
}

/** Default factory used by the entrypoint. */
export function createDefaultApp(cfg: AppConfigT): AppHandle {
  return createApp({
    market: new YahooClient(),
    webSearch: new DuckDuckGoSearch(),
    watchlist: new WatchlistStore(),
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
        console.warn('[server]', (e as Error).message);
        return null;
      }
    },
  });
}
