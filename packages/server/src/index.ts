import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import { z } from 'zod';
import { Orchestrator, YahooClient, OpenAILLM, Ticker } from '@regardedtrader/core';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4317);

if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
  console.error(`Refusing to bind to non-local host "${HOST}". RegardedTrader is local-only.`);
  process.exit(1);
}

const openaiKey = process.env.OPENAI_API_KEY;
if (!openaiKey) {
  console.warn('[server] OPENAI_API_KEY not set — LLM endpoints will fail until you set it.');
}

const llm = new OpenAILLM(
  new OpenAI({ apiKey: openaiKey ?? 'missing' }),
  process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
);

const market = new YahooClient();
const orchestrator = new Orchestrator(market, llm);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin: [/^http:\/\/127\.0\.0\.1:\d+$/, /^http:\/\/localhost:\d+$/],
  }),
);

app.get('/health', (_req, res) => {
  res.json({ ok: true, name: 'regardedtrader-server', version: '0.1.0' });
});

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

app.get('/briefing/:symbol', async (req, res, next) => {
  try {
    const symbol = Ticker.parse(req.params.symbol.toUpperCase());
    res.json(await orchestrator.briefing(symbol));
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
    const body = PlansReq.parse({ ...req.body, symbol: String(req.body.symbol).toUpperCase() });
    res.json(await orchestrator.proposePlans(body));
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

app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error('[server] error:', message);
    res.status(400).json({ error: message });
  },
);

app.listen(PORT, HOST, () => {
  console.log(`RegardedTrader server listening on http://${HOST}:${PORT}`);
});
