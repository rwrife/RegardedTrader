#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { App } from './app.js';
import { Shell } from './shell.js';

const cli = meow(
  `
  Usage
    $ regard                   Launch interactive slash-command shell
    $ regard <command> [args]  Run a single action and exit

  Commands
    add <SYM>...               Validate ticker(s) via web search + LLM and add to watchlist
    ls                         List validated tickers
    rm <SYM>                   Remove a ticker from the watchlist
    watch <ls|add|rm> [SYM...] Managed watchlist surface (parity twin of /watchlist)
    briefing <SYMBOL>          Generate an AI briefing for a ticker
    brief <SYMBOL>             Full briefing pipeline (analyst + TA + news + strategist)
    quote <SYMBOL>             Quick quote
    tech <SYMBOL>              Technician (TA) commentary for a ticker
    plan <SYMBOL>              Interactive options trade-plan wizard
    options <SYMBOL>           Options-chain explorer (calls/puts/greeks)
    config [show|test [id]]    Configure AI providers, risk caps, server
    dashboard                  Open the local web dashboard

  Options
    --server <url>             Override server URL (default http://127.0.0.1:4317)
    --refresh                  (add) Force re-validation, bypassing 7-day cache
    --thesis <text>            (brief) Trade thesis to run strategist arm
    --max-loss <usd>           (brief) Max-loss budget in USD for strategist
    --expiry <YYYY-MM-DD>      (brief/options) Target option expiry

  Examples
    $ regard
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
      thesis: { type: 'string' },
      maxLoss: { type: 'number' },
      expiry: { type: 'string' },
      help: { type: 'boolean', shortFlag: 'h' },
    },
  },
);

const [command, ...args] = cli.input;

if (cli.flags.help) {
  cli.showHelp(0);
}

if (!command) {
  render(<Shell serverUrl={cli.flags.server} />);
} else {
  render(
    <App
      command={command}
      args={args}
      serverUrl={cli.flags.server}
      flags={{
        refresh: cli.flags.refresh,
        thesis: cli.flags.thesis,
        maxLoss: cli.flags.maxLoss,
        expiry: cli.flags.expiry,
      }}
    />,
  );
}
