import 'dotenv/config';
import { loadConfig } from '@regardedtrader/core';
import { createDefaultApp } from './app.js';
import { assertLoopbackHost } from './bind-guard.js';

const cfg = await loadConfig();

// Defence-in-depth: validate the bind host at runtime (AGENTS.md rule #1).
// The config layer also enforces this, but env-var overrides or programmatic
// callers could bypass it. We refuse to call `listen` on anything that isn't
// a loopback address.
try {
  await assertLoopbackHost(cfg.server.host);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const { app, getConfig } = createDefaultApp(cfg);

app.listen(cfg.server.port, cfg.server.host, () => {
  const c = getConfig();
  console.log(`RegardedTrader server listening on http://${cfg.server.host}:${cfg.server.port}`);
  if (!c.activeProvider) {
    console.log('AI is NOT configured. Run `regard config` to set a provider.');
  } else {
    console.log(`Active AI provider: ${c.activeProvider}`);
  }
});
