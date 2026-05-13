#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { App } from './app.js';

const cli = meow(
  `
  Usage
    $ regard <command> [args]

  Commands
    add <SYM>...               Validate ticker(s) via web search + LLM and add to watchlist
    ls                         List validated tickers
    rm <SYM>                   Remove a ticker from the watchlist
    briefing <SYMBOL>          Generate an AI briefing for a ticker
    quote <SYMBOL>             Quick quote
    plan <SYMBOL>              Interactive options trade-plan wizard
    config [show]              Configure AI providers, risk caps, server
    dashboard                  Open the local web dashboard

  Options
    --server <url>             Override server URL (default http://127.0.0.1:4317)
    --refresh                  (add) Force re-validation, bypassing 7-day cache

  Examples
    $ regard add NVDA AAPL
    $ regard ls
    $ regard rm NVDA
    $ regard config
    $ regard briefing NVDA
`,
  {
    importMeta: import.meta,
    flags: {
      server: { type: 'string', default: 'http://127.0.0.1:4317' },
      refresh: { type: 'boolean', default: false },
    },
  },
);

const [command, ...args] = cli.input;

if (!command) {
  cli.showHelp(0);
}

render(
  <App
    command={command ?? 'help'}
    args={args}
    serverUrl={cli.flags.server}
    flags={{ refresh: cli.flags.refresh }}
  />,
);
