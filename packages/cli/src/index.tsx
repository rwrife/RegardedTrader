#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { App } from './app.js';
import { Shell } from './shell.js';
import { runDashboardCommand } from './dashboard-command.js';

const cli = meow(
  `
  Usage
    $ regard                   Launch interactive slash-command shell
    $ regard <command> [args]  Run a single action and exit

  Commands
    add <SYM>...               Validate ticker(s) via web search + LLM and add to watchlist
    ls                         List validated tickers
    rm <SYM>                   Remove a ticker from the watchlist
    watch [SYMBOL...]          Open live tape stream (SSE): last/Δ/Δ%/RSI/headline
    tail <SYMBOL>              Follow per-symbol news line-by-line (tail -F style)
    polling <status|pause|resume> Polling subsystem controls
    paper <submit|orders|positions> Simulated paper-trading surface (no live orders)
    cal [--from=today] [--days=14]  Tiny calendar with holidays + watchlist earnings
    cal earnings <SYM> [--past] [--upcoming]  Per-symbol earnings table
    cal refresh [--holidays] [--earnings]     Force out-of-cycle calendar refresh
    cal status                   Calendar source health + market state
    briefing <SYMBOL>          Generate an AI briefing for a ticker
    brief <SYMBOL>             Full briefing pipeline (analyst + TA + news + strategist)
    quote <SYMBOL>             Quick quote
    tech <SYMBOL>              Technician (TA) commentary for a ticker
    news <SYMBOL>              Ranked traditional headlines via NewsScout
    sentiment <SYMBOL>         Sentiment snapshot summary (score/confidence/volume/by-source)
    mentions <SYMBOL>          Recent source mentions for a symbol (no usernames)
    plan <SYMBOL>              Interactive options trade-plan wizard
    options <SYMBOL>           Options-chain explorer (calls/puts/greeks)
    chart <SYMBOL>             ASCII sparkline + RSI/MACD indicator readout
    config [show|test [id]]    Configure AI providers, risk caps, server
    dashboard                  Open the local web dashboard

  Options
    --server <url>             Override server URL (default http://127.0.0.1:4317)
    --refresh                  (add) Force re-validation, bypassing 7-day cache
    --thesis <text>            (brief) Trade thesis to run strategist arm
    --max-loss <usd>           (brief) Max-loss budget in USD for strategist
    --expiry <YYYY-MM-DD>      (brief/options) Target option expiry
    --paper                    (paper submit) Required safety flag for simulated execution
    --from <YYYY-MM-DD|today>  (cal) Start date in ET (default today)
    --days <N>                 (cal) Calendar window length (default 14, max 90)
    --past                     (cal earnings) Include past earnings events
    --upcoming                 (cal earnings) Include upcoming earnings events (default)
    --holidays                 (cal refresh) Refresh holidays source set
    --earnings                 (cal refresh) Refresh earnings source set
    --quotes                   (tail) Include quote ticks in the tail stream
    --print-url                (dashboard) Print URL and do not open browser
    --no-open                  (dashboard) Skip auto-open and print URL
    --port <n>                 (dashboard) Dashboard web port (default 5173)
    --force                    (dashboard) Replace running dashboard session
    --window <duration>        (sentiment) Sentiment history window (e.g. 30m, 4h, 1d)
    --watch                    (sentiment) Watch sentiment updates over SSE
    --source <name>            (mentions) Filter source (reddit|stocktwits|hn|cnn|google-news|googleNewsOpinion)
    --limit <n>                (mentions) Max mentions to return (default 100)

  Examples
    $ regard
    $ regard add NVDA AAPL
    $ regard ls
    $ regard rm NVDA
    $ regard config
    $ regard briefing NVDA
    $ regard chart NVDA
    $ regard sentiment NVDA --window=30m
    $ regard mentions NVDA --source=reddit --limit=50
`,
  {
    importMeta: import.meta,
    flags: {
      server: { type: 'string', default: 'http://127.0.0.1:4317' },
      refresh: { type: 'boolean', default: false },
      thesis: { type: 'string' },
      maxLoss: { type: 'number' },
      expiry: { type: 'string' },
      paper: { type: 'boolean', default: false },
      from: { type: 'string', default: 'today' },
      days: { type: 'number', default: 14 },
      past: { type: 'boolean', default: false },
      upcoming: { type: 'boolean', default: false },
      holidays: { type: 'boolean', default: false },
      earnings: { type: 'boolean', default: false },
      quotes: { type: 'boolean', default: false },
      printUrl: { type: 'boolean', default: false },
      noOpen: { type: 'boolean', default: false },
      port: { type: 'number', default: 5173 },
      force: { type: 'boolean', default: false },
      window: { type: 'string' },
      watch: { type: 'boolean', default: false },
      source: { type: 'string' },
      limit: { type: 'number' },
      help: { type: 'boolean', shortFlag: 'h' },
    },
  },
);

const [command, ...args] = cli.input;

if (cli.flags.help) {
  cli.showHelp(0);
}

if (command === 'dashboard') {
  runDashboardCommand({
    serverUrl: cli.flags.server,
    port: cli.flags.port,
    noOpen: cli.flags.noOpen,
    printUrl: cli.flags.printUrl,
    force: cli.flags.force,
  })
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error((err as Error).message);
      process.exit(1);
    });
} else if (!command) {
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
        paper: cli.flags.paper,
        from: cli.flags.from,
        days: cli.flags.days,
        past: cli.flags.past,
        upcoming: cli.flags.upcoming,
        holidays: cli.flags.holidays,
        earnings: cli.flags.earnings,
        quotes: cli.flags.quotes,
        window: cli.flags.window,
        watch: cli.flags.watch,
        source: cli.flags.source,
        limit: cli.flags.limit,
      }}
    />,
  );
}
