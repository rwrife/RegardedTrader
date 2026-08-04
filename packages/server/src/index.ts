import 'dotenv/config';
import { loadConfig } from '@regardedtrader/core';
import { createDefaultApp } from './app.js';
import { assertLoopbackHost } from './bind-guard.js';
import { logger } from './logging.js';
import { parseRuntimeAuth } from './runtimeAuth.js';
import { attachStreamServer } from './ws.js';

const cfg = await loadConfig();
const envPort = Number(process.env.REGARDEDTRADER_SERVER_PORT ?? '');
if (Number.isFinite(envPort) && envPort > 0) {
  cfg.server.port = envPort;
}

// Defence-in-depth: validate the bind host at runtime (AGENTS.md rule #1).
// The config layer also enforces this, but env-var overrides or programmatic
// callers could bypass it. We refuse to call `listen` on anything that isn't
// a loopback address.
try {
  await assertLoopbackHost(cfg.server.host);
} catch (e) {
  logger.error((e as Error).message);
  process.exit(1);
}

let runtimeAuth;
try {
  runtimeAuth = parseRuntimeAuth();
} catch (e) {
  logger.error((e as Error).message);
  process.exit(1);
}

const { app, getConfig, shutdown, stream } = createDefaultApp(cfg, runtimeAuth);
const server = app.listen(cfg.server.port, cfg.server.host, () => {
  const c = getConfig();
  logger.info(`RegardedTrader server listening on http://${cfg.server.host}:${cfg.server.port}`);
  if (!c.activeProvider) {
    logger.info('AI is NOT configured. Run `regard config` to set a provider.');
  } else {
    logger.info(`Active AI provider: ${c.activeProvider}`);
  }
});
attachStreamServer({
  server,
  bridge: {
    subscribe: stream.subscribe,
    loadChain: stream.loadChain,
  },
  auth: stream.auth,
});

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}. Shutting down...`);

  const hardExit = setTimeout(() => {
    logger.warn('Graceful shutdown timed out.');
    process.exit(1);
  }, 6_000);
  hardExit.unref?.();

  try {
    await shutdown(5_000);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    clearTimeout(hardExit);
    process.exit(0);
  } catch (e) {
    clearTimeout(hardExit);
    logger.error((e as Error).message);
    process.exit(1);
  }
}

process.once('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});
