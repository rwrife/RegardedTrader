# RegardedTrader

[![CI](https://github.com/rwrife/RegardedTrader/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rwrife/RegardedTrader/actions/workflows/ci.yml)

A **local-only** AI-powered portal for company stock analysis and day-trading
options research. Runs entirely on your machine. Choose your surface:

- 🖥️ **Ink CLI** — fast terminal UI (`regard briefing NVDA`)
- 🌐 **Web dashboard** — React + Vite, served from the same local server

**Every feature is available on both surfaces** — the CLI and dashboard are
peers, not a primary + companion. See [`docs/surface-parity.md`](./docs/surface-parity.md).

> ⚠️ **Not financial advice.** Educational/research tool. No live order
> placement. You are responsible for your own trades. See [`docs/disclaimer.md`](./docs/disclaimer.md).

## Quick start

```bash
git clone https://github.com/rwrife/RegardedTrader.git
cd RegardedTrader
npm install
cp .env.example .env       # add your OPENAI_API_KEY
npm run build
npm run cli -- dashboard   # canonical dashboard entrypoint
# or, after `npm link`: regard dashboard
# in another terminal:
npm run cli -- briefing NVDA
```

Node **>= 20** required.

## Ticker intake & watchlist (M1)

Before running briefings/plans, add symbols to the validated watchlist:

```bash
# CLI
regard add NVDA AAPL
regard add NVDA --refresh        # force fresh validation
regard ls
regard rm NVDA
```

Web parity: the home view and `/watchlist` route call the same local endpoints
(`GET /tickers`, `POST /tickers`, `POST /tickers/validate`, `DELETE /tickers/:sym`,
`GET /tickers/resolve`) and show the same canonical ticker profile fields.

## What it does

- Pulls public market data (Yahoo Finance, optionally Polygon/Alpha Vantage).
- Computes technical indicators (RSI, MACD, SMA/EMA, ATR, IV).
- Runs an orchestrated set of AI agents — `Analyst`, `Technician`,
  `OptionsStrategist`, `NewsScout`, `RiskOfficer` — to produce a briefing or a
  proposed options trade structure with break-evens and P/L at expiry.
- Renders results in either an Ink TUI or a React dashboard.

## Architecture

```
packages/
  core/    ← agents, analyzers, prompts, schemas, clients  (pure TS, testable)
  server/  ← Express + WebSocket, OpenAI bridge, SQLite cache
  cli/     ← Ink-based terminal UI
  web/     ← Vite + React + Tailwind dashboard
```

See [`AGENTS.md`](./AGENTS.md) for the full project rules, domain notes, and
guidance for AI coding agents working on this repo. For terminology, use the
canonical [`docs/domain-glossary.md`](./docs/domain-glossary.md).

## Scripts

| command                | does                                            |
| ---------------------- | ----------------------------------------------- |
| `npm run dev`          | contributor mode (unauthenticated dev servers)  |
| `npm run dev:server`   | unauthenticated local API (dev-only convenience)|
| `npm run dev:web`      | Vite dashboard dev server                        |
| `npm run cli -- ...`   | run the Ink CLI (installed globally as `regard`)|
| `npm run build`        | build all workspaces                            |
| `npm test`             | vitest across workspaces                        |
| `npm run lint`         | tsc + prettier check                            |

For the security model and token lifecycle used by `regard dashboard`, see
[`docs/security.md`](./docs/security.md).

## License

MIT. Use at your own risk.
