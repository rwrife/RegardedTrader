import 'dotenv/config';
import { loadConfig } from '@regardedtrader/core';
import { createDefaultApp } from './app.js';

const cfg = await loadConfig();

if (cfg.server.host !== '127.0.0.1' && cfg.server.host !== 'localhost') {
  console.error(`Refusing to bind to non-local host. RegardedTrader is local-only.`);
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
