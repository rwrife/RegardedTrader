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
import { liveQuote, type LiveQuoteSource } from './liveQuote.js';

export interface AppDeps {
  market: MarketDataClient;
  webSearch: WebSearch;
  /** Build an LLM from current config; returns null if not configured. */
  llmFromConfig: (cfg: AppConfigT) => LLM | null;
  watchlist: WatchlistStore;
  initialConfig: AppConfigT;
  /**
   * Optional override for the live-quote source. Production wires this to
   * `yahoo-finance2`'s `quote()`; tests inject a mock.
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

  function makeOrchestrator(): Orchestrator | null {
    const llm = deps.llmFromConfig(cfg);
    if (!llm) return null;
    return new Orchestrator(deps.market, llm, {
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
      res.json(await deps.market.quote(symbol));
    } catch (e) {
      next(e);
    }
  });

  // --- Live quote (#81) ---
  // Tiny in-memory cache to coalesce bursts from multiple clients.
  if (deps.liveQuoteSource) {
    const source = deps.liveQuoteSource;
    const cache = new Map<string, { at: number; value: LiveQuote }>();
    const CACHE_TTL_MS = 5_000;
    const now = deps.now ?? Date.now;

    app.get('/tickers/:symbol/quote', async (req, res, next) => {
      try {
        const symbol = Ticker.parse(req.params.symbol.toUpperCase());
        const cached = cache.get(symbol);
        const t = now();
        if (cached && t - cached.at < CACHE_TTL_MS) {
          res.json(cached.value);
          return;
        }
        const fresh = await liveQuote(source, symbol);
        const parsed = QuoteSchema.parse(fresh);
        cache.set(symbol, { at: t, value: parsed });
        res.json(parsed);
      } catch (e) {
        next(e);
      }
    });
  }

  app.get('/history/:symbol', async (req, res, next) => {
    try {
      const symbol = Ticker.parse(req.params.symbol.toUpperCase());
      const days = Math.min(Number(req.query.days ?? 180), 365 * 5);
      res.json(await deps.market.history(symbol, days));
    } catch (e) {
      next(e);
    }
  });

  app.get('/options/:symbol', async (req, res, next) => {
    try {
      const symbol = Ticker.parse(req.params.symbol.toUpperCase());
      const expiry = typeof req.query.expiry === 'string' ? req.query.expiry : undefined;
      res.json(await deps.market.optionsChain(symbol, expiry));
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
      res.json({ ok: true, aiConfigured: orchestrator !== null, config: redactConfig(cfg) });
    } catch (e) {
      next(e);
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
      const mod = await import('yahoo-finance2');
      return (await mod.default.quote(symbol)) as Awaited<
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
