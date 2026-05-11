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
    briefing <SYMBOL>          Generate an AI briefing for a ticker
    quote <SYMBOL>             Quick quote
    plan <SYMBOL>              Interactive options trade-plan wizard
    config [show]              Configure AI providers, risk caps, server
    dashboard                  Open the local web dashboard

  Options
    --server <url>             Override server URL (default http://127.0.0.1:4317)

  Examples
    $ regard config
    $ regard briefing NVDA
    $ regard plan TSLA
`,
  {
    importMeta: import.meta,
    flags: {
      server: { type: 'string', default: 'http://127.0.0.1:4317' },
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
  />,
);
