import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import {
  Orchestrator,
  YahooClient,
  Ticker,
  loadConfig,
  saveConfig,
  redactConfig,
  activeLLM,
  AppConfig,
  AiProvider,
} from '@regardedtrader/core';

let cfg = await loadConfig();

if (cfg.server.host !== '127.0.0.1' && cfg.server.host !== 'localhost') {
  console.error(`Refusing to bind to non-local host. RegardedTrader is local-only.`);
  process.exit(1);
}

const market = new YahooClient();

function makeOrchestrator(): Orchestrator | null {
  try {
    return new Orchestrator(market, activeLLM(cfg), {
      maxLossUsd: cfg.risk.maxLossUsd,
      maxLegs: cfg.risk.maxLegs,
      forbidNakedShorts: cfg.risk.forbidNakedShorts,
    });
  } catch (e) {
    console.warn('[server]', (e as Error).message);
    return null;
  }
}

let orchestrator = makeOrchestrator();

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
    res.json(await market.quote(symbol));
  } catch (e) {
    next(e);
  }
});

app.get('/history/:symbol', async (req, res, next) => {
  try {
    const symbol = Ticker.parse(req.params.symbol.toUpperCase());
    const days = Math.min(Number(req.query.days ?? 180), 365 * 5);
    res.json(await market.history(symbol, days));
  } catch (e) {
    next(e);
  }
});

app.get('/options/:symbol', async (req, res, next) => {
  try {
    const symbol = Ticker.parse(req.params.symbol.toUpperCase());
    const expiry = typeof req.query.expiry === 'string' ? req.query.expiry : undefined;
    res.json(await market.optionsChain(symbol, expiry));
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

app.get('/briefing/:symbol', async (req, res, next) => {
  try {
    const o = requireOrchestrator(res);
    if (!o) return;
    const symbol = Ticker.parse(req.params.symbol.toUpperCase());
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
    // Cheapest possible smoke test: re-build the LLM and call a 1-token prompt.
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

app.listen(cfg.server.port, cfg.server.host, () => {
  console.log(`RegardedTrader server listening on http://${cfg.server.host}:${cfg.server.port}`);
  if (!orchestrator) {
    console.log('AI is NOT configured. Run `regard config` to set a provider.');
  } else {
    console.log(`Active AI provider: ${cfg.activeProvider}`);
  }
});
