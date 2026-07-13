# RegardedTrader

[![CI](https://github.com/rwrife/RegardedTrader/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rwrife/RegardedTrader/actions/workflows/ci.yml)

A **local-only** AI-powered portal for company stock analysis and day-trading
options research. Runs entirely on your machine. Choose your surface:

- 🖥️ **Ink CLI** — fast terminal UI (`regard briefing NVDA`)
- 🌐 **Web dashboard** — React + Vite, served from the same local server

**Every feature is available on both surfaces** — the CLI and dashboard are
peers, not a primary + companion. See [`docs/surface-parity.md`](./docs/surface-parity.md).

> ⚠️ **Not financial advice.** Educational/research tool. No live order
> placement. You are responsible for your own trades.

## Quick start

```bash
git clone https://github.com/rwrife/RegardedTrader.git
cd RegardedTrader
npm install
cp .env.example .env       # add your OPENAI_API_KEY
npm run dev                # server + web dashboard at http://127.0.0.1:5173
# in another terminal:
npm run cli -- briefing NVDA   # or, after `npm link`: `regard briefing NVDA`
```

Node **>= 20** required.

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
guidance for AI coding agents working on this repo.

## Scripts

| command                | does                                            |
| ---------------------- | ----------------------------------------------- |
| `npm run dev`          | server + web concurrently                       |
| `npm run dev:server`   | local API at `http://127.0.0.1:4317`            |
| `npm run dev:web`      | Vite dashboard at `http://127.0.0.1:5173`       |
| `npm run cli -- ...`   | run the Ink CLI (installed globally as `regard`)|
| `npm run build`        | build all workspaces                            |
| `npm test`             | vitest across workspaces                        |
| `npm run lint`         | tsc + prettier check                            |

## License

MIT. Use at your own risk.
