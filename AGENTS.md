# AGENTS.md — RegardedTrader

> Rules and context for AI coding agents (and humans) working on this repo.

## What This Is

**RegardedTrader** is a **local-only** desktop assistant that helps a single user do
**company stock analysis** and **day-trading of stock options** with AI in the loop.

It is **not** a SaaS, **not** multi-tenant, and **not** an automated trader. It is a
**personal research/analysis portal** that runs on the user's own machine, reads
public market data, and uses OpenAI (or another LLM) to reason about it.

Two front-ends share one local backend:

1. **Ink CLI** — fast terminal UI built with [`ink`](https://github.com/vadimdemedes/ink),
   inspired by tools like OpenClaw / Claude Code. Primary daily-driver surface.
2. **React Web Dashboard** — Vite + React + Tailwind, served from the same local
   Node server. For charts, watchlists, options chains, and richer visualizations.

Both talk to the same in-process **core** library, so analysis logic lives in one
place and never diverges between surfaces.

## Architecture

```
RegardedTrader/
├── packages/
│   ├── core/      # Pure TS: AI agents, analyzers, market-data clients, types
│   ├── server/    # Express HTTP + WebSocket API, OpenAI bridge, local persistence
│   ├── cli/       # Ink-based CLI; spawns or attaches to the local server
│   └── web/       # Vite + React dashboard (served by `server` in prod, dev via Vite)
└── AGENTS.md      # This file
```

### Data flow

```
 ┌────────────┐        ┌─────────────┐        ┌──────────────┐
 │  Ink CLI   │──HTTP──▶│   server    │──fn────▶│     core     │
 │  (ink)     │◀──WS───│ (express)   │◀────────│ (agents, ta) │
 └────────────┘        └─────────────┘        └──────────────┘
        ▲                     ▲                      │
        │                     │                      │
        └─── React web ───────┘                      ▼
                                              ┌──────────────┐
                                              │ OpenAI / LLM │
                                              │ Market data  │
                                              └──────────────┘
```

- **`core`** has zero I/O frameworks. It exposes functions and agent classes.
- **`server`** is the *only* place that touches the OpenAI key, secrets, and disk.
- **`cli`** and **`web`** are pure clients. They never read `.env` or call OpenAI
  directly.

## Hard Rules for Agents

These are non-negotiable. Violating them is a bug, not a tradeoff.

1. **Local-only.** No code that listens on `0.0.0.0`, no cloud deploy targets, no
   telemetry. Default bind is `127.0.0.1`. CORS is locked to localhost.
2. **No autonomous trading.** This project must never place real orders. Any
   "execute" code path must be a clearly-labeled **paper/simulation** primitive,
   refuse to run against real brokerage credentials, and require an explicit
   `--paper` flag plus a typed confirmation.
3. **No secrets in the repo.** Real keys belong in `.env` (gitignored). Use
   `.env.example` for the schema. The server is the only consumer.
4. **Not financial advice.** Every user-facing surface that emits an LLM opinion
   must include a "not financial advice / educational" disclaimer.
5. **Deterministic core.** `core` functions should be pure where possible and unit
   testable without network. Network calls live behind injected clients.
6. **Single source of truth.** Any analyzer, prompt, or schema used by both CLI
   and web lives in `core`. Do not duplicate logic across surfaces.
7. **Stay local-first on storage.** SQLite (better-sqlite3) or flat JSON under
   `~/.regardedtrader/`. No external databases.
8. **No scraping ToS violations.** Use official/free APIs (Yahoo Finance via
   `yahoo-finance2`, Alpha Vantage, Polygon free tier, etc.). Cache aggressively.
9. **Type-safe wire format.** All server <-> client payloads have Zod schemas in
   `core/src/schemas/`. Both sides import the same schema.
10. **No `any` in new TypeScript code** unless commented with a justification.

## Soft Rules / Style

- TypeScript everywhere, ESM (`"type": "module"`).
- Node >= 20.
- Prettier defaults, no bikeshedding.
- Tests with `vitest`. Co-locate as `*.test.ts`.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`).
- Small PRs > big PRs. One feature per branch.
- Prefer composition over class hierarchies in `core`.
- React: function components + hooks. Tailwind for styling. No CSS-in-JS.
- Ink: keep components small; route screens through a `Router` component.

## Domain Notes

### "Stock analysis" means
- Pull recent OHLCV, fundamentals snapshot, news headlines.
- Compute classic TA (RSI, MACD, SMA/EMA crossovers, ATR, IV when available).
- Ask the LLM to summarize bull/bear theses, catalysts, risks. Always cite which
  inputs it used.

### "Day-trading options" means
- Pull the options chain for a ticker for a given expiration.
- Surface useful metrics: bid/ask spread, OI, volume, IV, delta/gamma/theta/vega
  when broker data provides them; otherwise compute with Black-Scholes.
- Let the user describe an idea ("bullish $NVDA into earnings, defined risk, <$500
  max loss"); the **OptionsStrategist** agent proposes 2-3 candidate structures
  (long call, vertical, calendar, etc.) with break-evens and P/L at expiry.
- Never auto-place. Output is a *trade plan*, not an order.

### Agents (in `core/src/agents/`)
- `Analyst` — high-level company/ticker brief.
- `Technician` — chart-pattern / indicator commentary.
- `OptionsStrategist` — structures + risk graph data.
- `NewsScout` — fetches and ranks headlines for relevance.
- `RiskOfficer` — sanity-checks any proposed trade against user-configured caps
  (max % of account, max DTE, no naked shorts on margin, etc.).

All agents implement a small `Agent` interface and are composed by a top-level
`Orchestrator` so the CLI and web can both invoke "Give me a full briefing on
TICKER" with one call.

## Commands

From the repo root:

```bash
npm install              # installs all workspaces
npm run dev              # starts server + web (concurrent)
npm run dev:server       # server only
npm run dev:web          # web only (Vite)
npm run cli -- briefing NVDA   # run the Ink CLI
npm run build            # builds all packages
npm test                 # runs vitest across workspaces
npm run lint             # tsc --noEmit + prettier --check
```

## When You're An Agent Working Here

- Read this file first. Then read `packages/<pkg>/README.md` for the area you
  touch.
- Prefer adding to `core` over duplicating logic in `cli` or `web`.
- New external API? Wrap it in `core/src/clients/` with an interface. No raw
  `fetch` in `server` route handlers.
- New LLM prompt? Put it in `core/src/prompts/` as a named exported template.
  Never inline a multi-paragraph prompt in a route file.
- Adding a CLI screen? Add a route in `cli/src/router.tsx` and a component under
  `cli/src/screens/`.
- Adding a web view? Add a route under `web/src/routes/` and a matching server
  endpoint if needed.
- Before finishing: `npm run lint && npm test && npm run build`.

## Out of Scope (for now)

- Mobile apps.
- Multi-user / accounts / auth (it's a local single-user app).
- Real brokerage integrations beyond read-only paper.
- Backtesting framework (maybe later, keep `core` friendly to it).
- Crypto. This is equities + equity options.

---

_Not financial advice. Educational tool. You are responsible for your own trades._
